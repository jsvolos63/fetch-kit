# @jfs/fetch-kit

Shared, dependency-free **browser fetch and storage primitives** for the JFS
family of buildless static PWAs — the client-side twin of
[`@jfs/netlify-kit`](https://github.com/jsvolos63/netlify-kit)'s server
`fetchWithRetry`, plus the localStorage primitives absorbed from the retired
`@jfs/cache-kit` at v0.2.0.

Every app in the family hand-rolls the same client fetch layer: an
`AbortController` timeout, exponential backoff with jitter, a
transient-vs-deterministic retry classification (retry 5xx/429, never a 4xx or
an abort), and — in the apps that poll one upstream from two places — an
in-flight request coalescer. Eight repos carry a slightly different copy of
that core. This package is the single, tested copy.

## API

A small composable core plus opt-in strategies — take only the layers you need.

### Core

```js
import { fetchJson, fetchWithRetry, HttpError, TimeoutError } from './fetch-kit/index.js';

try {
  const data = await fetchJson('/api/quote?sym=SPY', { timeout: 8000, retries: 2 });
} catch (err) {
  if (err instanceof HttpError && err.status === 404) show('not found');
  else if (err instanceof TimeoutError) show('slow — try again');
  else show('offline?');
}
```

- **`fetchWithTimeout(url, opts)`** — the floor: one fetch with an
  `AbortController` timeout, bridging a caller-supplied `signal`. Returns the
  **raw** `Response` (a non-ok status is *not* an error here); only a network
  failure or our own timeout throws (the latter as a `TimeoutError`).
- **`fetchWithRetry(url, opts)`** — timeout + exponential backoff/jitter +
  transient classification + `Retry-After`. Resolves an **ok** `Response` (a
  non-ok status throws a typed `HttpError`) or throws after exhausting retries.
  A non-transient failure (404, abort) throws on the first attempt.
- **`fetchJson(url, opts)` / `fetchText(url, opts)`** — `fetchWithRetry` + parse.

Options (all optional): `timeout` (default 12000), `retries` (default 2),
`retryStatuses` (default `[429, 502, 503, 504]`), `retryBaseMs` (default 400),
`jitter` (default 0.3), `respectRetryAfter` (default true),
`retryOn(err, attempt)` to replace the default classifier, `signal`, and any
extra keys are passed straight to `fetch`. `fetchImpl` / `sleepImpl` / `random`
are injectable seams for tests. Backoff is
`base = retryAfterMs ?? retryBaseMs * 2**attempt`, plus `random() * base * jitter`.

### Typed errors

- **`HttpError`** — `.status`, `.url`, `.body`, `.retryable`, `.retryAfterMs`.
  **`.body` is up to 2 KB of the upstream's own error response, verbatim and
  unredacted** — it is there so a caller can *read* the server's message, not
  so it can be displayed or logged. A failing endpoint's body routinely
  carries a stack trace, a request echo with the API key that was in the query
  string, an account identifier, or another user's record from a mis-scoped
  read. Treat it as untrusted, sensitive text: don't render it verbatim, don't
  ship it to a log sink or an error reporter, and prefer `.status` for
  anything a user or a logfile sees. `.url` carries the query string and
  deserves the same care.
- **`TimeoutError`** — `.url`, `.timeoutMs`. Never retried by default (a timeout
  means a slow upstream; retrying compounds latency — flip it back on with
  `retryOn` if you want the old Weather behavior).

### Coalescer

```js
import { createCoalescer, fetchJson } from './fetch-kit/index.js';
const coalesce = createCoalescer();
// A Refresh racing a poll tick, or two views hitting the same URL, share one call:
const p = coalesce(url, () => fetchJson(url));
```

An in-flight coalescer (not a cache): concurrent calls for the same key share
one promise, and the entry is removed as soon as it settles. `run.inFlight`
exposes the live `Map`.

## Storage primitives (absorbed from @jfs/cache-kit, v0.2.0)

The client-side localStorage primitives that used to be their own kit — the
same consolidation news-kit made on dom-kit and modal-kit. Every helper keeps
its origin's exact name, signature, and on-disk format, so a consumer adopts
this section by changing import paths, not call sites:

- **`lsGet(key)` / `lsSet(key, value)` / `lsRemove(key)`** — safe wrappers
  that never throw (private browsing, quota, locked-down iframes); reads
  return `null` on any failure, writes are best-effort no-ops.
- **`isQuotaError(e)` / `safeSetItem(key, value, {ownedKeys})`** — recognize
  a quota rejection across browsers; write one key with quota recovery
  (evict the *other* `ownedKeys` and retry once — only a key that is itself
  owned may trigger the eviction).
- **`saveSnapshot(key, payload)` / `readSnapshot(key, maxAgeMs)`** — the
  Weather `{at, payload}` shape, fresh while `now - at <= maxAgeMs`.
- **`writeTtlJson(key, data, opts)` / `readTtlJson(key, maxAgeMs)` /
  `readTtlJsonTimestamp(key, maxAgeMs)`** — the market-monitor `{ts, data}`
  shape, fresh while `now - ts < maxAgeMs`.

Both snapshot shapes and both freshness comparisons are deliberate: existing
users' stored data keeps parsing after adoption. Every read parses through a
prototype-pollution-stripping reviver — **`__proto__` dropped at every depth,
and only `__proto__`.** That is the one key `JSON.parse` turns into a live
prototype write; `constructor` and `prototype` arrive as ordinary own data
properties and are left alone, because stripping them (which this kit did
before v0.3.0) silently ate legitimate fields of those names. A merge that
recurses into an existing `target[k]` without an own-property check is the
thing to fix in the merge. No IndexedDB store — cache-kit's old
tier 2 lives on as `JFS-Sports/cache-store-idb.js`; take that file back if a
second and third app ever need one.

## Removed in v0.3.0

`fetchThroughProxies` (a direct-first CORS proxy fallback chain) and
`encodeBase64Utf8` / `decodeBase64Utf8` are gone. A family-wide grep found
**zero** call sites for any of the three — the only hits were the vendored
copies of this file, which are the definition, not a use. The proxy chain in
particular forwarded a caller's URL to third-party proxies with no validation,
so it was standing SSRF-adjacent surface in every consumer's shipped bundle
for nobody's benefit. Don't re-add either speculatively: bring the code back
with a call site attached.

## How it's consumed

These are buildless sites — `node_modules` is not deployed. Each app commits a
generated copy of `index.js` (generated by the kit's own vendoring CLI) and
imports it directly. ES-module apps vendor the verbatim ESM copy:

```json
"vendor:sync":  "jfs-fetch-kit-vendor --format esm --out fetch-kit/index.js",
"vendor:check": "jfs-fetch-kit-vendor --format esm --out fetch-kit/index.js --check"
```

Classic-script apps use `--format global --name FetchKit` (exposes
`globalThis.FetchKit`); CommonJS functions use `--format cjs`. (A fourth
`bare` format existed through vendor-cli 0.18.x with no consumer and was
removed in 0.19.0.) The exposed surface is derived from `index.js`'s own `export`
declarations, never a hand-maintained list; `npm run vendor:check` fails CI on
drift.

## Test

```
npm test        # node --test test.mjs test-storage.mjs test-vendor.mjs
```

The retry/backoff/timeout logic runs through injected `fetchImpl` / `sleepImpl`
/ `random` seams, so the suite touches no network and no real timers.
