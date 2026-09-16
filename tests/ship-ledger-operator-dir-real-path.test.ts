// #2387 fixed the intake CREDENTIAL lookup under the ship's data-dir isolation.
// The ledger and the cumulative manifest resolved the same way and were still
// broken: the publish step runs as a child of the ship's workflowEnv, where
// O8_DATA_DIR points at a build directory runShipWorkflow deletes in its
// finally block. So readLedger/readPublished read an empty directory and
// writePublished wrote into one about to be removed.
//
// Observed on v0.1.755: the operator's real published.json was 8737 bytes,
// last written months earlier, while the fixed.json shipped with the release
// was 77 bytes and the log said "0 fixed reports, 0 new this release".
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// @ts-expect-error — plain .mjs build script, no types
import { buildWorkflowEnv } from '../scripts/lib/ship-broadcast.mjs';
// @ts-expect-error — plain .mjs build script, no types
import { buildManifest, feedbackDir, ledgerPath, publishedPath, readPublished } from '../scripts/lib/fixed-reports.mjs';

const roots: string[] = [];
let savedEnv: Record<string, string | undefined>;

const ENV_KEYS = ['O8_DATA_DIR', 'CORTEX_IDE_DATA_DIR', 'O8_OPERATOR_DATA_DIR'];

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k]!;
  }
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function tempDir(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

/** Apply an env the way a spawned ship step receives it. */
function applyEnv(env: Record<string, string>) {
  for (const k of ENV_KEYS) {
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
}

function shipEnv(operator: string, build: string) {
  return buildWorkflowEnv(build, { O8_DATA_DIR: operator, HOME: '/nonexistent' }) as Record<
    string,
    string
  >;
}

describe('publish-side feedback paths under the ship environment', () => {
  it('resolves the ledger and manifest inside the operator dir, not the build dir', () => {
    const operator = tempDir('o8-operator-data-');
    const build = tempDir('o8-release-build-data-');
    applyEnv(shipEnv(operator, build));

    expect(feedbackDir().startsWith(operator)).toBe(true);
    expect(ledgerPath().startsWith(operator)).toBe(true);
    expect(publishedPath().startsWith(operator)).toBe(true);
    expect(ledgerPath().startsWith(build)).toBe(false);
    expect(publishedPath().startsWith(build)).toBe(false);
  });

  it('keeps fixed.json cumulative across releases', () => {
    const operator = tempDir('o8-operator-data-');
    const build = tempDir('o8-release-build-data-');

    // A fix published by an EARLIER release, sitting in the operator's dir.
    mkdirSync(join(operator, 'feedback'), { recursive: true });
    writeFileSync(
      join(operator, 'feedback', 'published.json'),
      JSON.stringify({
        fixed: [{ id: 'ABC123', title: 'Earlier fix', version: '0.1.700' }],
      }),
      'utf8',
    );

    applyEnv(shipEnv(operator, build));

    const priorEntries = readPublished();
    expect(priorEntries).toHaveLength(1);

    const manifest = buildManifest(
      [...priorEntries, { id: 'DEF456', title: 'This release', version: '0.1.756' }],
      new Date().toISOString(),
      { status: new Map(), reports: new Map() },
    );

    const ids = manifest.fixed.map((entry: { id: string }) => entry.id);
    expect(ids).toContain('ABC123'); // the earlier release's fix survives
    expect(ids).toContain('DEF456');
  });

  // The regression guard: the pre-fix shape, where only the build dir is named,
  // puts everything inside the directory the ship deletes and reads back an
  // empty manifest even though the operator's real one is sitting there.
  it('falls back into the build dir when the operator dir is not named', () => {
    const operator = tempDir('o8-operator-data-');
    const build = tempDir('o8-release-build-data-');

    mkdirSync(join(operator, 'feedback'), { recursive: true });
    writeFileSync(
      join(operator, 'feedback', 'published.json'),
      JSON.stringify({
        fixed: [{ id: 'ABC123', title: 'Earlier fix', version: '0.1.700' }],
      }),
      'utf8',
    );

    const env = shipEnv(operator, build);
    delete (env as Record<string, string | undefined>).O8_OPERATOR_DATA_DIR;
    applyEnv(env as Record<string, string>);

    expect(publishedPath().startsWith(build)).toBe(true);
    // The operator's history is right there and this resolution cannot see it.
    // That blindness is the whole bug; if this ever returns the seeded entry,
    // the precedence has been reordered and the fix above is gone.
    expect(readPublished()).toEqual([]);

    applyEnv(shipEnv(operator, build));
    expect(readPublished()).toHaveLength(1);
  });
});
