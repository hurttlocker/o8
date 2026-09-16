// The ship redirects O8_DATA_DIR at a throwaway build directory so the release
// cannot touch the operator's live runtime state. The publish step, which runs
// as a child of that workflow, resolved the external intake read token from the
// same variable — so it looked inside the empty build directory, reported the
// credential unconfigured, and skipped reconciling every report filed by anyone
// other than the maintainer. Observed on the v0.1.755 ship with the token
// correctly installed at ~/.o8/discord-bot-token.
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

// @ts-expect-error — plain .mjs build script, no types
import { buildWorkflowEnv } from '../scripts/lib/ship-broadcast.mjs';
// @ts-expect-error — plain .mjs build script, no types
import { inspectIntakeReconciliation } from '../scripts/lib/intake-reconciliation.mjs';
// @ts-expect-error — plain .mjs build script, no types
import { syncReports } from '../scripts/sync-reports.mjs';

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function tempDir(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

/** A real 0600 token file, the way the operator installs it. */
function operatorDirWithToken(token = 'test-intake-token') {
  const dir = tempDir('o8-operator-data-');
  const file = join(dir, 'discord-bot-token');
  writeFileSync(file, token, { mode: 0o600 });
  chmodSync(file, 0o600);
  return dir;
}

describe('ship workflow environment and the external intake credential', () => {
  it('redirects the data dir for the build but still names the operator dir', () => {
    const operator = operatorDirWithToken();
    const build = tempDir('o8-release-build-data-');

    const env = buildWorkflowEnv(build, { O8_DATA_DIR: operator, HOME: '/nonexistent' });

    expect(env.O8_DATA_DIR).toBe(build);
    expect(env.CORTEX_IDE_DATA_DIR).toBe(build);
    expect(env.O8_OPERATOR_DATA_DIR).toBe(operator);
  });

  it('resolves the credential under the environment a ship step actually runs in', () => {
    const operator = operatorDirWithToken();
    const build = tempDir('o8-release-build-data-');
    const env = buildWorkflowEnv(build, { O8_DATA_DIR: operator, HOME: '/nonexistent' });

    expect(inspectIntakeReconciliation({ env })).toMatchObject({
      status: 'configured',
      source: 'runtime-file',
    });
  });

  it('carries the token through syncReports to the intake request', async () => {
    const operator = operatorDirWithToken('token-for-the-request');
    const build = tempDir('o8-release-build-data-');
    const env = {
      ...buildWorkflowEnv(build, { O8_DATA_DIR: operator, HOME: '/nonexistent' }),
      O8_FEEDBACK_CHANNEL_ID: '1543781637546844210',
    };

    const seen: { url: string; authorization: string | null }[] = [];
    const fetchImpl = async (url: string | URL, init?: { headers?: Record<string, string> }) => {
      seen.push({
        url: String(url),
        authorization: init?.headers?.Authorization ?? null,
      });
      return { ok: true, status: 200, json: async () => [] } as unknown as Response;
    };

    const previous = process.env.O8_DATA_DIR;
    process.env.O8_DATA_DIR = build; // keep the ledger read inside the fixture
    try {
      await syncReports({ dryRun: true, env, fetchImpl });
    } finally {
      if (previous === undefined) delete process.env.O8_DATA_DIR;
      else process.env.O8_DATA_DIR = previous;
    }

    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0].url).toContain('/channels/1543781637546844210/messages');
    expect(seen[0].authorization).toBe('Bot token-for-the-request');
  });

  // The regression guard: without the operator pointer the lookup lands in the
  // empty build directory, which is exactly what shipped.
  it('reports the credential missing when only the build dir is named', () => {
    const operator = operatorDirWithToken();
    const build = tempDir('o8-release-build-data-');
    const shipEnv = buildWorkflowEnv(build, { O8_DATA_DIR: operator, HOME: '/nonexistent' });
    const { O8_OPERATOR_DATA_DIR: _dropped, ...withoutPointer } = shipEnv;

    expect(inspectIntakeReconciliation({ env: withoutPointer })).toMatchObject({
      status: 'missing',
      reason: 'the external intake read credential is not configured',
    });
  });
});
