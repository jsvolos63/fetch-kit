// @jfs/fetch-kit — the browser twin of netlify-kit's server-side
// fetchWithRetry, for the JFS family of buildless static PWAs.
//
// Every app hand-rolls the same client fetch layer: an AbortController
// timeout, exponential backoff with jitter, a transient-vs-deterministic
// retry classification (retry 5xx/429, never 4xx or an abort), and — in the
// apps that talk to flaky upstreams through public CORS proxies — an
// in-flight request coalescer and a proxy fallback chain. Eight repos carry a
// slightly different copy (Weather's typed HttpError, FlightCheck's coalescer
// + Retry-After, JFS-Sports' proxy chain, Art-Gallery's withTimeout/lanes,
// Surf-Tracker's cached feed race, market-monitor's one-line fetchWithTimeout,
// Bears' proxy .catch chain, Zepbound's base64 codecs). This is the single,
// tested copy of that core.
//
// Pure ESM, dependency-free. The design is a small composable core plus opt-in
// strategies, so an app takes only the layers it needs:
//
//   fetchWithTimeout(url, opts)   — the floor: one fetch, an AbortController
//                                   timeout, external-signal bridging. Returns
//                                   the raw Response (may be !ok).
//   fetchWithRetry(url, opts)     — timeout + exponential backoff/jitter +
//                                   transient classification + Retry-After.
//                                   Resolves an ok Response or throws a typed
//                                   HttpError / TimeoutError.
//   fetchJson / fetchText         — fetchWithRetry + parse.
//   createCoalescer()             — dedupe concurrent identical requests onto
//                                   one in-flight promise (keyed by any string).
//   fetchThroughProxies(url, o)   — direct-first CORS proxy fallback chain.
//   parseRetryAfter(header)       — delta-seconds | HTTP-date → ms.
//   encodeBase64Utf8 / decodeBase64Utf8 — multibyte-safe base64 (GitHub
//                                   Contents API etc.); atob/btoa are Latin-1.
//
// Since v0.2.0 the kit also carries the family's client-side STORAGE
// primitives (safe localStorage wrappers, quota-aware writes, JSON snapshots
// with TTL), absorbed from the retired @jfs/cache-kit — see the storage
// section at the bottom of this file.
//
// Everything is injectable (fetchImpl / sleepImpl) so the retry/backoff logic
// is unit-tested without a network or real timers.

// ───────────────────────── typed errors ─────────────────────────

/** Thrown when a response arrives but is not ok. Carries the status, the URL,
 *  an optional body snippet, whether the retry layer classified it as
 *  transient, and a parsed Retry-After delay (ms) when the server sent one. */
export class HttpError extends Error {
  constructor(status, url, { body = null, retryable = false, retryAfterMs = null } = {}) {
    super(`HTTP ${status} for ${url}`);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
    this.body = body;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
  }
}

/** Thrown when *our own* timeout aborts a request (as opposed to a caller
 *  aborting via an external signal, which rethrows the original AbortError).
 *  Never retried by default — a timeout usually means a slow upstream, and
 *  retrying compounds the latency. */
export class TimeoutError extends Error {
  constructor(url, timeoutMs) {
    super(`Request to ${url} timed out after ${Math.round(timeoutMs / 1000)}s`);
    this.name = 'TimeoutError';
    this.url = url;
    this.timeoutMs = timeoutMs;
  }
}

// ───────────────────────── small helpers ─────────────────────────

/** Promise-based sleep. Injectable into the retry loop so tests don't wait. */
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Upper bound on any Retry-After-derived delay. A hostile or misconfigured
// upstream can send `Retry-After: 100000000` (or a far-future HTTP-date) and,
// unclamped, that value flows straight into the retry backoff — wedging the
// client for hours/days. Cap it so the server can still ask us to wait, but
// never longer than two minutes.
const RETRY_AFTER_CAP_MS = 120000;

/** Retry-After → milliseconds, clamped to [0, RETRY_AFTER_CAP_MS]. Handles both
 *  the delta-seconds form ("120") and the HTTP-date form
 *  ("Wed, 21 Oct 2026 07:28:00 GMT"); returns null when the header is absent or
 *  unparseable. The upper clamp keeps a hostile/misconfigured upstream from
 *  wedging the client for hours with an enormous value. */
export function parseRetryAfter(headerValue) {
  if (!headerValue) return null;
  const secs = Number(headerValue);
  if (Number.isFinite(secs)) return Math.min(RETRY_AFTER_CAP_MS, Math.max(0, secs * 1000));
  const dateMs = Date.parse(headerValue);
  if (Number.isFinite(dateMs)) return Math.min(RETRY_AFTER_CAP_MS, Math.max(0, dateMs - Date.now()));
  return null;
}

/** UTF-8-safe base64 encode. btoa is Latin-1 only, so multibyte text (emoji,
 *  accents) corrupts without this TextEncoder round-trip. */
export function encodeBase64Utf8(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/** UTF-8-safe base64 decode. `fatal: true` throws on malformed UTF-8 rather
 *  than silently substituting replacement characters. */
export function decodeBase64Utf8(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

// ───────────────────────── fetchWithTimeout ─────────────────────────

const DEFAULT_TIMEOUT_MS = 12000;

/** One fetch with an AbortController timeout. Bridges a caller-supplied
 *  `signal` (aborting our controller when it fires, and honoring an already-
 *  aborted signal), and clears the timer in a `finally`. Returns the raw
 *  Response — a non-ok status is NOT an error here (callers that want the
 *  status, e.g. the proxy chain, need it); only a network failure or our own
 *  timeout throws (the latter as a TimeoutError).
 *
 *  Options: `{ timeout, signal, fetchImpl, ...init }` — everything else is
 *  passed straight to fetch as its init. */
export function fetchWithTimeout(url, { timeout = DEFAULT_TIMEOUT_MS, signal, fetchImpl, ...init } = {}) {
  const doFetch = fetchImpl || globalThis.fetch;
  const controller = new AbortController();
  let timedOut = false;
  // Only arm a timer for a positive, finite timeout. `timeout: 0` (or NaN)
  // otherwise schedules an immediate abort — a footgun for callers who pass 0
  // meaning "no timeout". 0/negative/NaN ⇒ no timer (rely on the external
  // signal, if any).
  const armTimeout = Number.isFinite(timeout) && timeout > 0;
  const timer = armTimeout
    ? setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeout)
    : null;

  // Bridge an external signal onto our controller so both a caller abort and
  // our timeout land on the same signal the fetch is watching. The listener is
  // removed in the `finally` below — otherwise a long-lived signal reused
  // across many requests would accumulate one dead listener per completed call.
  let onExternalAbort = null;
  if (signal) {
    if (signal.aborted) controller.abort();
    else {
      onExternalAbort = () => controller.abort();
      signal.addEventListener('abort', onExternalAbort);
    }
  }

  // Guard the call itself: a synchronously-throwing fetchImpl (or a missing
  // global fetch in a non-browser runtime) would otherwise skip the .finally
  // below entirely, leaking the armed timer (which keeps a node event loop
  // alive for up to `timeout` ms) and the external-signal listener.
  let pending;
  try {
    pending = doFetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (timer) clearTimeout(timer);
    if (onExternalAbort) signal.removeEventListener('abort', onExternalAbort);
    throw err;
  }

  return Promise.resolve(pending)
    .catch((err) => {
      // Our timer fired: surface a clear TimeoutError. A caller-driven abort
      // (external signal) keeps its original AbortError so the caller can tell
      // "I cancelled this" from "it timed out".
      if (timedOut && err && err.name === 'AbortError') {
        throw new TimeoutError(url, timeout);
      }
      throw err;
    })
    .finally(() => {
      if (timer) clearTimeout(timer);
      if (onExternalAbort) signal.removeEventListener('abort', onExternalAbort);
    });
}

// ───────────────────────── fetchWithRetry ─────────────────────────

const DEFAULT_RETRY_STATUSES = [429, 502, 503, 504];
const DEFAULT_RETRIES = 2;
const DEFAULT_RETRY_BASE_MS = 400;
const DEFAULT_JITTER = 0.3;
// Cap the error-body snippet attached to HttpError so a huge HTML error page
// can't balloon the error object.
const MAX_ERROR_BODY = 2048;

/** Default transient classification: a listed status (429/502/503/504) or a
 *  bare network TypeError is worth retrying; a TimeoutError, an AbortError, and
 *  every other 4xx is not. Overridable via the `retryOn` option. */
function defaultRetryable(err, retryStatuses) {
  if (err instanceof HttpError) return retryStatuses.includes(err.status);
  if (err instanceof TimeoutError) return false;
  if (err && err.name === 'AbortError') return false;
  // A raw fetch rejection (no Response) is almost always a transient network
  // blip (DNS, connection reset, CORS-preflight hiccup).
  return err instanceof TypeError;
}

/** timeout + exponential backoff with jitter + transient classification +
 *  Retry-After. Resolves an **ok** Response (a non-ok status throws an
 *  HttpError) or throws after exhausting retries. Non-transient failures throw
 *  on the first attempt — no wasted retries on a 404 or an abort.
 *
 *  Options (all optional):
 *    timeout        per-attempt timeout ms (default 12000)
 *    retries        extra attempts after the first (default 2)
 *    retryStatuses  statuses treated as transient (default [429,502,503,504])
 *    retryBaseMs    backoff base ms; delay = base * 2**attempt (default 400)
 *    jitter         added fraction 0..jitter of the base (default 0.3)
 *    respectRetryAfter  honor a Retry-After header on transient statuses,
 *                   overriding the computed backoff (default true)
 *    retryOn(err, attempt)  custom predicate replacing the default classifier
 *    signal         external AbortSignal
 *    fetchImpl, sleepImpl, random  injectable seams for tests
 *    ...init        passed to fetch
 *
 *  NOT the same contract as @jfs/netlify-kit's fetchWithRetry: this one
 *  retries 429 by default, honors Retry-After, and throws HttpError on any
 *  non-ok status; netlify-kit's does not retry 429 unless opted in, ignores
 *  Retry-After, and returns the Response (ok or not) instead of throwing.
 */
export async function fetchWithRetry(url, opts = {}) {
  const {
    timeout = DEFAULT_TIMEOUT_MS,
    retries = DEFAULT_RETRIES,
    retryStatuses = DEFAULT_RETRY_STATUSES,
    retryBaseMs = DEFAULT_RETRY_BASE_MS,
    jitter = DEFAULT_JITTER,
    respectRetryAfter = true,
    retryOn,
    signal,
    fetchImpl,
    sleepImpl = sleep,
    random = Math.random,
    ...init
  } = opts;

  // Clamp hostile/typo'd numeric options so a negative/NaN value can't turn the
  // loop into "never attempt" (retries < 0) or a negative backoff delay.
  const maxRetries = Number.isFinite(retries) && retries > 0 ? Math.floor(retries) : 0;
  const baseMs = Number.isFinite(retryBaseMs) && retryBaseMs >= 0 ? retryBaseMs : DEFAULT_RETRY_BASE_MS;
  const jitterFrac = Number.isFinite(jitter) && jitter >= 0 ? jitter : 0;
  const isRetryable = retryOn || ((err) => defaultRetryable(err, retryStatuses));
  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetchWithTimeout(url, { ...init, timeout, signal, fetchImpl });
      if (res.ok) return res;
      // Non-ok: build a typed error, parsing Retry-After when the status is
      // one we'd retry so the backoff can honor the server's window.
      const transient = retryStatuses.includes(res.status);
      // Guard `headers.get`: a spec `Response` always has it, but polyfills and
      // test doubles don't always, and a missing Retry-After header just means
      // "fall back to the computed backoff".
      const retryAfterMs =
        transient && respectRetryAfter ? parseRetryAfter(res.headers?.get?.('Retry-After')) : null;
      // Capture a bounded snippet of the error body so consumers can read the
      // server's message (validation text, rate-limit JSON). We're about to
      // throw rather than return `res`, so consuming its body here is safe and
      // also releases the connection instead of leaving it dangling until GC.
      let body = null;
      try {
        if (typeof res.text === 'function') body = (await res.text()).slice(0, MAX_ERROR_BODY);
      } catch {
        // A body that can't be read (already consumed, network cut mid-stream)
        // must not mask the real HTTP status — leave body null.
      }
      throw new HttpError(res.status, url, { body, retryable: transient, retryAfterMs });
    } catch (err) {
      lastError = err;
      if (attempt >= maxRetries || !isRetryable(err, attempt)) throw err;
      const base = err && err.retryAfterMs != null ? err.retryAfterMs : baseMs * 2 ** attempt;
      // Clamp the final delay too: even a parsed Retry-After (already capped in
      // parseRetryAfter) plus jitter, or a runaway exponential base, must never
      // push a single wait past the cap and wedge the client.
      const delay = Math.min(RETRY_AFTER_CAP_MS, base + random() * base * jitterFrac);
      await sleepImpl(delay);
    }
  }
  // Unreachable (the loop either returns or throws), but keeps the analyzer
  // happy and documents the invariant.
  throw lastError;
}

/** fetchWithRetry + JSON parse. Throws HttpError on non-ok (before parsing) and
 *  the parse error on malformed JSON. */
export async function fetchJson(url, opts = {}) {
  const res = await fetchWithRetry(url, opts);
  return res.json();
}

/** fetchWithRetry + text parse. */
export async function fetchText(url, opts = {}) {
  const res = await fetchWithRetry(url, opts);
  return res.text();
}

// ───────────────────────── coalescer ─────────────────────────

/** An in-flight request coalescer: concurrent calls for the same key share one
 *  promise, and the entry is removed as soon as it settles (a coalescer, not a
 *  cache — it never replays a stale result). Returns a `run(key, factory)`
 *  function; a Refresh racing a poll tick, or two views hitting the same URL,
 *  collapse onto a single network call.
 *
 *    const coalesce = createCoalescer();
 *    coalesce(url, () => fetchJson(url));   // second concurrent call reuses it
 *
 *  The returned function also exposes `.inFlight` (the live Map) for tests. */
export function createCoalescer() {
  const inFlight = new Map();
  function run(key, factory) {
    const pending = inFlight.get(key);
    if (pending) return pending;
    const p = Promise.resolve()
      .then(factory)
      .finally(() => inFlight.delete(key));
    inFlight.set(key, p);
    return p;
  }
  run.inFlight = inFlight;
  return run;
}

// ───────────────────────── proxy chain ─────────────────────────

/** Direct-first CORS proxy fallback, the JFS-Sports topology (the most-used in
 *  the family). Tries the URL directly; an ok response wins, and a direct 4xx
 *  is taken as the real answer (the origin spoke — a proxy won't change a bad
 *  request). Only a 5xx or a thrown error falls through to the proxies, tried
 *  in order; the first ok response wins, else the best non-ok response seen,
 *  else the last error is rethrown. Returns the raw Response.
 *
 *  Options:
 *    proxies    array of `(url) => proxiedUrl` wrappers (required, non-empty)
 *    direct     try the origin directly first (default true)
 *    timeout    per-hop timeout ms
 *    signal, fetchImpl, ...init   as fetchWithTimeout
 *    onTrace(tag)  optional callback fed "direct=200" / "proxy0=502" / … for
 *                  diagnostics */
export async function fetchThroughProxies(url, { proxies, direct = true, onTrace, ...fetchOpts } = {}) {
  if (!Array.isArray(proxies) || proxies.length === 0) {
    throw new Error('fetchThroughProxies: `proxies` must be a non-empty array of url-wrapper functions');
  }
  // A diagnostic callback must never be able to fail the request.
  const trace = (tag) => {
    if (typeof onTrace !== 'function') return;
    try {
      onTrace(tag);
    } catch {
      /* swallow — onTrace is best-effort diagnostics */
    }
  };
  let bestNonOk = null;
  let lastError = null;

  // Build the hop list, computing each proxy URL lazily-but-defensively: a
  // single wrapper that throws (bad template, malformed URL) must not sink the
  // whole chain — the direct hop and the other proxies still get their turn.
  const hops = [];
  if (direct) hops.push({ tag: 'direct', url });
  proxies.forEach((wrap, i) => {
    let proxied;
    try {
      proxied = wrap(url);
    } catch (err) {
      trace(`proxy${i}!`);
      lastError = err;
      return;
    }
    hops.push({ tag: `proxy${i}`, url: proxied });
  });

  for (const hop of hops) {
    try {
      const res = await fetchWithTimeout(hop.url, fetchOpts);
      trace(`${hop.tag}=${res.status}`);
      if (res.ok) return res;
      // A definitive client error from the origin is the answer; don't launder
      // it through a proxy. (Only meaningful for the direct hop.)
      if (hop.tag === 'direct' && res.status >= 400 && res.status < 500) return res;
      bestNonOk = bestNonOk || res;
    } catch (err) {
      trace(`${hop.tag}!`);
      lastError = err;
    }
  }
  if (bestNonOk) return bestNonOk;
  throw lastError || new Error(`fetchThroughProxies: every hop failed for ${url}`);
}

// ═════════════════════════ storage primitives ═════════════════════════
//
// Absorbed from @jfs/cache-kit (v0.2.0 of this kit, 2026-08) — the same move
// news-kit made on dom-kit and modal-kit: two micro-kits with overlapping
// consumers were one repo too many, so the localStorage primitives live here
// now and cache-kit is retired. Every helper keeps its origin's exact name,
// signature, and on-disk format, so the sibling apps adopt this section by
// changing IMPORT PATHS, not call sites:
//
//     lsGet / lsSet / lsRemove            (FlightCheck src/tracking/state.js)
//     saveSnapshot / readSnapshot         (Weather js/lib/storage.js — {at, payload})
//     isQuotaError / safeSetItem          (market-monitor js/utils/cache.js)
//     writeTtlJson / readTtlJson /
//       readTtlJsonTimestamp              (market-monitor — {ts, data})
//
// Both snapshot shapes ({at, payload} vs {ts, data}) and both freshness
// comparisons (Weather's inclusive `<= maxAgeMs` vs market-monitor's
// exclusive `< maxAgeMs`) are kept byte-for-byte rather than collapsed into
// one, so existing users' stored data keeps parsing after adoption.
//
// SCOPE: no IndexedDB store. cache-kit's old tier 2 (`createCacheStore` /
// `createPrefsStorage`) went home to its only consumer as
// JFS-Sports/cache-store-idb.js before the absorption; should a second and
// third app need an IDB store, take that file back — don't rebuild it here.
//
// Like the rest of this module, this section imports NOTHING and touches no
// global at import time — `localStorage` is resolved at call time, so node
// tests stub it on globalThis and non-browser environments degrade to safe
// no-ops.

// ---------------------------------------------------------------------------
// Safe localStorage wrappers (origin: FlightCheck)
// ---------------------------------------------------------------------------

// localStorage can throw in private browsing, locked-down iframes, or when
// quota is exhausted. These wrap every access so a storage failure never
// breaks the calling flow — persistence is convenience, not correctness.

/** Read a key; null when missing, unavailable, or on any storage error. */
export function lsGet(key) {
    try {
        return typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
    } catch {
        return null;
    }
}

/** Best-effort write; silently a no-op when storage is unavailable/full. */
export function lsSet(key, value) {
    try {
        if (typeof localStorage !== 'undefined') localStorage.setItem(key, value);
    } catch { /* best-effort */ }
}

/** Best-effort remove; silently a no-op when storage is unavailable. */
export function lsRemove(key) {
    try {
        if (typeof localStorage !== 'undefined') localStorage.removeItem(key);
    } catch { /* best-effort */ }
}

// ---------------------------------------------------------------------------
// Quota-aware writes (origin: market-monitor)
// ---------------------------------------------------------------------------

/**
 * Recognize a storage-quota rejection across browsers (Chrome/Safari name it
 * QuotaExceededError / code 22; Firefox uses NS_ERROR_DOM_QUOTA_REACHED /
 * 1014).
 */
export function isQuotaError(e) {
    return !!e && (
        e.name === 'QuotaExceededError' ||
        e.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
        e.code === 22 || e.code === 1014
    );
}

/**
 * Write one key with quota recovery. On a quota error, evict the *other*
 * caches in `ownedKeys` — a stale snapshot is worth less than the current
 * write landing — and retry once. Only a key that is itself a member of
 * `ownedKeys` may trigger the eviction: a small non-owned key must never
 * wipe the big caches to squeeze itself in — it just gives up quietly.
 * Callers set survival priority by write order (least- to most-valuable).
 * Returns true when the write landed.
 */
export function safeSetItem(key, value, { ownedKeys = [] } = {}) {
    if (typeof localStorage === 'undefined') return false;
    try {
        localStorage.setItem(key, value);
        return true;
    } catch (e) {
        if (!isQuotaError(e)) return false; // unavailable/private-mode — give up quietly
        if (!ownedKeys.includes(key)) return false;
        for (const k of ownedKeys) {
            if (k !== key) { try { localStorage.removeItem(k); } catch { /* ignore */ } }
        }
        try { localStorage.setItem(key, value); return true; }
        catch { return false; }
    }
}

// ---------------------------------------------------------------------------
// JSON snapshots with TTL
// ---------------------------------------------------------------------------
//
// Prototype-pollution defense for parsed localStorage entries: JSON.parse
// materializes a `"__proto__"` (or `constructor`/`prototype`) JSON key as an
// OWN property, and callers Object.assign / deep-merge the parsed data onto
// app state — which invokes the real `__proto__` setter and would re-point the
// consumer's prototype chain (or `Object.prototype` itself, for a deep merge).
//
// The strip must be TOTAL: an earlier version only cleaned the top-level
// object, so `{"a":{"__proto__":{"isAdmin":true}}}` walked straight through
// the guard one key deeper and polluted any consumer that deep-merged the
// result. Ingestion therefore parses through `parseSafeJson`, whose reviver
// drops the three dangerous keys at EVERY level (including inside arrays) —
// one chokepoint that cannot miss a nesting depth. Well-formed values are
// otherwise untouched: same shape, same values, ordinary prototypes, so
// callers and round-trip tests still see plain objects. Shape validation still
// runs on the parse result.
const _POLLUTION_KEYS = ['__proto__', 'constructor', 'prototype'];
const _isPollutionKey = (k) => k === '__proto__' || k === 'constructor' || k === 'prototype';

// JSON.parse reviver: returning undefined deletes the key from its holder, so
// a dangerous key is removed at whatever depth it appears (array elements
// included — their own keys are visited too). Applied bottom-up by the spec,
// so nothing can be re-introduced after the fact.
function _pollutionReviver(key, value) {
    return _isPollutionKey(key) ? undefined : value;
}

/** JSON.parse with every `__proto__`/`constructor`/`prototype` key stripped at
 * every level. Throws on malformed JSON exactly like JSON.parse. */
function parseSafeJson(raw) {
    return JSON.parse(raw, _pollutionReviver);
}

// Belt-and-braces for values that did NOT come through parseSafeJson: walks
// own enumerable values (objects AND array elements) and deletes the dangerous
// own keys at every level. Iterative with a WeakSet seen-guard (cyclic input is
// visited once) and a depth cap, so a hostile shape can't hang or blow the
// stack. Mutates in place and returns the same reference.
const _MAX_DEPOLLUTE_DEPTH = 64;
function depollute(parsed) {
    if (parsed == null || typeof parsed !== 'object') return parsed;
    const seen = new WeakSet();
    const stack = [[parsed, 0]];
    while (stack.length) {
        const [node, depth] = stack.pop();
        if (node == null || typeof node !== 'object' || seen.has(node)) continue;
        seen.add(node);
        if (!Array.isArray(node)) {
            for (const k of _POLLUTION_KEYS) {
                if (Object.prototype.hasOwnProperty.call(node, k)) delete node[k];
            }
        }
        if (depth >= _MAX_DEPOLLUTE_DEPTH) continue;
        for (const v of Object.values(node)) {
            if (v !== null && typeof v === 'object') stack.push([v, depth + 1]);
        }
    }
    return parsed;
}

// Two on-disk shapes coexist in the family; both are kept byte-for-byte so
// existing users' stored data keeps parsing after adoption:
//
//   Weather shape        {at: <ms epoch>, payload: <any>}   fresh while
//                        `now - at <= maxAgeMs` (inclusive)
//   market-monitor shape {ts: <ms epoch>, data: <object>}   fresh while
//                        `now - ts <  maxAgeMs` (exclusive)

/**
 * Persist `{at: Date.now(), payload}` under `key` so views can fall back to
 * the last good data when the network is unavailable. Best-effort: private
 * browsing just means snapshots won't persist. (Weather shape.)
 */
export function saveSnapshot(key, payload) {
    try {
        localStorage.setItem(key, JSON.stringify({ at: Date.now(), payload }));
    } catch { /* private browsing — snapshots just won't persist */ }
}

/**
 * Read a snapshot written by `saveSnapshot`. Returns the whole
 * `{at, payload}` object while it is at most `maxAgeMs` old, else null
 * (missing, corrupt, or stale). (Weather shape.)
 */
export function readSnapshot(key, maxAgeMs) {
    try {
        const snap = parseSafeJson(localStorage.getItem(key));
        if (snap && Date.now() - snap.at <= maxAgeMs) {
            // parseSafeJson already stripped every level; depollute is the
            // second layer in case a future call site hands over a value that
            // did not come through the reviver.
            return depollute(snap);
        }
    } catch { /* corrupt or missing */ }
    return null;
}

/**
 * Persist `{ts, data}` under `key` via `safeSetItem` (so a quota rejection
 * can evict sibling `ownedKeys` and retry). `ts` defaults to now; pass an
 * explicit shared timestamp when stamping several keys in one save pass.
 * Returns true when the write landed. (market-monitor shape.)
 */
export function writeTtlJson(key, data, { ts = Date.now(), ownedKeys = [] } = {}) {
    return safeSetItem(key, JSON.stringify({ ts, data }), { ownedKeys });
}

/**
 * Read an entry written by `writeTtlJson` and return its `data`, or null
 * when the entry is missing, corrupt, stale (age >= maxAgeMs), or its data
 * is not a plain object (arrays rejected). (market-monitor shape — the
 * object-only check matches its callers, which Object.assign the result
 * onto app state.)
 */
export function readTtlJson(key, maxAgeMs) {
    try {
        const raw = localStorage.getItem(key);
        if (!raw) return null;
        const obj = parseSafeJson(raw);
        if (!obj || typeof obj !== 'object' || typeof obj.ts !== 'number') return null;
        if (Date.now() - obj.ts >= maxAgeMs) return null;
        if (obj.data == null || typeof obj.data !== 'object' || Array.isArray(obj.data)) return null;
        return depollute(obj.data);
    } catch { return null; }
}

/**
 * When an entry written by `writeTtlJson` was last saved (ms epoch), or null
 * if there is no usable entry. Unlike `readTtlJson` this does not validate
 * the data shape — it answers "how old is the snapshot?", e.g. for an
 * "as of …" label. (market-monitor shape.)
 */
export function readTtlJsonTimestamp(key, maxAgeMs) {
    try {
        const raw = localStorage.getItem(key);
        if (!raw) return null;
        const obj = depollute(parseSafeJson(raw));
        if (!obj || typeof obj.ts !== 'number') return null;
        if (Date.now() - obj.ts >= maxAgeMs) return null;
        return obj.ts;
    } catch { return null; }
}
