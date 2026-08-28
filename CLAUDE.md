# @jfs/fetch-kit — working notes for Claude

Shared, dependency-free browser fetch **and storage** primitives for the JFS
family of buildless static PWAs — the client twin of netlify-kit's
`fetchWithRetry`: AbortController timeout, exponential backoff with
jitter, typed `HttpError`/`TimeoutError`, in-flight request coalescing, a
direct-first CORS proxy fallback chain, `Retry-After` parsing, and
multibyte-safe base64 codecs. Consumers vendor this kit via its own CLI
rather than installing it at runtime, so a change here reaches an app only
once that app bumps its pin and re-runs `vendor:sync`.

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

<!-- jfs-family-conventions:end -->
