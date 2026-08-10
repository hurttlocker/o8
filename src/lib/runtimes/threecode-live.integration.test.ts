import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { AgentRuntime, RuntimeSession } from './types';

const liveEnabled = process.env.O8_LIVE_3CODE === '1';

vi.mock('@/lib/runtimes/shared/dispatch-readiness', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/runtimes/shared/dispatch-readiness')>();
  return {
    ...actual,
    ensureDispatchBackendReady: vi.fn().mockResolvedValue(undefined),
  };
});

describe.runIf(liveEnabled)('3code live OpenRouter integration', () => {
  it('launches and resumes the same runtime-owned 3code session', async () => {
    const tempRoot = mkdtempSync(path.join(os.homedir(), '.o8', 'live-3code-'));
    const repoPath = path.join(tempRoot, 'repo');
    const sessionRoot = path.join(tempRoot, 'sessions');
    execFileSync('git', ['init', '-q', repoPath]);
    process.env.O8_OWNED_3CODE_ROOT = sessionRoot;

    const { declarativeWorkerRuntimes } = await import('./declarative-workers');
    const runtime = declarativeWorkerRuntimes.find((candidate) => candidate.id === '3code');
    expect(runtime).toBeDefined();

    const launch = await runtime!.launch({
      cwd: repoPath,
      prompt: 'Reply exactly FIRST_OK. Do not use tools and do not modify files.',
    });
    expect(launch).toMatchObject({ ok: true });
    const sessionKey = launch.sessionKey!;
    const launched = await waitForTurn(runtime!, sessionKey, 'launch');
    expect(launched.transcript).toContain('FIRST_OK');
    expect(existsSync(path.join(launched.sessionDir, 'session.3log'))).toBe(true);

    await expect(runtime!.resume(
      sessionKey,
      'Reply exactly SECOND_OK. Do not use tools and do not modify files.',
    )).resolves.toMatchObject({ ok: true, sessionKey });
    const resumed = await waitForTurn(runtime!, sessionKey, 'resume');
    expect(resumed.transcript).toContain('SECOND_OK');
    expect(resumed.threadId).toBe(path.join(resumed.sessionDir, 'session.3log'));

    const expectedParent = path.join(os.homedir(), '.o8');
    expect(path.dirname(tempRoot)).toBe(expectedParent);
    rmSync(tempRoot, { recursive: true });
  }, 150_000);
});

async function waitForTurn(
  runtime: AgentRuntime,
  sessionKey: string,
  mode: 'launch' | 'resume',
): Promise<RuntimeSession & { sessionDir: string; threadId?: string; transcript: string }> {
  for (let attempt = 0; attempt < 1_200; attempt += 1) {
    const session = (await runtime.discoverSessions())
      .find((candidate) => candidate.sessionKey === sessionKey);
    if (session?.lifecycle?.lastOutcome === 'finished' && session.lifecycle.lastRunMode === mode) {
      const transcript = (await runtime.readTranscript(sessionKey)).map((entry) => entry.text).join('\n');
      const sessionDir = path.join(
        process.env.O8_OWNED_3CODE_ROOT!,
        sessionKey.slice(sessionKey.indexOf(':') + 1),
      );
      const record = JSON.parse(
        await import('node:fs/promises').then(({ readFile }) => readFile(path.join(sessionDir, 'session.json'), 'utf8')),
      ) as { threadId?: string };
      return { ...session, sessionDir, threadId: record.threadId, transcript };
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await runtime.interrupt(sessionKey).catch(() => undefined);
  throw new Error(`Timed out waiting for live 3code ${mode}.`);
}
