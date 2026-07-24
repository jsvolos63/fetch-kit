# @jfs/fetch-kit — working notes for Claude

Shared, dependency-free browser fetch primitives for the JFS family of
buildless static PWAs — the client twin of netlify-kit's
`fetchWithRetry`: AbortController timeout, exponential backoff with
jitter, typed `HttpError`/`TimeoutError`, in-flight request coalescing, a
direct-first CORS proxy fallback chain, `Retry-After` parsing, and
multibyte-safe base64 codecs. Consumers vendor this kit via its own CLI
rather than installing it at runtime, so a change here reaches an app only
once that app bumps its pin and re-runs `vendor:sync`.

## Pull requests

Open pull requests **ready for review — never as drafts.** This applies to
PRs opened by automated Claude Code sessions too: some hosted environments
default to creating drafts, so mark the PR ready as part of opening it
rather than leaving it for a follow-up.
