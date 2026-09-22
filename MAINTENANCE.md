# Maintaining @jfs/fetch-kit

This kit has no deploy, no upstream feed, no key and no user. What maintenance
here turns on is the opposite shape: one pin in `dependencies` that decides
which vendoring generator four consumer apps run, a delivery pipeline that has
failed **every run since it was created** with nothing said anywhere, and the
fact that renaming or dropping an export is a breaking change that lands in a
consumer's `vendor:sync` (or, for a full-surface consumer, its browser) rather
than here — which `test-consumers.mjs` now turns into a failure here first,
against a snapshot of what the four consumers import.

## What runs by itself

| Automation | Fires | Lands by itself | Leaves for a session | How a failure would be noticed |
| --- | --- | --- | --- | --- |
| `.github/workflows/test.yml` → vendor-cli's `family-ci.yml@main` (`verify-kit-pins: true`, `prod-audit: true`, `maintenance-check: true`, `version-guard-paths: index.js bin`) | push to `main`, every `pull_request`, `workflow_dispatch` | — it *is* the gate | nothing | red on the PR or the commit. The only automation here whose failure appears where somebody is already looking. |
| `.github/workflows/kit-pin-bump.yml` (`cron: '41 6 * * 1'`, Mondays ~06:41 UTC) + dispatch → vendor-cli's `kit-pin-bump.yml@main` | weekly | the one `@jfs/vendor-cli` pin, `package-lock.json`, the CLAUDE.md conventions block, the PR, the squash-merge | nothing, when it works | **nothing.** It has never delivered a bump on its own. See below. |
| `.github/workflows/release.yml` (`workflow_run` on `Test` completed, `branches: [main]`) + dispatch → vendor-cli's `release.yml@main` | CI green on `main` | the `v<version>` tag and its GitHub release | nothing | **nothing** — but it is healthy here: run 27 tagged `v0.3.0` on 2026-09-11, and every version from `0.1.1` up is tagged (`0.1.0` predates the workflow). |
| `.github/dependabot.yml` + `.github/workflows/dependabot-merge.yml` (`workflow_run` on `Test` completed) | npm weekly Tuesday, minor+patch grouped; `github-actions` monthly | every minor/patch bump, squash-merged on green | **every major**, and any PR body it cannot parse | a PR sits open. Nobody is told. Zero are open as of the 2026-09-22 sweep; the last grouped bump (eslint 10.10.0 → 10.11.0) landed as #29 on 2026-09-22. |

There is **no deploy step and no `main`-branch publish** — this package is
never installed at runtime by anything. It reaches an app only when that app
bumps its `@jfs/fetch-kit` pin and re-runs its own `vendor:sync`. So the
family's "Green CI is not delivered" section applies here with the delivery
boundary in somebody else's repo: a fix merged and tagged here is still absent
from all four consumers until each re-vendors.

### The weekly bump has failed every run, for two different reasons

`.github/workflows/kit-pin-bump.yml` was added on 2026-08-17 (#17) and fires on
`41 6 * * 1`. It has run six times — five on `schedule`, one dispatched — and
**all six failed**, verified against the Actions API on 2026-09-22:

| Run | Date | Failed at step | Cause |
| --- | --- | --- | --- |
| 1 | 2026-08-24 | 7, "Re-vendor from the bumped pins" | the caller passed only `check-command`, so the reusable workflow's defaults ran `npm run vendor:sync` — a script a kit does not have |
| 2 | 2026-08-31 | 7 | same |
| 3 | 2026-09-07 | 7 | same |
| 4 | 2026-09-14 | 11, "Open a pull request if anything changed" | `GitHub Actions is not permitted to create or approve pull requests.` |
| 5 | 2026-09-21 | 11 | same |
| 6 | 2026-09-22 (`workflow_dispatch`) | the PR step | same |

#23 fixed the first cause on 2026-09-08 (`vendor-sync-command: npm install`,
`version-bump-command: ''`) and the failure moved one step later. Nobody saw
either. That is the whole argument for the weekly check in the family block
below: the fix was correct, it was verified, and it bought two more silent
weeks.

The second cause is **not a code bug and cannot be fixed in this repository.**
It is the per-repo setting at *Settings → Actions → General → Workflow
permissions* — <https://github.com/jsvolos63/fetch-kit/settings/actions> —
which must allow GitHub Actions to create pull requests. pwa-kit and
Netlify-kit have the identical failure; news-kit does not. **It is still
unflipped** after 2026-09-22, so next Monday's run will fail the same way.

Everything before the PR step succeeds, including "Run the repo's CI checks
against the bumped tree", so each run leaves a **validated** bump on the
remote, undelivered:

```
git ls-remote --heads origin 'refs/heads/auto/kit-pin-bump'
```

That is how the pin moved on 2026-09-22: run 6 rebuilt `auto/kit-pin-bump` on
current `main` (`@jfs/vendor-cli` `276274b` 0.21.3 → `3e9e174` 0.21.7, touching
only `package.json` and `package-lock.json`), a session opened #30 from it by
hand, and it merged green as `9b3b8aa`. The branch is gone and the pin is at
vendor-cli HEAD — until vendor-cli moves again, when the next bump strands the
same way. **Until the setting is flipped, a stranded `auto/kit-pin-bump`
branch is the expected output of every Monday**, and delivering it means
opening its PR by hand.

**How urgent is a stranded bump?** Measured, not assumed, twice. Each bump
also moves the generator's esbuild, so it is a reprinter change and could in
principle move bytes in the two consumers that vendor a `--pick`-narrowed (and
therefore esbuild-reprinted) copy. Under 0.21.3 + esbuild 0.25.10, 0.21.6 +
esbuild 0.28.2 and — after #30 — 0.21.7 + esbuild 0.28.2, generating the shapes
this kit's consumers actually vendor gives **byte-identical output**: full
surface 30,567 bytes (FlightCheck and Weather's committed copies), John's
News' three-export pick 8,159 bytes, market-monitor's six-export pick 8,222
bytes, each `cmp`-equal to the file in that repo. So no stranded bump has cost
a consumer any bytes yet. It matters as a *mechanism*: `bin/vendor.mjs`
resolves the CLI from inside this package, so whatever this pin says is the
generator four apps run, and a pin that cannot move is a generator that cannot
be fixed.

## The gate

There is no aggregate gate script in this repo — no `npm run check`, no
`vendor:check`, no `version:check`, because a kit vendors nothing into itself
and stamps no constants. `test.yml` passes three commands to family-ci and
those three, run in this order after an install, are the local gate:

```
node --check index.js
npm run lint
npm test
```

| Step | What it is |
| --- | --- |
| `node --check index.js` | parses the one shipped module. Parsing, which is not analysis. |
| `npm run lint` | `eslint .` over the flat config's two scopes — `index.js` with browser+node globals, and `bin/**/*.mjs` + `*.mjs` (which is every test file and the config itself). Nothing first-party is unlinted. |
| `npm test` | `node --test test.mjs test-storage.mjs test-vendor.mjs test-consumers.mjs` — 37 + 33 + 10 + 4 = **84 cases**, green on 2026-09-22 |

Three properties of that chain matter more than the list:

- **`npm test` is not runnable from a bare checkout.** `test-vendor.mjs` and
  `test-consumers.mjs` spawn `bin/vendor.mjs`, which imports `@jfs/vendor-cli`
  — so with no `node_modules` present, 11 of the 84 cases fail with
  `ERR_MODULE_NOT_FOUND` (measured 2026-09-22). `npm install` (or `npm ci`)
  first, and that install needs network: the CLI is a GitHub git pin.
  `test.mjs` and `test-storage.mjs` are fully offline — no network, no DOM,
  and no real backoff waits (a few timeout cases arm real 5 ms timers; the
  default-timeout case uses node:test's mock timers).
- **Every CLI-driving case fails loudly without the CLI.** Until 2026-09-22
  two argument-validation cases asserted only a non-zero exit, which a missing
  module also produces, and one of them — then named `'--pick outside global'`
  — tested a rule vendor-cli retired in 0.12.0 and passed only because its
  pick name was not an export. Both now match the refusal's stderr, and the
  esm `--pick` path has a case of its own. Keep new cases that way: an
  exit-code-only assertion on this CLI is a check that cannot tell "refused
  for the right reason" from "never ran".
- **family-ci adds four checks no npm script here runs**, all from a checkout
  of vendor-cli's `main`: the kit-pin SHA pre-flight (`verify-kit-pins: true`),
  the shipped-dependency audit (`prod-audit: true`), the CLAUDE.md
  family-conventions check, and `maintenance-check: true`, which is both the
  family block at the bottom of this file and a mechanical re-check of the
  repo-specific half above it. "Green locally, red in CI" is usually one of
  these. From a sibling vendor-cli checkout they are
  `node <vendor-cli>/bin/check-kit-pins.mjs`,
  `npm audit --omit=dev --audit-level=high`,
  `node <vendor-cli>/bin/claude-md-sync.mjs --check`,
  `node <vendor-cli>/bin/maintenance-sync.mjs --check` and
  `node <vendor-cli>/tools/maintenance-doc-check.mjs`, run from this repo's
  root. The `vendor:sync`/`vendor:check` command-parity check skips here, by
  design: there are no such scripts.

**`prod-audit: true` is on as of 2026-09-22.** This kit's `dependencies` is
not empty — `@jfs/vendor-cli` sits there deliberately (see load-bearing,
below) and pulls esbuild, both of which a consumer installing this kit
installs — so `npm audit --omit=dev --audit-level=high` has real input here.
It reported `found 0 vulnerabilities` when it was turned on.

The kit-pin bump's `check-command` runs the same three commands. It used to
omit `npm run lint`, and that mattered more there than anywhere: a bump PR
opened with the default token fires no `pull_request` CI, so the in-workflow
check is the only gate its merge gets.

## This repo's cross-file invariants

Six are mechanized.

| Invariant | The halves | Gate |
| --- | --- | --- |
| A change to the shipped surface carries a version bump | `index.js`, `bin/` ↔ `package.json` `version` | family-ci's `version-guard-paths: index.js bin`, **on pull requests only**. Consumers pin by SHA and releases tag by version, so a shipped change without a bump ships two different SHAs under one label. A push straight to `main` is not guarded. |
| The `@jfs/vendor-cli` pin resolves on the remote | `package.json` `dependencies` | `verify-kit-pins: true`, before install, so a hand-edited SHA fails with a message instead of an opaque git-128 |
| The derived export surface covers every top-level `export` | `index.js` ↔ what the generator emits | the generator fails **closed by construction**: an export form its derivation does not understand stops generation rather than silently vanishing. `test-vendor.mjs` then asserts the global and cjs surface maps equal the derived names exactly. |
| `"sideEffects": false` is honest — no global is touched at import time | `package.json` ↔ `index.js` | implicit but real: `test-storage.mjs` imports `index.js` at module scope and installs its fake `localStorage` only inside each block, so a module-scope touch throws at import and takes the whole file down. There is no test *named* for this; if the import ever moves, the coverage goes with it. |
| The export surface still carries every name a consumer uses | `index.js` ↔ what FlightCheck, John's News, Weather and market-monitor import off their vendored copies, and the two `--pick` lists | `test-consumers.mjs` (2026-09-22), against a **snapshot** of the four consumers taken by a family grep. It fails a removal or rename here, before the tag, instead of in a consumer's `vendor:sync` (narrowing consumers) or at link time in its browser (full-surface ones). It also generates both narrowing consumers' exact `--pick` shapes and **imports** them, so a generator that exits 0 and emits a copy that throws at load fails here. A stale row fails only in the safe direction; the file's header says how to refresh it. |
| README's documented option defaults are what the code does | `README.md` ↔ `index.js` (`timeout` 12000, `retries` 2, `retryStatuses` `[429, 502, 503, 504]`, `retryBaseMs` 400, `jitter` 0.3, `respectRetryAfter` true) | the four `README defaults:` cases in `test.mjs` (2026-09-22). They read the numbers out of the README and drive `fetchWithRetry` / `fetchWithTimeout` with them — attempts, the exact backoff delays at full jitter, the retried status set over 400–599, Retry-After honoured, the timer armed — and a README the regexes cannot read fails rather than passes. A changed default reaches four apps' upstream call volume at their next re-vendor, which is why the number is documented at all. |

Four are **prose only**. These are the monthly sweep's work and the
mechanization backlog.

| Pair | Where | What drift costs |
| --- | --- | --- |
| `parseRetryAfter` here ↔ `_retryAfterMs` in `@jfs/netlify-kit` | two repositories, each pointing at the other in a comment | The twins share the `/^\d+$/` delta-seconds test and the "every HTTP-date names a month, so no letter means no date" guard — without which V8 reads `1.5` as Jan 2001 and `-5` as May 2001, both past, both clamping to zero delay: the retry storm the header exists to prevent. Two deliberate divergences must survive any reconciliation: this one clamps inside the parser at `RETRY_AFTER_CAP_MS`, netlify-kit's caller clamps at its own `capMs`; and this one treats a numeric `0` as "retry now" rather than as an absent header (#22). THIS half is pinned by `test.mjs`'s `parseRetryAfter: only RFC 9110 delta-seconds count as a number`; nothing pins that the two agree. **Still the most valuable mechanization on this list, and the hardest** — the halves are in different repos, neither vendors the other, so the gate would have to live in vendor-cli or be a hand-run differential. Re-checked by hand 2026-09-22: the digits test and the letter guard agree. |
| README's consumer recipes ↔ what consumers run | `README.md` ↔ their `package.json` | Fixed 2026-09-22: README showed only the full-surface ESM recipe and never mentioned `--pick` at all, though two of the four consumers vendor a narrowed ESM copy — the shape a generator bump can move by a byte. It now documents the narrowed recipe with John's News' actual pick list. Still prose: a consumer changing its recipe changes nothing here. |
| `engines.node: ">=18"` ↔ the Node anything actually runs | `package.json` ↔ family-ci's default | The four kits pass no `node-version-file` and carry no version file, so CI runs family-ci's default (22). Nothing tests the declared floor, and Node 18 has been end-of-life since April 2025. `index.js` needs nothing newer than 18 (`globalThis.fetch`, `AbortController`, `??`, one numeric separator), so this is a policy question, not a correctness one. The suite now uses node:test's mock timers (Node ≥ 20.4), which says nothing about the shipped module's floor. |
| CLAUDE.md's counts and case names ↔ the files | `CLAUDE.md` ↔ `test-storage.mjs` | Fixed 2026-09-22: the "patch by line, not by text" warning said the `const ls = installLocalStorage(makeFakeLocalStorage());` line appears SIXTEEN times; it is 17 verbatim, 20 bindings counting the three multi-line calls. The paragraph now says both and tells a reader to trust `grep -c` over the prose — the warning is the point, not the number. |

## What nothing watches

This kit calls nothing and is called by nothing at runtime. Its "upstreams" are
all *downstream*, which makes the list short and the failure modes quiet.

| Thing | How it fails | Watched by |
| --- | --- | --- |
| The `@jfs/vendor-cli` pin in `dependencies` | silently. It decides the generator four apps run. It is current as of 2026-09-22 (`3e9e174`, 0.21.7, delivered by hand as #30) and will fall behind the next time vendor-cli moves, for a reason no page reports | `kit-pin-bump.yml`, which does the work and cannot deliver it here — so: a session reading `auto/*`, or the family liveness monitor once its token exists |
| The four consumers' pins on this kit | silently. A consumer that stops bumping simply keeps an old copy; the tag here says nothing about what is deployed there | nothing in this repo. Reading their `package.json` is the only check. (`test-consumers.mjs` watches what they IMPORT, not which commit they pin.) |
| The browser contracts `index.js` assumes | silently, and only in a real browser: `globalThis.fetch`, `AbortController`, `localStorage` throwing rather than returning, and the **four** quota-error signals `isQuotaError` recognizes by name/code | `test-storage.mjs`'s hand-rolled fake, which models the contract this repo believes in. No consumer test and no CI here executes a real browser. |
| The consolidation this kit exists to finish | silently. Art-Gallery-, JFS-Sports and BearsMockDraft still carry their own client fetch-with-timeout layers and vendor no fetch-kit; the kit reaches four of the repos whose copies it was extracted to replace | nothing. README said "eight repos carry a slightly different copy" in the present tense, which read as eight consumers; it now says eight grew one and names the four that vendor this kit. `index.js`'s header already said "carried" and lists them — it is not wrong, and editing it would be a shipped-surface change for a comment. |
| GitHub's own deprecations in the shared workflows | loudly but harmlessly, and in a log nobody reads: every bump run ends `Node.js 20 is deprecated … peter-evans/create-pull-request@84ae59a2…` forced onto Node 24 | nothing here — that action is pinned in vendor-cli's reusable workflow, not in this repo. Fix it there. |
| The per-repo *Actions can create pull requests* setting | silently, exactly as documented above. Repo settings are not in git, so no gate in any repo can see this one | nothing |

The family's only automation that opens an issue on failure belongs to
market-monitor and covers its production endpoints. Nothing in the family
watches this repo.

A bug in a *vendored copy* is filed here, not fixed there: the copies are
generator output and are never edited by hand.

## Cost and quota exposure

Direct exposure is as close to zero as a repo gets. No deploy, no hosting, no
API key, no secret beyond the workflow token, and a suite that touches no
network once installed. The only recurring spend is GitHub Actions minutes
— four workflows, one weekly cron, one weekly Dependabot PR, one monthly
actions PR — and the bump runs die in 15–21 seconds, so even the broken one is
cheap.

The exposure that matters is **second-hand and unbounded from here.** Four
apps' client-side upstream call volume is decided by constants in this file:

- `DEFAULT_RETRIES = 2` — three attempts per call. Raising it multiplies every
  consumer's calls against rate-limited upstreams (Finnhub's 60/min, FlightAware's
  billed AeroAPI, Google Distance Matrix billed per element) at their next
  re-vendor, with nothing in this repo able to notice.
- `RETRY_AFTER_CAP_MS = 120000` — a hostile or misconfigured upstream can ask
  for two minutes and no more. Removing the cap lets it wedge a client for
  days.
- `DEFAULT_TIMEOUT_MS = 12000` and a `TimeoutError` that is **not retried by
  default** — a timeout means a slow upstream, and retrying compounds latency.
- `createCoalescer` — the only thing standing between a Refresh racing a poll
  tick and two identical billed calls.

So "does this change cost anybody money?" is a real review question here even
though this repo has no bill of its own.

## Generated and baked — never hand-edit

| File | Regenerated by | A hand edit costs |
| --- | --- | --- |
| the CLAUDE.md family-conventions block | `jfs-claude-md-sync` (@jfs/vendor-cli) | family CI's conventions check red — and it checks against vendor-cli `main`, not this repo's pin, so the text can go red without anything here changing |
| the family-maintenance block at the bottom of this file | `jfs-maintenance-sync` | `maintenance-check` red |
| `package-lock.json` | `npm install` after a pin move — which is exactly what the bump caller passes as its `vendor-sync-command` | a lockfile disagreeing with the pin; CI installs with `npm ci` in the bump path |

Nothing else here is generated. There is no stamped constant, no vendored copy,
no baked dataset and no data branch — this repo is the *source* of four other
repos' generated files, which is the inverse arrangement and the reason its
`version` field is hand-bumped rather than stamped.

## Deferred and stuck

| Dependency / item | Current → target | Verdict | Why | The condition that would change the answer |
| --- | --- | --- | --- | --- |
| Delivery of the weekly `@jfs/vendor-cli` bump | — | **STUCK on the owner** | Every run validates its bump and then fails at the PR step on `GitHub Actions is not permitted to create or approve pull requests` — a per-repo setting no commit can change. The 2026-09-22 bump (0.21.3 → 0.21.7) was delivered by a session opening #30 by hand from the stranded branch; it merged green and was byte-neutral for all four consumers. | The owner allows Actions to create PRs at <https://github.com/jsvolos63/fetch-kit/settings/actions>. Until then, each Monday: `git ls-remote --heads origin 'refs/heads/auto/*'`, and open the PR by hand. |
| `engines.node` | `">=18"` → `">=20"` or `">=22"` | **HOLD, but decide it deliberately once** | Node 18 is EOL (April 2025) and nothing tests the floor, but `index.js` genuinely runs on 18 and the declared floor is a promise to *consumers*, whose own floors differ. Raising it is a family-wide runtime decision, not this repo's. | The family settles a floor (the quarterly "runtime floor" item in the block below), or `index.js` needs an API newer than 18 — at which point the floor moves in the same commit. |
| `peter-evans/create-pull-request@84ae59a2…` targeting Node 20 | — | **not this repo's to fix** | It is pinned by SHA inside vendor-cli's reusable `kit-pin-bump.yml`; every bump run in the family warns (run 6 on 2026-09-22 still did). | GitHub removes the Node 20 forcing, or vendor-cli bumps the pin. File it there. |
| `index.js`'s header prose | — | **HOLD** | Nothing in it is false today (it says eight repos *carried* a copy), but any edit to `index.js` is a shipped-surface change: it needs a version bump, and it moves the bytes of both full-surface consumers' verbatim copies, so each must re-vendor and bump its own app version for a comment. | A real code change to `index.js` — fold prose fixes into that commit. |

No major dependency bump is outstanding: `npm outdated` is empty on
2026-09-22 (`eslint` 10.11.0, `@eslint/js` 10.0.1, `globals` 17.12.0, and the
`@jfs/vendor-cli` pin at vendor-cli HEAD), and there are zero open PRs.

## What looks like cruft and is load-bearing

- **`@jfs/vendor-cli` in `dependencies`, not `devDependencies`.** It looks like
  dev tooling in the wrong section. `bin/vendor.mjs` is a shim that runs
  whatever vendor-cli resolves from *inside this package*, and a consumer
  installing this kit gets its dependencies but not its devDependencies — move
  it and every consumer's `jfs-fetch-kit-vendor` has nothing to load.
- **`vendor-sync-command: npm install` and `version-bump-command: ''`** in the
  bump caller. They read like no-ops overriding sensible defaults. They are the
  fix for runs 1–3: the defaults are `npm run vendor:sync` and `npm run
  version:stamp`, which a kit does not have.
- **`version-guard-paths: index.js bin`**, not the whole repo. A README, a test
  or a workflow change must *not* force a version bump: consumers pin by SHA,
  and a version that moves without the shipped surface moving is a false
  signal.
- **The measured numbers in `index.js`.** `RETRY_AFTER_CAP_MS = 120000`,
  `MAX_ERROR_BODY = 2048`, `MAX_FUTURE_SKEW_MS = 60_000` (a far-future stamp is
  a poisoned entry, not a fresh one), `_MAX_DEPOLLUTE_DEPTH = 64`. Each has a
  test and a comment saying what it prevents.
- **The guards that look like paranoia.** `timeout: 0` meaning *no timer*
  rather than immediate abort; the `Number.isFinite(timeout) && timeout > 0`
  arm check; the negative-jitter clamp; `retries: -1` clamping to one attempt;
  tolerating a transient response with no `headers` object; cleaning up the
  timer *and* the external-signal listener when `fetchImpl` throws
  synchronously. Every one is a named case in `test.mjs`.
- **Two snapshot shapes and two freshness comparisons, kept apart on purpose.**
  `{at, payload}` fresh while `now - at <= maxAgeMs`; `{ts, data}` fresh while
  `now - ts < maxAgeMs`. Consumers adopted the absorbed cache-kit by changing
  import paths, and their users' *stored data* must keep parsing. Collapsing
  them into one shape is a data-loss change dressed as a simplification.
- **The pollution guard stripping `__proto__` and only `__proto__`.** Dropping
  `constructor` and `prototype` too — which this kit did before v0.3.0 — ate
  legitimate fields of those names silently. Both layers carry the same
  one-key list deliberately: a second pass deleting more would put the data
  loss back one layer down.
- **The 20 `const ls = installLocalStorage(...)` bindings in
  `test-storage.mjs`** (17 of them the identical one-line form). They look
  like a find-and-replace waiting to happen. `ls` is used in all of them;
  patch by line, not by text.
- **`no-regex-spaces: 'off'`** in `eslint.config.mjs`. The vendor suite matches
  a known two-space indent in generated output, where the literal reads better
  than `{2}`. The disabled list is one entry long in this kit; a second should
  feel like a decision.
- **`test-vendor.mjs` deriving its expectations from `index.js`'s own
  exports** rather than naming them. The same file ships in every kit; a
  hard-coded list would need editing on every API change, which is how it would
  come to be wrong.
- **`test-consumers.mjs`'s hand-written `CONSUMERS` table** — the one place
  this repo *does* keep a hard-coded list of names, and on purpose. It is not
  a list of what the kit offers (that stays derived) but a snapshot of what
  four other repos use, which nothing here could derive. Deleting a name from
  it to make a removal pass is exactly the change the test exists to stop:
  move the consumer first, then the row.

## Diagnosis — it is broken and I do not know why

Fastest-resolving first.

1. **`npm test` fails on 11 cases with `ERR_MODULE_NOT_FOUND`** (every case in
   `test-vendor.mjs` and `test-consumers.mjs` that spawns the CLI). There is no
   `node_modules`. Run `npm install` (needs network — the CLI is a git pin) and
   re-run. Nothing is wrong with the kit.
2. **CI red, the three local commands green.** Almost always one of the four
   checks family-ci adds and no npm script here runs (see "The gate" for how to
   run each by hand): the kit-pin SHA pre-flight, the shipped-dependency audit,
   the CLAUDE.md conventions block, or this file's family block and its
   doc-check. Read the failing step's name. The conventions and maintenance
   checks run against vendor-cli `main`, so they can go red with no commit here
   — that is the designed behavior, and re-syncing is the fix. An audit
   failure is an advisory in `@jfs/vendor-cli`'s tree (esbuild, today its only
   dependency): fix it at vendor-cli and let the pin follow, and use an
   `overrides` entry here only if that cannot happen.
3. **`test-consumers.mjs` fails, or a consumer's `vendor:sync` refuses with an
   unknown-pick name.** An export was renamed or removed here. The test's
   message names the consumer and the name. Their pick list is in their
   `package.json`, twice (`vendor:sync` and `vendor:check`); grep the four
   consumers before changing the surface, and remember a hit inside a vendored
   copy is the definition, not a use. A full-surface consumer (FlightCheck,
   Weather) never refuses anything — it regenerates cleanly and then fails to
   link in the browser, so the test is the only early warning for those two.
4. **A consumer's `vendor:check` shows byte drift with no change here.** The
   generator moved, not the kit. Compare the `@jfs/vendor-cli` pin in *this*
   package.json against what the consumer resolved, and note that only
   `--pick`-narrowed copies are reprinted by esbuild — a full surface is
   verbatim source and never shaken, so it cannot drift on a CLI bump.
5. **Nothing has bumped in weeks.** Expected until the owner flips the
   Actions setting, not a symptom:
   <https://github.com/jsvolos63/fetch-kit/actions/workflows/kit-pin-bump.yml>,
   then `git ls-remote --heads origin 'refs/heads/auto/*'` for the stranded
   branch, and open its PR by hand. Check the *run*, not whether `main` is
   green.
6. **A version shipped untagged.** `git ls-remote --tags origin` against
   `package.json`'s `version`. A bot-merged PR pushes with the default
   `GITHUB_TOKEN`, which creates no workflow runs, so `release.yml`'s
   `workflow_run` gate never fires; `workflow_dispatch` is the backfill. None
   is outstanding today.
7. **`gh` is not in this repo's `.claude/settings.json` allowlist.** Use the
   Actions pages or the GitHub API tools; `mcp__github__*` is allowed.

## Run log

| Date | Cadence | Outcome |
| --- | --- | --- |
| 2026-09-22 | Weekly + monthly sweep | **Weekly:** last scheduled `kit-pin-bump.yml` run (5, 09-21) failed at the PR step; run 6 (dispatched 09-22) failed the same way — the owner-only *Actions may create PRs* setting is still off. Its validated bump (vendor-cli `276274b` 0.21.3 → `3e9e174` 0.21.7) was opened by hand as #30 and merged green (`9b3b8aa`); no `auto/*` branch remains, zero open PRs, no bot PR aged or red. Test green on `main`; Release run 29 green (no new version to tag; `v0.3.0` = `package.json`). Pins: this kit's vendor-cli pin = vendor-cli HEAD; all four consumers pin `fe552a9` = `v0.3.0`, the last `index.js` change, so delivery is current. **Baseline gate** (npm ci, `node --check`, eslint, 75/75 tests, kit-pin pre-flight, claude-md and maintenance sync, doc-check, prod audit): all green before any change. **Fixed:** (1) `test-vendor.mjs`'s `'--pick outside global'` case now matches the unknown-pick stderr, and `--name is required and validated` likewise — both passed with no CLI installed; plus a new esm `--pick` case. (2) New `test-consumers.mjs`: a snapshot of what the four consumers import/pick, checked against the export surface, with both narrowing consumers' exact shapes generated and imported. (3) Four `README defaults:` cases in `test.mjs` drive the documented defaults (mutation-tested: each of retries, timeout, jitter, status set and an unreadable README fails). (4) `prod-audit: true` on in `test.yml` (0 vulnerabilities). (5) `kit-pin-bump.yml`'s `check-command` gains `npm run lint`. (6) CLAUDE.md's SIXTEEN → 17 verbatim / 20 bindings. (7) README: the ESM `--pick` recipe (it mentioned `--pick` nowhere, not "only under classic-script/CJS" as this file claimed), the present-tense "eight repos carry", and the test command. (8) This file: the stranded-branch and pin-lag text, test counts (84; 11 need the CLI), the invariants tables (six mechanized, four prose), the deferred table; and "no real timers" here, in README and in `test.mjs`'s header (a few timeout cases arm real 5 ms timers). **Majors:** none outstanding; `npm outdated` empty. **Advisories:** 0. **Upstreams:** none owned. **Delivery:** all four consumers' committed copies regenerate `cmp`-identical under the new pin, so #30 moved no consumer bytes. **Open:** the Actions setting (owner); the `parseRetryAfter` ↔ netlify-kit twin (cross-repo, re-checked by hand: agree); `engines.node` (family decision). No version bump: nothing under `index.js` or `bin/` changed. |
| 2026-09-22 | Maintenance plan (first) | Wrote this file's repo-specific half and opted `test.yml` into `maintenance-check: true`. Six things it turned up. (1) **The weekly bump has failed all five of its runs**, not four or five weeks' worth of one cause but two in sequence — runs 1–3 at step 7 on the `vendor:sync` default, runs 4–5 at step 11 on `GitHub Actions is not permitted to create or approve pull requests` — so #23's correct fix bought two more silent weeks. (2) The stranded bump is **byte-neutral**: generating the full surface and both consumers' `--pick` lists under 0.21.3 + esbuild 0.25.10 and 0.21.6 + esbuild 0.28.2 gives identical bytes in all three shapes, so it is a broken mechanism rather than a shipped defect. (3) **CLAUDE.md's "SIXTEEN times" is wrong** — 17 verbatim, 20 bindings; the warning it decorates is right. (4) `test-vendor.mjs`'s `'--pick outside global'` case tests a rule vendor-cli dropped in 0.12.0 and passes only because its pick name is not an export; confirmed by driving the real CLI. (5) README documents `--pick` only for classic-script and CJS consumers, but **two of the four ESM consumers use it** — precisely the copies a generator bump can move. (6) `prod-audit` is not passed although `dependencies` is non-empty and pulls esbuild; the audit reports clean today. Verified green: `node --check`, `eslint .`, 75/75 tests, the CLAUDE.md conventions block in sync, `v0.3.0` tagged and released, zero open PRs, and all four consumers pinned at `fe552a9` with every picked export still present. |

<!-- maintenance-check:allow
npm run vendor:sync    # named only to record that a kit vendors nothing into itself and has no such script — the bump caller passes `npm install` in its place
npm run vendor:check   # same absence; there is no vendored copy here to check for drift
npm run version:stamp  # named only to record that a kit's version is hand-bumped, with no stamped constants to propagate it into
npm run version:check  # same: nothing to check a stamp against
npm run check          # named only to record that this repo has no aggregate gate script, unlike the app repos
-->

<!-- jfs-family-maintenance:start — managed by jfs-maintenance-sync; edit family/maintenance.md in @jfs/vendor-cli -->

## Family maintenance protocol

This section is identical across every repo in the @jfs family. It is managed
by `jfs-maintenance-sync` (@jfs/vendor-cli) and checked by family CI — edit
`family/maintenance.md` in the vendor-cli repo, not here.

It covers what is true of **every** repo. What is true of THIS one — its
automation inventory, its upstreams, its invariants, its diagnosis ladder — is
the repo-specific half of this file, above.

### What the automation does, and what it deliberately leaves

Four reusable workflows in `@jfs/vendor-cli` carry the whole family's upkeep.
A repo calls the ones that apply to it:

| Workflow | Fires | Lands by itself | Leaves for a session |
| --- | --- | --- | --- |
| `family-ci.yml` | every push, every PR, `workflow_dispatch` | — it *is* the gate | nothing |
| `dependabot-merge.yml` | when CI completes on a Dependabot PR | every bump that is minor or patch, squash-merged on green | **every major**, and any PR body it can't parse |
| `kit-pin-bump.yml` | weekly, Mondays ~06:41 UTC | the `@jfs/*` pins, the re-vendor, the CLAUDE.md conventions block, the version bump | nothing, when it works |
| `release.yml` | CI green on `main` | the `v<version>` tag and its GitHub release | nothing |

Three gaps follow from that table and they are the whole reason this protocol
exists. They are not oversights; each is a deliberate refusal to automate a
judgement call, and each therefore needs a cadence instead.

**1. Majors accumulate, and the backlog is not inert.** A major is a
judgement, not a merge, so `dependabot-merge.yml` leaves it open. Nothing
schedules the session that makes the judgement, and `.github/dependabot.yml`
caps open PRs. Once the cap is full of unreviewed majors, the weekly
minor/patch PR — the one the automation *does* land — stops being opened at
all. The backlog turns from a to-do list into a block on the working half of
the pipeline.

**2. CI cannot check prose, or anything whose halves live in different
files.** Every repo's gate parses what it ships, lints it, regenerates the
vendored copies, checks the version stamp and runs the suite. None of that
notices that CLAUDE.md describes a module that moved, or that a value added to
one file has no matching entry in the two others that must agree with it. The
family's answer is the same every time and it is worth repeating: **an
invariant whose halves live in different files belongs in a test, not a
comment.** Prose does not hold. Where a cross-file rule is still only written
down, the monthly sweep is what checks it, and mechanizing it is the standing
work.

**3. Nothing watches the upstreams.** Every feed, API, scraped page and
published dataset belongs to somebody else, and these apps fail soft by
design: an upstream that 404s, moves, rate-limits the deploy's egress IP or
starts answering with a bot wall yields less content, one line in a
diagnostics payload, and a green CI run. The only way to notice is to look.

And one standing limitation that applies to every repo here: **the suites fake
the network.** That is what makes them fast, offline and safe to run
air-gapped, and it is exactly why a breaking change in a client library or an
upstream's payload shape ships green. A green suite is evidence about this
repo's code. It is never evidence about its dependencies' behaviour, and never
evidence that the deploy works.

### Who watches the watchers

The automation above is what makes fourteen repos maintainable with the owner
away, which makes a silent failure *in the automation* the highest-severity
failure mode in the family — and until this protocol existed, nothing watched
it at all.

The failure is not hypothetical and it is not rare. A `workflow_run` that
fails on a schedule produces no issue, no comment and no message anyone reads;
it leaves a red mark on a page nobody opens. Measured on 2026-09-22: the
weekly kit-pin bump had failed on **every** scheduled run for four to five
weeks in four repos, from two unrelated causes, with no signal of any kind.
Three of them had pushed a correct bump to an `auto/kit-pin-bump` branch that
no pull request was ever opened for. One patch release of the vendoring
generator had gone unvendored family-wide as a result — the same class of
failure the vendor-cli notes already record happening once before, fixed at
the source, and recurred by a different mechanism.

So the weekly check below is not optional hygiene. It is the one cadence that
protects every other cadence, and it asks four questions:

1. **Did each scheduled workflow's last run succeed?** Not "is `main` green" —
   a scheduled run fails on its own page. Check the run, not the branch.
2. **Is there a stranded `auto/*` branch?** A branch with commits and no open
   PR means the automation did its work and could not deliver it. On any repo:
   `git ls-remote --heads origin 'refs/heads/auto/*'` against the open PR list.
3. **Are the `@jfs/*` pins actually current?** A repo whose pins sit behind
   every sibling's is a repo whose bump is not landing, whatever its workflow
   page says. Compare the pins across repos, not against hope.
4. **Is any bot PR older than seven days, red, or conflicted?**

A clean week needs no action. Say so and stop.

### The cadences

#### Every change — before the push

These are the existing rules, restated so the protocol is complete in one
place:

- Run the repo's own gate command — the same steps CI runs, so the two cannot
  drift. Push only once it is clean.
- Bump the version and run the stamper whenever a **shipped asset** changes.
  Every app here serves its shell from a versioned service-worker cache, so a
  missed bump leaves returning visitors on the stale build — the exact failure
  the family flow exists to prevent. A change that never reaches the browser
  needs no bump.
- Never hand-edit generated output: a vendored kit copy, a stamped constant, a
  baked dataset. Bump the pin and re-run the generator; the copies are
  reviewed as bundler output, not as source.
- A new external resource changes the CSP, in **every** file that declares one.
- Docs change in the commit that makes them wrong, not in a later sweep.
- Open the PR ready for review, dispatch CI, and merge on green — a
  session-pushed branch fires no `pull_request` workflows, so a dispatched run
  on the head commit is the only gate there is.

#### Weekly — pipeline hygiene (~10 minutes)

The four questions under "Who watches the watchers". Nothing else.

#### Monthly — the sweep (~1 hour)

Work the sections in this order, because each one's output feeds the next:

1. **Cross-file drift** — fix first. A failure means two files that must agree
   no longer do, and where the check is gated, CI is already red.
2. **Dependency currency** — every outstanding major goes through the triage
   below. Record the verdict; do not re-derive last month's no.
3. **Advisories** — a high or critical in a *shipped* dependency already has
   CI red where the prod-audit gate is on. When no version bump resolves it —
   an upstream pinning a vulnerable transitive exactly — an `overrides` entry
   is the family's escape hatch.
4. **Upstreams** — probe the ones this repo owns a probe for, and read the
   result against its documented caveats. A datacenter IP gets a correct 403
   from Cloudflare-fronted hosts; the probe reports it and cannot tell you
   which it is.
5. **Delivery** — confirm the version being served is the one that shipped.
   See "Green CI is not delivered".
6. Add a row to the run log at the bottom of this file.

#### Quarterly, or whenever a signal says so

- **Runtime floor.** `engines.node` (or the language equivalent) against what
  upstream still supports and against the floors the outstanding majors
  demand. This is the single decision that most often unblocks a stuck major
  backlog, and it is a runtime decision before it is a dependency one.
- **Platform.** The function runtime, the bundler, the header set, the actions
  pinned by SHA — a pinned third-party action ages into a deprecated runner.
- **Security re-read.** The SSRF guards, the rate limits, the origin gates,
  what the public diagnostics endpoint discloses, and whether every key is
  still scoped, spend-limited and rotatable.
- **Upstream inventory.** Not "does it answer" but "is it still the right
  source" — a feed that died, a sanctioned route that now exists where a proxy
  was used, a pinned figure that has rotted.

### Major-bump triage

"Does CI pass?" is the wrong question for a major, because the suite fakes the
network. Work these in order and stop at the first step that says hold.

**1. Inventory the call sites.** Grep the import; read every use. Most majors
turn out not to touch the API this repo actually calls. Write down what you
depend on before reading a single release note.

**2. Check the engine floor** against the runtimes that really execute the
code — not only the declared floor, but the function runtime, the build image
and whatever the local entry point runs. A major that raises the floor is a
runtime decision first. Decide the floor, then come back.

**3. Prove it, at the bar the dependency's class demands.**

| Class | What counts as proof |
| --- | --- |
| Pure JS the suite really exercises | the repo's gate command |
| Native module | a scratch script reproducing this repo's *exact* usage against the new version — and whether it installed a prebuilt binary or compiled from source, which changes CI time and can fail on the build image |
| A client the suite **fakes** | nothing the suite can say. Diff the real export surface between the versions and read the call sites by hand |
| Browser-shipped | whatever gate executes the real module graph — a link error is invisible to a linter and arrives as `undefined` under a bundler-transformed test runner |

**4. Land it.** One major per PR unless they are genuinely independent and all
trivially verified. Bump the version only if a shipped asset changed — a
dependency bump that touches nothing shipped must not churn the
service-worker cache name.

**5. Or hold it — visibly.** A major that should not land gets a row in this
file's deferred table, with the reason and **the condition that would change
the answer**. The bot keeps the PR open either way; the table is what stops
the next session spending an hour re-deriving the same no.

### Green CI is not delivered

CI going green means the code is sound. It does not mean anyone received it.
The deploy is a second gate, it runs after CI, and it can fail on its own —
and when it does, nothing breaks and nothing says so: the platform keeps
serving the last good build, the stamped version never moves, no update pill
ever appears, and the change is simply absent for everyone. That is the same
shape as a stale dataset — every automated check green, the product quietly
not doing the new thing.

So after a merge, confirm that the build being served is the one that shipped:
compare the version in the repo against the version the live site reports and
against the one its service worker carries. Three agreeing numbers is delivery
confirmed. The last two lagging the first means the deploy failed or has not
finished.

### What a maintenance session must not do

- **Do not "clean up" a load-bearing irregularity.** Every repo here carries
  measured numbers, deliberate fallback orderings and odd-looking guards that
  encode a bug already paid for. Each repo lists its own above; the rule is
  that an oddity with a comment recording a measurement is evidence, not
  cruft. Simplify the interior freely. Before simplifying anything that
  touches a boundary, make sure that boundary's checks exist and pass.
- **Do not weaken a gate to make it pass.** A skipped test, a loosened
  assertion and a silenced linter rule all read as green. If a check is wrong,
  fix or delete it deliberately and say why; if it is right, fix the code.
- **Do not let a check pass quietly when it could not run.** "Could not check"
  must never be reportable as "fine" — the one failure mode that makes a
  monitor worse than no monitor. Keep the exit codes distinct.
- **Do not extract a kit to solve a duplication.** The bar is a third
  consumer *and* drift that has already caused a real bug or a manual
  reconciliation. Prefer growing an existing kit.

### The run log

Every sweep ends with a row in the repo-specific run log: the date, the
cadence, and what was actually found and done — including "clean". A sweep
that leaves no trace is a sweep the next session will repeat from scratch, and
the log is the only record of why a held major is still held.

<!-- jfs-family-maintenance:end -->
