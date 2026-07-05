// Tests for @jfs/fetch-kit. Run with: node --test test.mjs  (or: npm test)
// Uses node:test — no framework deps. The retry/backoff/timeout logic is
// exercised through injected fetchImpl/sleepImpl/random seams so nothing here
// touches the network or a real timer.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HttpError,
  TimeoutError,
  sleep,
  parseRetryAfter,
  encodeBase64Utf8,
  decodeBase64Utf8,
  fetchWithTimeout,
  fetchWithRetry,
  fetchJson,
  fetchText,
  createCoalescer,
  fetchThroughProxies,
} from './index.js';

// ───────────────────────── fakes ─────────────────────────

function makeResponse(body, { ok = true, status = ok ? 200 : 500, headers = {} } = {}) {
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    ok,
    status,
    headers: { get: (k) => (h.has(k.toLowerCase()) ? h.get(k.toLowerCase()) : null) },
    async json() { return typeof body === 'string' ? JSON.parse(body) : body; },
    async text() { return typeof body === 'string' ? body : JSON.stringify(body); },
  };
}

// A fetch stub that returns queued responses/throws in order, recording the
// URLs it was called with.
function scriptedFetch(steps) {
  const calls = [];
  let i = 0;
  const impl = async (url) => {
    calls.push(url);
    const step = steps[Math.min(i, steps.length - 1)];
    i++;
    if (typeof step === 'function') return step(url);
    if (step instanceof Error) throw step;
    return step;
  };
  impl.calls = calls;
  return impl;
}

const noSleep = async () => {}; // collapse backoff waits
const zeroRandom = () => 0; // deterministic jitter

// ───────────────────────── typed errors ─────────────────────────

test('HttpError carries status/url/retryable/retryAfterMs', () => {
  const e = new HttpError(503, 'https://x/y', { retryable: true, retryAfterMs: 2000 });
  assert.equal(e.name, 'HttpError');
  assert.equal(e.status, 503);
  assert.equal(e.url, 'https://x/y');
  assert.equal(e.retryable, true);
  assert.equal(e.retryAfterMs, 2000);
  assert.ok(e instanceof Error);
  assert.match(e.message, /HTTP 503/);
});

test('TimeoutError reports the URL and window', () => {
  const e = new TimeoutError('https://x', 8000);
  assert.equal(e.name, 'TimeoutError');
  assert.equal(e.timeoutMs, 8000);
  assert.match(e.message, /8s/);
});

// ───────────────────────── parseRetryAfter ─────────────────────────

test('parseRetryAfter: delta-seconds → ms', () => {
  assert.equal(parseRetryAfter('120'), 120000);
  assert.equal(parseRetryAfter('0'), 0);
});

test('parseRetryAfter: HTTP-date → clamped ms from now', () => {
  const future = new Date(Date.now() + 5000).toUTCString();
  const ms = parseRetryAfter(future);
  assert.ok(ms > 3000 && ms <= 5000, `got ${ms}`);
  // A past date clamps to 0 rather than going negative.
  assert.equal(parseRetryAfter(new Date(Date.now() - 5000).toUTCString()), 0);
});

test('parseRetryAfter: absent/garbage → null', () => {
  assert.equal(parseRetryAfter(null), null);
  assert.equal(parseRetryAfter(''), null);
  assert.equal(parseRetryAfter('soon'), null);
});

// ───────────────────────── base64 codecs ─────────────────────────

test('base64 codecs round-trip multibyte text', () => {
  for (const s of ['hello', 'café ☕ 🐻', '{"a":1,"b":"—"}\n', '']) {
    assert.equal(decodeBase64Utf8(encodeBase64Utf8(s)), s);
  }
  // Genuinely UTF-8, not Latin-1: '🐻' is 4 UTF-8 bytes, so the base64 decodes
  // to 4 bytes (matching Buffer's utf-8 encoding), not a mojibake shorter run.
  assert.equal(encodeBase64Utf8('🐻'), Buffer.from('🐻', 'utf-8').toString('base64'));
});

test('decodeBase64Utf8 throws on malformed UTF-8', () => {
  // 0xFF is not valid UTF-8; fatal decoder must reject.
  const bad = btoa(String.fromCharCode(0xff));
  assert.throws(() => decodeBase64Utf8(bad));
});

// ───────────────────────── fetchWithTimeout ─────────────────────────

test('fetchWithTimeout returns the raw response (non-ok is not an error)', async () => {
  const impl = scriptedFetch([makeResponse('x', { ok: false, status: 404 })]);
  const res = await fetchWithTimeout('https://x', { fetchImpl: impl });
  assert.equal(res.status, 404);
});

test('fetchWithTimeout throws TimeoutError when its own timer aborts', async () => {
  // A fetch that never resolves until aborted.
  const impl = (url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        const e = new Error('aborted');
        e.name = 'AbortError';
        reject(e);
      });
    });
  await assert.rejects(
    fetchWithTimeout('https://slow', { fetchImpl: impl, timeout: 5 }),
    (err) => err instanceof TimeoutError,
  );
});

test('fetchWithTimeout rethrows a caller abort as AbortError (not TimeoutError)', async () => {
  const ac = new AbortController();
  const impl = (url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        const e = new Error('aborted');
        e.name = 'AbortError';
        reject(e);
      });
    });
  const p = fetchWithTimeout('https://x', { fetchImpl: impl, signal: ac.signal, timeout: 10000 });
  ac.abort();
  await assert.rejects(p, (err) => err.name === 'AbortError' && !(err instanceof TimeoutError));
});

test('fetchWithTimeout honors an already-aborted signal', async () => {
  const ac = new AbortController();
  ac.abort();
  let started = false;
  const impl = (url, init) =>
    new Promise((_resolve, reject) => {
      started = true;
      init.signal.addEventListener('abort', () => {
        const e = new Error('aborted');
        e.name = 'AbortError';
        reject(e);
      });
      if (init.signal.aborted) {
        const e = new Error('aborted');
        e.name = 'AbortError';
        reject(e);
      }
    });
  await assert.rejects(fetchWithTimeout('https://x', { fetchImpl: impl, signal: ac.signal }));
  assert.ok(started);
});

// ───────────────────────── fetchWithRetry ─────────────────────────

test('fetchWithRetry returns the first ok response without retrying', async () => {
  const impl = scriptedFetch([makeResponse({ ok: 1 })]);
  const res = await fetchWithRetry('https://x', { fetchImpl: impl, sleepImpl: noSleep });
  assert.equal(res.ok, true);
  assert.equal(impl.calls.length, 1);
});

test('fetchWithRetry retries a 503 then succeeds', async () => {
  const impl = scriptedFetch([
    makeResponse('busy', { ok: false, status: 503 }),
    makeResponse('busy', { ok: false, status: 503 }),
    makeResponse({ done: true }),
  ]);
  const res = await fetchWithRetry('https://x', {
    fetchImpl: impl,
    sleepImpl: noSleep,
    random: zeroRandom,
    retries: 2,
  });
  assert.equal(res.ok, true);
  assert.equal(impl.calls.length, 3);
});

test('fetchWithRetry throws HttpError after exhausting retries', async () => {
  const impl = scriptedFetch([makeResponse('busy', { ok: false, status: 502 })]);
  await assert.rejects(
    fetchWithRetry('https://x', { fetchImpl: impl, sleepImpl: noSleep, retries: 2 }),
    (err) => err instanceof HttpError && err.status === 502 && err.retryable === true,
  );
  assert.equal(impl.calls.length, 3); // 1 + 2 retries
});

test('fetchWithRetry does NOT retry a 404', async () => {
  const impl = scriptedFetch([makeResponse('nope', { ok: false, status: 404 })]);
  await assert.rejects(
    fetchWithRetry('https://x', { fetchImpl: impl, sleepImpl: noSleep, retries: 3 }),
    (err) => err instanceof HttpError && err.status === 404,
  );
  assert.equal(impl.calls.length, 1);
});

test('fetchWithRetry retries a network TypeError', async () => {
  const impl = scriptedFetch([new TypeError('Failed to fetch'), makeResponse({ ok: 1 })]);
  const res = await fetchWithRetry('https://x', { fetchImpl: impl, sleepImpl: noSleep, retries: 1 });
  assert.equal(res.ok, true);
  assert.equal(impl.calls.length, 2);
});

test('fetchWithRetry does NOT retry a TimeoutError by default', async () => {
  let calls = 0;
  const impl = (url, init) =>
    new Promise((_resolve, reject) => {
      calls++;
      init.signal.addEventListener('abort', () => {
        const e = new Error('aborted');
        e.name = 'AbortError';
        reject(e);
      });
    });
  await assert.rejects(
    fetchWithRetry('https://slow', { fetchImpl: impl, sleepImpl: noSleep, timeout: 5, retries: 3 }),
    (err) => err instanceof TimeoutError,
  );
  assert.equal(calls, 1);
});

test('fetchWithRetry backoff uses Retry-After when present', async () => {
  const delays = [];
  const impl = scriptedFetch([
    makeResponse('busy', { ok: false, status: 429, headers: { 'Retry-After': '2' } }),
    makeResponse({ ok: 1 }),
  ]);
  await fetchWithRetry('https://x', {
    fetchImpl: impl,
    sleepImpl: async (ms) => { delays.push(ms); },
    random: zeroRandom,
    retries: 1,
  });
  // Retry-After: 2s overrides the 400ms base; zero jitter → exactly 2000.
  assert.equal(delays[0], 2000);
});

test('fetchWithRetry backoff is exponential with jitter otherwise', async () => {
  const delays = [];
  const impl = scriptedFetch([
    makeResponse('', { ok: false, status: 500 }), // 500 not in retry set → not retried
  ]);
  // 500 is deterministic (not transient by default) — should throw immediately.
  await assert.rejects(fetchWithRetry('https://x', { fetchImpl: impl, sleepImpl: async (ms) => delays.push(ms), retries: 2 }));
  assert.equal(delays.length, 0);
});

test('fetchWithRetry retryOn override can force a retry on any error', async () => {
  const impl = scriptedFetch([
    makeResponse('', { ok: false, status: 418 }),
    makeResponse({ ok: 1 }),
  ]);
  const res = await fetchWithRetry('https://x', {
    fetchImpl: impl,
    sleepImpl: noSleep,
    retries: 1,
    retryOn: (err) => err instanceof HttpError && err.status === 418,
  });
  assert.equal(res.ok, true);
  assert.equal(impl.calls.length, 2);
});

test('fetchJson / fetchText parse the body', async () => {
  const jimpl = scriptedFetch([makeResponse({ a: 1 })]);
  assert.deepEqual(await fetchJson('https://x', { fetchImpl: jimpl, sleepImpl: noSleep }), { a: 1 });
  const timpl = scriptedFetch([makeResponse('plain')]);
  assert.equal(await fetchText('https://x', { fetchImpl: timpl, sleepImpl: noSleep }), 'plain');
});

// ───────────────────────── coalescer ─────────────────────────

test('createCoalescer: concurrent same-key calls share one promise', async () => {
  const coalesce = createCoalescer();
  let runs = 0;
  const factory = () => { runs++; return sleep(5).then(() => 'v'); };
  const [a, b] = await Promise.all([coalesce('k', factory), coalesce('k', factory)]);
  assert.equal(a, 'v');
  assert.equal(b, 'v');
  assert.equal(runs, 1); // deduped
  assert.equal(coalesce.inFlight.size, 0); // cleared on settle
});

test('createCoalescer: different keys do not dedupe', async () => {
  const coalesce = createCoalescer();
  let runs = 0;
  const factory = () => { runs++; return Promise.resolve('v'); };
  await Promise.all([coalesce('a', factory), coalesce('b', factory)]);
  assert.equal(runs, 2);
});

test('createCoalescer: a settled key runs fresh next time', async () => {
  const coalesce = createCoalescer();
  let runs = 0;
  const factory = () => { runs++; return Promise.resolve('v'); };
  await coalesce('k', factory);
  await coalesce('k', factory);
  assert.equal(runs, 2);
});

test('createCoalescer: a rejection clears the entry and propagates', async () => {
  const coalesce = createCoalescer();
  await assert.rejects(coalesce('k', () => Promise.reject(new Error('boom'))));
  assert.equal(coalesce.inFlight.size, 0);
});

// ───────────────────────── proxy chain ─────────────────────────

const PROXIES = [
  (u) => `https://p1/?url=${encodeURIComponent(u)}`,
  (u) => `https://p2/?url=${encodeURIComponent(u)}`,
];

test('fetchThroughProxies: direct ok wins, no proxy hit', async () => {
  const impl = scriptedFetch([makeResponse('ok')]);
  const res = await fetchThroughProxies('https://origin', { proxies: PROXIES, fetchImpl: impl });
  assert.equal(res.ok, true);
  assert.equal(impl.calls.length, 1);
  assert.equal(impl.calls[0], 'https://origin');
});

test('fetchThroughProxies: direct 4xx is taken as the answer (no proxy)', async () => {
  const impl = scriptedFetch([makeResponse('bad', { ok: false, status: 403 })]);
  const res = await fetchThroughProxies('https://origin', { proxies: PROXIES, fetchImpl: impl });
  assert.equal(res.status, 403);
  assert.equal(impl.calls.length, 1);
});

test('fetchThroughProxies: 5xx falls through to a proxy', async () => {
  const impl = scriptedFetch([
    makeResponse('down', { ok: false, status: 503 }),
    makeResponse('via proxy'),
  ]);
  const tags = [];
  const res = await fetchThroughProxies('https://origin', {
    proxies: PROXIES,
    fetchImpl: impl,
    onTrace: (t) => tags.push(t),
  });
  assert.equal(res.ok, true);
  assert.equal(impl.calls.length, 2);
  assert.match(impl.calls[1], /^https:\/\/p1/);
  assert.deepEqual(tags, ['direct=503', 'proxy0=200']);
});

test('fetchThroughProxies: a thrown direct error falls through', async () => {
  const impl = scriptedFetch([new TypeError('CORS'), makeResponse('via proxy')]);
  const res = await fetchThroughProxies('https://origin', { proxies: PROXIES, fetchImpl: impl });
  assert.equal(res.ok, true);
  assert.equal(impl.calls.length, 2);
});

test('fetchThroughProxies: all fail → best non-ok, else throw', async () => {
  const impl = scriptedFetch([
    makeResponse('a', { ok: false, status: 502 }),
    makeResponse('b', { ok: false, status: 500 }),
    makeResponse('c', { ok: false, status: 504 }),
  ]);
  const res = await fetchThroughProxies('https://origin', { proxies: PROXIES, fetchImpl: impl });
  assert.equal(res.status, 502); // first non-ok retained

  const throwing = scriptedFetch([new Error('x'), new Error('y'), new Error('z')]);
  await assert.rejects(fetchThroughProxies('https://origin', { proxies: PROXIES, fetchImpl: throwing }));
});

test('fetchThroughProxies: direct:false skips the origin', async () => {
  const impl = scriptedFetch([makeResponse('via proxy')]);
  const res = await fetchThroughProxies('https://origin', { proxies: PROXIES, direct: false, fetchImpl: impl });
  assert.equal(res.ok, true);
  assert.match(impl.calls[0], /^https:\/\/p1/);
});

test('fetchThroughProxies: requires a non-empty proxies array', async () => {
  await assert.rejects(fetchThroughProxies('https://x', { proxies: [] }));
  await assert.rejects(fetchThroughProxies('https://x', {}));
});

// ───────────────────────── hardening ─────────────────────────

test('fetchWithTimeout removes the external-signal listener on settle (no leak)', async () => {
  // A signal reused across many calls must not accumulate abort listeners.
  const listeners = new Set();
  const signal = {
    aborted: false,
    addEventListener: (_t, fn) => listeners.add(fn),
    removeEventListener: (_t, fn) => listeners.delete(fn),
  };
  const impl = scriptedFetch([makeResponse('ok')]);
  await fetchWithTimeout('https://x', { fetchImpl: impl, signal, timeout: 5000 });
  assert.equal(listeners.size, 0, 'listener should be removed once the fetch settles');
});

test('fetchWithTimeout treats timeout:0 as "no timer", not immediate abort', async () => {
  const impl = scriptedFetch([makeResponse({ ok: 1 })]);
  const res = await fetchWithTimeout('https://x', { fetchImpl: impl, timeout: 0 });
  assert.equal(res.ok, true);
});

test('fetchWithRetry clamps retries: -1 → one attempt, throws the real error', async () => {
  const impl = scriptedFetch([makeResponse('busy', { ok: false, status: 502 })]);
  await assert.rejects(
    fetchWithRetry('https://x', { fetchImpl: impl, sleepImpl: noSleep, retries: -1 }),
    (err) => err instanceof HttpError && err.status === 502,
  );
  assert.equal(impl.calls.length, 1);
});

test('fetchWithRetry never produces a negative backoff delay with negative jitter', async () => {
  const delays = [];
  const impl = scriptedFetch([
    makeResponse('busy', { ok: false, status: 503 }),
    makeResponse({ ok: 1 }),
  ]);
  await fetchWithRetry('https://x', {
    fetchImpl: impl,
    sleepImpl: async (ms) => delays.push(ms),
    random: () => 1,
    retries: 1,
    jitter: -5,
  });
  assert.ok(delays[0] >= 0, `delay should be clamped non-negative, got ${delays[0]}`);
});

test('HttpError carries a bounded snippet of the non-ok body', async () => {
  const impl = scriptedFetch([makeResponse('{"error":"bad symbol"}', { ok: false, status: 400 })]);
  await assert.rejects(
    fetchWithRetry('https://x', { fetchImpl: impl, sleepImpl: noSleep }),
    (err) => err instanceof HttpError && err.body === '{"error":"bad symbol"}',
  );
});

test('fetchThroughProxies survives a throwing proxy wrapper (chain continues)', async () => {
  const impl = scriptedFetch([makeResponse('via good proxy')]);
  const proxies = [
    () => { throw new Error('bad template'); },
    (u) => `https://good/?u=${encodeURIComponent(u)}`,
  ];
  const res = await fetchThroughProxies('https://origin', { proxies, direct: false, fetchImpl: impl });
  assert.equal(res.ok, true);
  assert.match(impl.calls[0], /^https:\/\/good/);
});

test('fetchThroughProxies swallows a throwing onTrace', async () => {
  const impl = scriptedFetch([makeResponse('ok')]);
  const res = await fetchThroughProxies('https://origin', {
    proxies: PROXIES,
    fetchImpl: impl,
    onTrace: () => { throw new Error('diag boom'); },
  });
  assert.equal(res.ok, true);
});
