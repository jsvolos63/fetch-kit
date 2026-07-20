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

  return doFetch(url, { ...init, signal: controller.signal })
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
