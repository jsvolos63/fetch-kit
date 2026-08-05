# @jfs/fetch-kit — working notes for Claude

Shared, dependency-free browser fetch primitives for the JFS family of
buildless static PWAs — the client twin of netlify-kit's
`fetchWithRetry`: AbortController timeout, exponential backoff with
jitter, typed `HttpError`/`TimeoutError`, in-flight request coalescing, a
direct-first CORS proxy fallback chain, `Retry-After` parsing, and
multibyte-safe base64 codecs. Consumers vendor this kit via its own CLI
rather than installing it at runtime, so a change here reaches an app only
once that app bumps its pin and re-runs `vendor:sync`.

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

<!-- jfs-family-conventions:end -->
