import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const roots: string[] = [];
const releaseScript = join(process.cwd(), 'scripts/release.mjs');
const version = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')).version;

interface Fixture {
  root: string;
  planPath: string;
  broadcastPath: string;
  broadcastLog: string;
  cleanupLog: string;
  stageLog: string;
  envLog: string;
  channelLog: string;
}

function makeFixture(options: {
  failAlwaysCleanup?: boolean;
  failMirror?: boolean;
  failNotary?: boolean;
  failPreflight?: boolean;
} = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'o8-release-broadcast-'));
  roots.push(root);
  const stageStub = join(root, 'stage-stub.mjs');
  const broadcastPath = join(root, 'o8-stub.mjs');
  const broadcastLog = join(root, 'broadcast.jsonl');
  const cleanupLog = join(root, 'cleanup.log');
  const stageLog = join(root, 'stages.log');
  const envLog = join(root, 'env.json');
  const channelLog = join(root, 'channels.jsonl');
  const planPath = join(root, 'plan.json');

  writeFileSync(stageStub, `
import { appendFileSync } from 'node:fs';
const stage = process.argv[2];
appendFileSync(process.env.O8_STUB_STAGE_LOG, stage + '\\n');
appendFileSync(process.env.O8_STUB_CHANNEL_LOG, JSON.stringify({ stage, channel: process.env.O8_RELEASE_CHANNEL ?? 'stable' }) + '\\n');
if (stage === 'preflight' && process.env.O8_STUB_FAIL_PREFLIGHT === '1') process.exit(29);
if (stage === 'build') {
  appendFileSync(process.env.O8_STUB_ENV_LOG, JSON.stringify({
    modern: process.env.O8_DATA_DIR,
    legacy: process.env.CORTEX_IDE_DATA_DIR,
  }));
}
if (stage.endsWith('cleanup')) {
  appendFileSync(process.env.O8_STUB_CLEANUP_LOG, stage + '\\n');
  if (process.env.O8_STUB_FAIL_CLEANUP === '1') process.exit(19);
}
if (stage === 'notarize') {
  console.log('[sign-and-notarize] zipping for notarization');
  console.log('[sign-and-notarize] submitting to Apple notary (stub)');
  if (process.env.O8_STUB_FAIL_NOTARY === '1') process.exit(17);
  console.log('[sign-and-notarize] done. app and DMG are notarized; now run scripts/release.mjs to publish');
}
if (stage === 'publish') {
  console.log('[release] published v${version}');
  if (process.env.O8_STUB_FAIL_MIRROR === '1') {
    console.error('[release-mirror] failed to mirror v${version} to stub/releases');
    process.exit(0);
  }
  console.log('[release-mirror] mirrored v${version} to stub/releases');
}
`);
  writeFileSync(broadcastPath, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
appendFileSync(process.env.O8_TEST_BROADCAST_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
if (process.env.O8_STUB_FAIL_BROADCAST === '1') process.exit(23);
`);
  chmodSync(broadcastPath, 0o755);

  const command = (stage: string, env: Record<string, string> = {}) => ({
    command: process.execPath,
    args: [stageStub, stage],
    env,
  });
  writeFileSync(planPath, JSON.stringify({
    preflight: command('preflight', options.failPreflight ? { O8_STUB_FAIL_PREFLIGHT: '1' } : {}),
    prepare: [],
    build: command('build'),
    notarize: command('notarize', options.failNotary ? { O8_STUB_FAIL_NOTARY: '1' } : {}),
    publish: command('publish', options.failMirror ? { O8_STUB_FAIL_MIRROR: '1' } : {}),
    alwaysCleanup: [
      command('always-cleanup', options.failAlwaysCleanup ? { O8_STUB_FAIL_CLEANUP: '1' } : {}),
    ],
    successOnlyCleanup: [
      command('success-cleanup'),
    ],
  }));

  return { root, planPath, broadcastPath, broadcastLog, cleanupLog, stageLog, envLog, channelLog };
}

function runRelease(fixture: Fixture, failBroadcast = false, preview = false) {
  if (preview) writeFileSync(join(fixture.root, 'package.json'), JSON.stringify({ version: '0.1.741-preview.1' }));
  return spawnSync(process.execPath, [releaseScript, '--ship'], {
    cwd: preview ? fixture.root : process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      O8_RELEASE_TEST_MODE: '1',
      O8_RELEASE_TEST_PLAN: fixture.planPath,
      O8_RELEASE_BROADCAST_CLI: fixture.broadcastPath,
      O8_RELEASE_BROADCAST_TIMEOUT_MS: '1000',
      O8_TEST_BROADCAST_LOG: fixture.broadcastLog,
      O8_STUB_CLEANUP_LOG: fixture.cleanupLog,
      O8_STUB_STAGE_LOG: fixture.stageLog,
      O8_STUB_ENV_LOG: fixture.envLog,
      O8_STUB_CHANNEL_LOG: fixture.channelLog,
      O8_RELEASE_CHANNEL: preview ? 'preview' : 'stable',
      O8_STUB_FAIL_BROADCAST: failBroadcast ? '1' : '0',
    },
  });
}

function readCleanupCalls(fixture: Fixture): string[] {
  try {
    return readFileSync(fixture.cleanupLog, 'utf8').trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

async function readBroadcastCalls(fixture: Fixture, expectedCount: number): Promise<string[][]> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const calls = readFileSync(fixture.broadcastLog, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as string[]);
      if (calls.length >= expectedCount) return calls;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${expectedCount} Broadcast calls.`);
}

afterEach(() => {
  while (roots.length > 0) {
    rmSync(roots.pop()!, { recursive: true, force: true });
  }
});

describe('release Broadcast milestones through the release entry point', () => {
  it('preserves preview selection through preflight, build, notarization and publication', () => {
    const fixture = makeFixture();
    const result = runRelease(fixture, false, true);
    expect(result.status, result.stderr).toBe(0);
    const records = readFileSync(fixture.channelLog, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    for (const stage of ['preflight', 'build', 'notarize', 'publish']) {
      expect(records.find(record => record.stage === stage)).toEqual({ stage, channel: 'preview' });
    }
  });

  it('runs preflight before build and isolates every build worker from operator state', () => {
    const fixture = makeFixture();
    const result = runRelease(fixture);

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(fixture.stageLog, 'utf8').trim().split('\n').slice(0, 2))
      .toEqual(['preflight', 'build']);
    const buildEnv = JSON.parse(readFileSync(fixture.envLog, 'utf8')) as {
      modern: string;
      legacy: string;
    };
    expect(buildEnv.modern).toBe(buildEnv.legacy);
    expect(buildEnv.modern).toContain('o8-release-build-data-');
    expect(buildEnv.modern).not.toContain('/.o8');
  });

  it('does not start the build when preflight fails', () => {
    const fixture = makeFixture({ failPreflight: true });
    const result = runRelease(fixture);

    expect(result.status).toBe(1);
    expect(readFileSync(fixture.stageLog, 'utf8').trim().split('\n')).toEqual([
      'preflight',
      'always-cleanup',
    ]);
  });

  it('posts every successful stage once in order and clears the ship focus', async () => {
    const fixture = makeFixture();
    const result = runRelease(fixture);

    expect(result.status, result.stderr).toBe(0);
    const calls = await readBroadcastCalls(fixture, 7);
    const stages = calls
      .filter((args) => args[0] === 'broadcast' && args[1] === 'focus' && !args.includes('--clear'))
      .map((args) => args[args.indexOf('--goal') + 1]);

    expect(stages).toEqual([
      'Build started',
      'App signed',
      'Submitted to the notary',
      'Stapled',
      'Release published',
      'Version live',
    ]);
    expect(calls.at(-1)).toEqual(['broadcast', 'focus', '--clear']);
  });

  it('names the failing stage and clears the ship focus', async () => {
    const fixture = makeFixture({ failNotary: true });
    const result = runRelease(fixture);

    expect(result.status).toBe(1);
    const calls = await readBroadcastCalls(fixture, 5);
    const failure = calls.find((args) => args[1] === 'post');
    expect(failure?.at(-1)).toBe(`Ship v${version} failed during notarization.`);
    expect(calls.at(-1)).toEqual(['broadcast', 'focus', '--clear']);
  });

  it('surfaces a public mirror failure even when private publication succeeded', async () => {
    const fixture = makeFixture({ failMirror: true });
    const result = runRelease(fixture);

    expect(result.status, result.stderr).toBe(0);
    const calls = await readBroadcastCalls(fixture, 7);
    const stages = calls
      .filter((args) => args[1] === 'focus' && args.includes('--goal'))
      .map((args) => args[args.indexOf('--goal') + 1]);
    expect(stages).not.toContain('Version live');
    expect(calls.find((args) => args[1] === 'post')?.at(-1))
      .toBe(`Ship v${version} failed during version publication.`);
    expect(calls.at(-1)).toEqual(['broadcast', 'focus', '--clear']);
  });

  it('does not fail the release when every Broadcast post fails', async () => {
    const fixture = makeFixture();
    const result = runRelease(fixture, true);

    expect(result.status, result.stderr).toBe(0);
    const calls = await readBroadcastCalls(fixture, 7);
    expect(calls).toHaveLength(7);
    expect(calls.at(-1)).toEqual(['broadcast', 'focus', '--clear']);
  });

  it('runs both cleanup classes after a successful ship', () => {
    const fixture = makeFixture();
    const result = runRelease(fixture);

    expect(result.status, result.stderr).toBe(0);
    expect(readCleanupCalls(fixture)).toEqual(['always-cleanup', 'success-cleanup']);
  });

  it('runs only always-safe cleanup after a failed ship', () => {
    const fixture = makeFixture({ failNotary: true });
    const result = runRelease(fixture);

    expect(result.status).toBe(1);
    expect(readCleanupCalls(fixture)).toEqual(['always-cleanup']);
  });

  it('warns without changing the ship outcome when cleanup fails', () => {
    const fixture = makeFixture({ failAlwaysCleanup: true });
    const result = runRelease(fixture);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain('[release] post-ship cleanup skipped:');
    expect(readCleanupCalls(fixture)).toEqual(['always-cleanup', 'success-cleanup']);

    const failedFixture = makeFixture({ failAlwaysCleanup: true, failNotary: true });
    const failedResult = runRelease(failedFixture);
    expect(failedResult.status).toBe(1);
    expect(failedResult.stderr).toContain('[release] post-ship cleanup skipped:');
    expect(readCleanupCalls(failedFixture)).toEqual(['always-cleanup']);
  });
});
