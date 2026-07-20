import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

const originalHome = process.env.HOME;
const home = mkdtempSync(join(os.tmpdir(), 'o8-product-telemetry-entry-'));
const dataDir = join(home, '.o8');
mkdirSync(dataDir, { recursive: true });
process.env.HOME = home;
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_DATA_DIR = dataDir;
process.env.O8_PROXY_URL = 'https://telemetry.example.test';
writeFileSync(join(dataDir, 'entitlement.json'), JSON.stringify({ licenseKey: 'header.payload.signature' }));

const { updateOperatorDefaults } = await import('@/lib/operator/defaults');
const { addRepo } = await import('@/lib/repos/registry');
const { createLane } = await import('@/lib/lane/registry');
const { launchSession } = await import('@/lib/lane/commands-launch');
const runtimeActions = await import('@/lib/runtime/actions');

function makeRepo(name: string): string {
  const repoPath = mkdtempSync(join(home, `${name}-`));
  execFileSync('git', ['init', '-q', '-b', 'main', repoPath]);
  return repoPath;
}

function telemetryCalls(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/v1/telemetry'));
}

afterEach(async () => {
  await updateOperatorDefaults({ productTelemetryEnabled: false });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

afterAll(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(home, { recursive: true, force: true });
});

describe.sequential('product telemetry gates real entry points', () => {
  it('repo registration emits nothing while off and one allowlisted event while on', async () => {
    const fetchMock = vi.fn(async () => Response.json({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    await updateOperatorDefaults({ productTelemetryEnabled: false });
    await addRepo(makeRepo('repo-off'));
    expect(telemetryCalls(fetchMock)).toHaveLength(0);

    await updateOperatorDefaults({ productTelemetryEnabled: true });
    await addRepo(makeRepo('repo-on'));
    expect(telemetryCalls(fetchMock)).toHaveLength(1);
    expect(telemetryCalls(fetchMock)[0]?.[1]).toMatchObject({
      body: JSON.stringify({ event: 'repo.added', props: { hasRemote: false, isGitRepo: true } }),
    });
  });

  it('dispatch launch emits nothing while off and one allowlisted event while on', async () => {
    const fetchMock = vi.fn(async () => Response.json({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    const launchSpy = vi.spyOn(runtimeActions, 'launchRuntimeSurface').mockImplementation(async (input) => ({
      ok: true,
      runtime: input.runtime,
      surfaceId: `codex-owned:${input.existingLaneId ?? 'telemetry'}`,
      note: 'launched',
      cwd: input.repoPath ?? home,
      repoPath: input.repoPath ?? home,
      worktree: null,
      laneId: input.existingLaneId ?? null,
    }));

    const launch = async (suffix: string) => {
      const repoPath = makeRepo(`dispatch-${suffix}`);
      const lane = createLane({
        repoPath,
        branch: `inline/telemetry-${suffix}`,
        baseBranch: 'main',
        runtime: 'codex',
      });
      const result = await launchSession({
        verb: 'launch_session',
        laneId: lane.id,
        prompt: 'bounded test prompt',
      }, 'system');
      expect(result.ok).toBe(true);
    };

    await updateOperatorDefaults({ productTelemetryEnabled: false });
    await launch('off');
    expect(telemetryCalls(fetchMock)).toHaveLength(0);

    await updateOperatorDefaults({ productTelemetryEnabled: true });
    await launch('on');
    expect(telemetryCalls(fetchMock)).toHaveLength(1);
    expect(telemetryCalls(fetchMock)[0]?.[1]).toMatchObject({
      body: JSON.stringify({ event: 'dispatch.started', props: { runtime: 'codex' } }),
    });
    expect(launchSpy).toHaveBeenCalledTimes(2);
  });
});
