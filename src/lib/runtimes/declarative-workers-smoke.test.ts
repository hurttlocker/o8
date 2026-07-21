import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { afterAll, describe, expect, it, vi } from 'vitest';

import type { DispatchBackendWaitResult } from '@/lib/runtimes/shared/dispatch-readiness';
import type { OwnedSessionRecord } from '@/lib/runtimes/shared/owned-session';
import {
  getRuntimeCapability,
  listDeclarativeRuntimes,
} from '@/lib/orchestrator/runtime-capabilities';
import type { AgentRuntime, RuntimeSession } from './types';

const ensureDispatchBackendReadyMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/runtimes/shared/dispatch-readiness', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/runtimes/shared/dispatch-readiness')>();
  return {
    ...actual,
    ensureDispatchBackendReady: ensureDispatchBackendReadyMock,
  };
});

const tempRoot = mkdtempSync(path.join(process.cwd(), '.tmp-declarative-worker-smoke-'));
const repoPath = path.join(tempRoot, 'repo');
const fixtureBinary = path.join(tempRoot, 'fixture-cli.mjs');
execFileSync('git', ['init', '-q', repoPath]);
writeFileSync(fixtureBinary, `#!/usr/bin/env node
const runtime = process.env.O8_SMOKE_RUNTIME || 'fixture-cli';
const profile = process.env.O8_SMOKE_PARSER_PROFILE || 'fixture';
const args = process.argv.slice(2).join(' ');
if (profile === 'openhands-ndjson') {
  process.stdout.write(JSON.stringify({ type: 'conversation_started', conversation_id: 'thread-' + runtime }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'assistant_message', content: runtime + ' smoke complete' }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'completed', message: 'done' }) + '\\n');
} else if (profile === 'qwen-stream-json') {
  process.stdout.write(JSON.stringify({ type: 'init', session_id: 'thread-' + runtime }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'message', content: runtime + ' smoke complete' }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'result', result: 'done' }) + '\\n');
} else if (profile === 'fixture') {
  process.stdout.write(JSON.stringify({ type: 'init', sessionId: 'thread-fixture' }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'message', content: args }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'done', summary: 'fixture complete' }) + '\\n');
} else {
  process.stdout.write(runtime + ' smoke complete\\n');
}
`, 'utf8');
chmodSync(fixtureBinary, 0o755);

const declarativeRuntimeIds = listDeclarativeRuntimes();
const managedEnv = new Map<string, string | undefined>();

function setManagedEnv(key: string, value: string): void {
  if (!managedEnv.has(key)) managedEnv.set(key, process.env[key]);
  process.env[key] = value;
}

for (const runtimeId of declarativeRuntimeIds) {
  const token = runtimeId.toUpperCase();
  setManagedEnv(`O8_OWNED_${token}_ROOT`, path.join(tempRoot, 'sessions', runtimeId));
  setManagedEnv(`O8_${token}_BIN`, fixtureBinary);
}
setManagedEnv('O8_OWNED_FIXTURE_CLI_ROOT', path.join(tempRoot, 'sessions', 'fixture-cli'));
setManagedEnv('O8_FIXTURE_CLI_BIN', fixtureBinary);
setManagedEnv('O8_SMOKE_RUNTIME', '');
setManagedEnv('O8_SMOKE_PARSER_PROFILE', '');

ensureDispatchBackendReadyMock.mockResolvedValue(readyResult());

const {
  DECLARATIVE_WORKER_CONFIGS,
  declarativeWorkerRuntimes,
} = await import('./declarative-workers');
const { createDeclarativeAgentRuntime } = await import('./shared/declarative-agent-runtime');
const { registerDeclarativeOwnedRuntime } = await import('./shared/owned-session');

afterAll(() => {
  for (const [key, value] of managedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(tempRoot, { recursive: true, force: true });
});

describe('declarative worker real-process smoke matrix', () => {
  it.each(DECLARATIVE_WORKER_CONFIGS)(
    '$runtimeId launches, normalizes output, records a clean exit, and reports one-shot resume honestly',
    async (config) => {
      process.env.O8_SMOKE_RUNTIME = config.runtimeId;
      process.env.O8_SMOKE_PARSER_PROFILE = getRuntimeCapability(config.runtimeId).declarative?.parserProfile ?? '';
      const runtime = runtimeById(config.runtimeId);
      const launch = await runtime.launch({ cwd: repoPath, prompt: `smoke ${config.runtimeId}` });

      expect(launch).toMatchObject({ ok: true });
      expect(launch.sessionKey).toMatch(new RegExp(`^${config.surfaceIdPrefix}`));
      const sessionKey = launch.sessionKey!;
      const record = await waitForCleanExit(process.env[config.rootEnvVar]!, sessionKey, 'launch');
      const session = await waitForFinishedSession(runtime, sessionKey, 'launch');
      const transcript = await runtime.readTranscript(sessionKey);

      expect(record.recentRuns[0]?.childExit).toMatchObject({
        code: 0,
        signal: null,
        classification: 'clean-exit',
      });
      expect(session.lifecycle).toMatchObject({ lastOutcome: 'finished', lastRunMode: 'launch' });
      expect(transcript.some((entry) => entry.text.includes(`${config.runtimeId} smoke complete`))).toBe(true);
      await expect(runtime.resume(sessionKey, 'continue')).resolves.toMatchObject({
        ok: false,
        sessionKey,
      });
    },
    20_000,
  );

  it('runs launch, resume, and clean exit for a representative new declarative CLI', async () => {
    process.env.O8_SMOKE_RUNTIME = 'fixture-cli';
    process.env.O8_SMOKE_PARSER_PROFILE = 'fixture';
    const registration = registerDeclarativeOwnedRuntime({
      runtimeId: 'fixture-cli',
      surfaceIdPrefix: 'fixture-cli-owned:',
      rootEnvVar: 'O8_OWNED_FIXTURE_CLI_ROOT',
      rootDefault: path.join(tempRoot, 'unused-fixture-root'),
      binaryName: 'fixture-cli',
      binaryEnvOverride: 'O8_FIXTURE_CLI_BIN',
      humanLabel: 'Owned Fixture CLI',
      squadShortName: 'Fixture',
      sessionIdPrefix: 'fixture-cli-owned-',
      launchArgs: ['launch', '{{prompt}}'],
      resumeArgs: ['resume', '{{threadId}}', '{{prompt}}'],
      parseRunLog: {
        patterns: [
          { eventType: 'init', threadIdPaths: ['sessionId'] },
          { eventType: 'message', kind: 'message', label: 'Fixture', textPaths: ['content'] },
          { eventType: 'done', kind: 'event', label: 'Run complete', textPaths: ['summary'], completedTurn: true },
        ],
      },
    });
    const runtime = createDeclarativeAgentRuntime({
      runtimeId: 'fixture-cli',
      displayName: 'Fixture CLI',
      surfaceIdPrefix: 'fixture-cli-owned:',
      supportsResume: true,
      costTelemetry: false,
    }, registration.store);

    const launch = await runtime.launch({ cwd: repoPath, prompt: 'first turn' });
    const sessionKey = launch.sessionKey!;
    const root = process.env.O8_OWNED_FIXTURE_CLI_ROOT!;
    await waitForCleanExit(root, sessionKey, 'launch');
    await waitForFinishedSession(runtime, sessionKey, 'launch');

    await expect(runtime.resume(sessionKey, 'second turn')).resolves.toMatchObject({ ok: true, sessionKey });
    const resumed = await waitForCleanExit(root, sessionKey, 'resume');
    const session = await waitForFinishedSession(runtime, sessionKey, 'resume');
    const transcript = await runtime.readTranscript(sessionKey);

    expect(resumed.threadId).toBe('thread-fixture');
    expect(resumed.recentRuns[0]?.childExit?.classification).toBe('clean-exit');
    expect(session.lifecycle).toMatchObject({ lastOutcome: 'finished', lastRunMode: 'resume' });
    expect(transcript.map((entry) => entry.text).join('\n')).toContain('launch first turn');
    expect(transcript.map((entry) => entry.text).join('\n')).toContain('resume thread-fixture second turn');
  }, 20_000);
});

function runtimeById(runtimeId: string): AgentRuntime {
  const runtime = declarativeWorkerRuntimes.find((candidate) => candidate.id === runtimeId);
  if (!runtime) throw new Error(`missing declarative runtime ${runtimeId}`);
  return runtime;
}

async function waitForCleanExit(
  root: string,
  sessionKey: string,
  mode: 'launch' | 'resume',
): Promise<OwnedSessionRecord> {
  const sessionId = sessionKey.slice(sessionKey.indexOf(':') + 1);
  const sessionPath = path.join(root, sessionId, 'session.json');
  for (let attempt = 0; attempt < 500; attempt += 1) {
    try {
      const session = JSON.parse(readFileSync(sessionPath, 'utf8')) as OwnedSessionRecord;
      const latest = session.recentRuns[0];
      if (latest?.mode === mode && latest.childExit) return session;
    } catch {
      // The detached runner creates and updates the session file asynchronously.
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${mode} child exit on ${sessionKey}`);
}

async function waitForFinishedSession(
  runtime: AgentRuntime,
  sessionKey: string,
  mode: 'launch' | 'resume',
): Promise<RuntimeSession> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const session = (await runtime.discoverSessions())
      .find((candidate) => candidate.sessionKey === sessionKey);
    if (session?.lifecycle?.lastOutcome === 'finished' && session.lifecycle.lastRunMode === mode) {
      return session;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${mode} lifecycle on ${sessionKey}`);
}

function readyResult(): DispatchBackendWaitResult {
  return {
    ready: true,
    reason: 'http_200',
    waitedMs: 0,
    attempts: 1,
    lastCheck: {
      ready: true,
      reason: 'http_200',
      apiBase: 'http://o8.test',
      status: 200,
      portSource: 'file',
      apiPortFilePresent: true,
    },
  };
}
