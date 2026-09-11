# @jfs/fetch-kit — working notes for Claude

Shared, dependency-free browser fetch **and storage** primitives for the JFS
family of buildless static PWAs — the client twin of netlify-kit's
`fetchWithRetry`: AbortController timeout, exponential backoff with
jitter, typed `HttpError`/`TimeoutError`, in-flight request coalescing, and
`Retry-After` parsing. Consumers vendor this kit via its own CLI
rather than installing it at runtime, so a change here reaches an app only
once that app bumps its pin and re-runs `vendor:sync`.

## v0.3.0 dropped three exports nobody called

`fetchThroughProxies` (a direct-first CORS proxy fallback chain) and
`encodeBase64Utf8` / `decodeBase64Utf8` are gone. A grep across every repo in
`/home/user/*` found **zero** call sites: the only hits were the vendored
copies of this file, which are the DEFINITION, not a use — check for that
before reading a grep as evidence of a consumer. The proxy chain was the one
worth removing on its own merits, not just as dead weight: it handed a
caller's URL to third-party CORS proxies with no validation of either, so it
was standing SSRF-adjacent surface in every consumer's shipped bundle.

Don't re-add either speculatively. A kit whose surface grows on "an app might
want this" is a kit every consumer ships bytes for and nobody reads; the code
comes back when a call site comes with it.

## The pollution guard strips `__proto__`, and ONLY `__proto__`

`parseSafeJson`'s reviver (and `depollute`, the belt-and-braces pass behind
it) used to drop `constructor` and `prototype` as well, at every depth. That
was a silent data-mangler: a stored record with a legitimate `constructor`
field came back missing it, with nothing raised and nothing logged.

`__proto__` is the only one of the three that `JSON.parse` turns into a live
prototype write — it materializes as an OWN property, and the consumer's
`Object.assign` / deep-merge then fires the real setter. `constructor` and
`prototype` arrive as ordinary own data properties, and assigning one onto a
target writes an own property too. What IS dangerous is a merge that recurses
INTO an existing `target[k]` without an own-property check, walking `Object`
and then `Object.prototype` — and that is the merge's bug to fix, not
something this kit can fix by deleting data a consumer asked it to store.

Both layers carry the same one-key list on purpose: a second pass that
deleted more than the first would simply put the data loss back one layer
down. `test-storage.mjs` pins both halves — every nesting depth and array
element still loses `__proto__`, and a `{"constructor": {...}}` round-trips
intact.

## This kit ABSORBED @jfs/cache-kit (v0.2.0)

The storage section at the bottom of `index.js` — safe localStorage wrappers
(`lsGet`/`lsSet`/`lsRemove`), quota-aware writes (`isQuotaError`/
`safeSetItem`), and the two TTL-snapshot shapes (`saveSnapshot`/
`readSnapshot`, `writeTtlJson`/`readTtlJson`/`readTtlJsonTimestamp`) — used
to be its own kit. Per the family's own extraction bar (*prefer growing an
existing kit over minting a new one*), a 255-line repo with three consumers
that entirely overlap this kit's was one repo's permanent CI / pin /
vendoring overhead too many, so cache-kit went the way of dom-kit and
modal-kit: absorbed, retired, archived. Never re-add its pin.

Two rules carried over intact:

- **Compatibility superset.** Both snapshot shapes (`{at, payload}` vs
  `{ts, data}`) and both freshness comparisons (inclusive `<=` vs exclusive
  `<`) stay byte-for-byte — consumers adopted by changing import paths, and
  their users' stored data must keep parsing. Don't collapse them into one.
- **No IndexedDB store.** cache-kit's old tier 2 lives on as
  `JFS-Sports/cache-store-idb.js` (its only consumer). If a second and third
  app ever need one, take that file back rather than rebuilding it here.

`test-storage.mjs` is the absorbed suite; the storage section, like the rest
of the kit, resolves `localStorage` at call time and touches no global at
import time, so `"sideEffects": false` stays honest.

## Lint

`npm run lint` (ESLint flat config, `eslint.config.mjs`); CI runs it. Every
APP in the family already linted; none of the kits did — which left the
widest-blast-radius code with no second reader, since a bug here lands in
every consumer's vendored copy as bundler output nobody reads line by line.

`index.js` came back clean, so adopting it needed no version bump. Both
findings were unused bindings in `test-storage.mjs` (an imported `beforeEach`,
and one `const ls =` whose call is only there for its global-installing side
effect). `no-regex-spaces` is off, as in the sibling kits: the vendor suite
matches a known two-space indent in generated output.

One note for whoever fixes a finding here next. `const ls =
installLocalStorage(makeFakeLocalStorage());` appears SIXTEEN times in
`test-storage.mjs`, and `ls` is genuinely used in every one of them now that
the one unused binding is fixed — a find-and-replace on that line to silence
a future finding breaks every other test. Patch by line, not by text.

<!-- jfs-family-conventions:start — managed by jfs-claude-md-sync; edit family/family-conventions.md in @jfs/vendor-cli -->

## Family conventions

These conventions are identical across every repo in the @jfs family. The
section is managed by `jfs-claude-md-sync` (@jfs/vendor-cli) and checked by
family CI — edit `family/family-conventions.md` in the vendor-cli repo, not
here.

### Pull requests

Open pull requests **ready for review — never as drafts.** This applies to
PRs opened by automated Claude Code sessions too: some hosted environments
default to creating drafts, so mark the PR ready as part of opening it
rather than leaving it for a follow-up.

### Session autonomy

These repos are worked by automated Claude Code sessions with the owner
away, so a session that stops to ask has usually failed at the task. Every
repo's `.claude/settings.json` carries the family allowlist and
`acceptEdits`, so the ordinary tools of the job — reads, edits, git, the
npm scripts, the GitHub API — run without a permission prompt. Use them.

Ask a follow-up question only when proceeding either way would be wrong: a
genuine product decision, or an ambiguity whose two readings produce
materially different work. Routine calls — naming, file placement, patch
vs. minor, which helper to extract — belong to the session: pick the
obvious one, say so in the PR body, and keep going.

Merging is the session's job too. Open the PR ready for review, dispatch
CI, and squash-merge it once that run is green on the head commit. A
finished, green PR left open for a human to click is the outcome this
section exists to prevent. The gate itself does not move: green CI on the
head commit is still the precondition for every merge, and a red run means
fix it and re-dispatch — never merge anyway, and never park it and ask.

### Kit extraction bar

Extract shared code into a NEW `@jfs/*` kit only when both hold: a third
repo needs the same code, AND drift between the existing copies has already
caused a real bug or a manual reconciliation. Until then, copy-pasting
between two repos is cheaper than a new repo's permanent CI, pin, and
vendoring overhead. Prefer growing an existing kit over minting a new one.

### CI on automated pull requests

A push from an automated session does not fire `pull_request` workflows, so
a session-opened PR starts with no CI run of its own. Every repo's CI
workflow carries `workflow_dispatch:` so the session can run the same checks
by hand: dispatch CI on the branch, and do not merge until that run is green
on the head commit. A merge with no CI run defeats every gate the family
maintains.

### Look & feel baseline

These are mechanical UI rules, not a shared design system — each app keeps
its own look. They exist because each was violated in at least one family
repo and shipped as a real defect.

1. `env(safe-area-inset-*)` and `viewport-fit=cover` travel together — using
   one without the other is a bug (the insets resolve to 0 without it, and
   `black-translucent` status bars need it).
2. Every app has a global `:focus-visible` rule and sets
   `-webkit-tap-highlight-color` deliberately.
3. The `theme-color` meta, the manifest `theme_color`, the manifest
   `background_color`, and the app's `--bg` all agree (with a dark variant
   where the app has a light mode).
4. The version badge lives in the header and is rendered from build config,
   never hand-typed in HTML.
5. Webfonts are either self-hosted (subset, preloaded, `font-display: swap`)
   or absent — a font-family the page doesn't load must not be named first
   in a stack.

### Service-worker updates

A new build is never applied under the reader mid-session: no reload, no
swap of the controlling worker while a page is open. The worker registers,
the page shows a "new version" pill, and the new build takes over on a
gesture (the pill) or on the next launch. Two mechanisms satisfy that and
each app picks ONE: a worker that WAITS (no `skipWaiting()` in install; the
pill posts `SKIP_WAITING` and reloads on `controllerchange`) or a worker that
activates on install but never `clients.claim()`s (the pill just reloads).
Never mix them — a pill that posts `SKIP_WAITING` at a worker that already
activated has nothing to wait for and strands on "Updating…", which shipped
once.

### Dependencies

Every npm repo carries `.github/dependabot.yml` (weekly npm, minor and patch
grouped into one PR; monthly `github-actions`) and calls the family's
`dependabot-merge.yml` reusable workflow, which squash-merges a Dependabot PR
once the repo's CI is green on it and every bump in it is minor or patch. A
MAJOR bump is left open for a session or a human. Dependabot never touches
the `@jfs/*` git pins; the weekly kit-pin bump owns those. First-party
`actions/*` are referenced by major tag; every other action is pinned by
full SHA.

<!-- jfs-family-conventions:end -->
