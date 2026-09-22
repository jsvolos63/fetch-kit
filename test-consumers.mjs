// The export surface against the four apps that vendor this kit.
//
// Nothing else in this repo knows what a consumer imports, and removing or
// renaming an export here is a breaking change this repo's CI could not see:
// a full-surface consumer (FlightCheck, Weather) regenerates cleanly and then
// fails to LINK in the browser — blank page — while a narrowing consumer
// (John's News, market-monitor) has its `vendor:sync` refuse an unknown pick.
// Either way the failure lands in their CI, on their schedule, after this
// kit's release is tagged.
//
// CONSUMERS below is a SNAPSHOT of what each app imports off its vendored copy
// and, for the two that narrow, its `--pick` list — taken by grepping every
// repo (a hit inside a vendored copy is the definition, not a use; exclude
// those). It is not a source of truth about the consumers; it is the tripwire
// that makes a surface change stop here and ask. When a test below fails:
//
//   - you removed or renamed an export somebody uses: grep the family, and
//     land the consumer's change first;
//   - or a consumer stopped using a name: re-grep, then update its row.
//
// A stale row can only fail in the safe direction (it blocks a removal until
// someone looks). It can NOT see a consumer that starts importing a new name,
// which is harmless here: that consumer's own module-graph gate covers it.
//
// The narrowed builds are also generated and IMPORTED, not just parsed. The
// vendoring generator's worst historical failure mode was exit 0, a plausible
// file, and a ReferenceError at load in the consumer — invisible to their
// `vendor:check`, because regeneration repeats the bug. Loading the exact
// shapes they ship is the cheapest place to catch that.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as kit from './index.js';

const KIT_DIR = dirname(fileURLToPath(import.meta.url));
const BIN = join(KIT_DIR, 'bin', 'vendor.mjs');

// Snapshot of 2026-09-22 (all four pin fe552a9 = v0.3.0). `imports` is every
// name the app's own source imports off the vendored copy; `pick` is the
// `--pick` list in its package.json (both vendor:sync and vendor:check), or
// null for a full-surface copy.
const CONSUMERS = [
  {
    repo: 'FlightCheck',
    out: 'src/vendor/fetch-kit/index.js',
    pick: null,
    imports: ['createCoalescer', 'fetchWithRetry', 'HttpError', 'TimeoutError', 'lsGet', 'lsSet', 'lsRemove'],
  },
  {
    repo: 'Weather',
    out: 'fetch-kit/index.js',
    pick: null,
    imports: ['HttpError', 'sleep', 'fetchJson', 'fetchText', 'saveSnapshot', 'readSnapshot'],
  },
  {
    repo: "John's News",
    out: 'vendor/fetch-kit/index.js',
    pick: ['fetchJson', 'fetchText', 'HttpError'],
    imports: ['fetchJson', 'fetchText', 'HttpError'],
  },
  {
    repo: 'market-monitor',
    out: 'js/vendor/fetch-kit/index.js',
    pick: ['createCoalescer', 'fetchWithTimeout', 'safeSetItem', 'writeTtlJson', 'readTtlJson', 'readTtlJsonTimestamp'],
    imports: ['createCoalescer', 'fetchWithTimeout', 'safeSetItem', 'writeTtlJson', 'readTtlJson', 'readTtlJsonTimestamp'],
  },
];

function freshDir() {
  const dir = mkdtempSync(join(tmpdir(), 'consumer-test-'));
  process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('every name a consumer imports or picks is still exported', () => {
  const missing = [];
  for (const c of CONSUMERS) {
    for (const name of new Set([...c.imports, ...(c.pick || [])])) {
      if (!(name in kit)) missing.push(`${c.repo} (${c.out}) uses \`${name}\``);
    }
  }
  assert.deepEqual(
    missing,
    [],
    'removing or renaming these breaks a consumer at its next re-vendor — grep the family and move the consumer first',
  );
});

test('the snapshot is self-consistent: a narrowing consumer picks everything it imports', () => {
  for (const c of CONSUMERS) {
    if (!c.pick) continue;
    const unpicked = c.imports.filter((name) => !c.pick.includes(name));
    assert.deepEqual(unpicked, [], `${c.repo} imports names its --pick list leaves out (a ReferenceError at load)`);
  }
});

for (const c of CONSUMERS.filter((x) => x.pick)) {
  test(`${c.repo}'s narrowed esm copy generates, loads, and exposes exactly its picks`, async () => {
    const dir = freshDir();
    // .mjs so Node loads it as ESM whatever the temp dir's package scope says.
    const file = join(dir, 'narrowed.mjs');
    const r = spawnSync(process.execPath, [BIN, '--format', 'esm', '--pick', c.pick.join(','), '--out', file], {
      cwd: dir,
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, r.stderr);

    const mod = await import(pathToFileURL(file).href);
    assert.deepEqual(Object.keys(mod).sort(), [...c.pick].sort(), 'the narrowed copy must expose exactly the pick list');
    for (const name of c.pick) {
      assert.equal(typeof mod[name], typeof kit[name], `${name} must survive narrowing as the same kind of value`);
    }
  });
}
