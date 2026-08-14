import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/runtimes/shared/dispatch-readiness', () => ({
  ensureDispatchBackendReady: async () => ({
    ready: true,
    reason: 'live-smoke',
    waitedMs: 0,
    attempts: 1,
    lastCheck: {
      ready: true,
      reason: 'live-smoke',
      apiBase: 'http://127.0.0.1',
      portSource: 'env',
      apiPortFilePresent: false,
    },
  }),
}));

const enabled = process.env.O8_LIVE_CLAUDE_CODE_GATEWAY === '1'
  && Boolean(process.env.OPENROUTER_API_KEY?.trim());
const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'o8-claude-code-gateway-live-'));
const repoRoot = path.join(
  process.env.CORTEX_IDE_DATA_DIR || path.join(os.homedir(), '.o8'),
  `claude-code-gateway-live-repo-${Date.now()}`,
);

async function waitForText(
  read: () => Promise<Array<{ role: string; text: string }>>,
  expected: string,
) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const transcript = await read();
    if (transcript.some((entry) => entry.role === 'assistant' && entry.text.includes(expected))) {
      return transcript;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for the Claude Code gateway proof: ${expected}`);
}

beforeAll(async () => {
  if (!enabled) return;
  execFileSync('git', ['init', '-q', repoRoot]);
  process.env.CORTEX_IDE_OWNED_CLAUDE_CODE_ROOT = path.join(tempRoot, 'owned');
  const { writeClaudeCodeWorkerProfile } = await import('@/lib/claude-code/worker-profile');
  await writeClaudeCodeWorkerProfile({
    source: 'openrouter',
    model: 'deepseek/deepseek-v4-pro-0813',
    codexModel: null,
  });
});

afterAll(() => {
  delete process.env.CORTEX_IDE_OWNED_CLAUDE_CODE_ROOT;
  rmSync(tempRoot, { recursive: true, force: true });
  rmSync(repoRoot, { recursive: true, force: true });
});

describe.skipIf(!enabled)('Claude Code API gateway live smoke', () => {
  it('runs a tool-capable API model through the owned Claude Code worker path', async () => {
    const { claudeCodeRuntime } = await import('@/lib/runtimes/claude-code');
    const launched = await claudeCodeRuntime.launch({
      cwd: repoRoot,
      prompt: 'Reply exactly O8_HARNESS_OK. Do not inspect or modify files and do not call tools.',
      clientMutationId: 'claude-code-gateway-live-proof',
    });
    expect(launched).toMatchObject({ ok: true });
    const sessionKey = launched.sessionKey!;
    await waitForText(() => claudeCodeRuntime.readTranscript(sessionKey), 'O8_HARNESS_OK');

    const { archiveOwnedClaudeCodeSession } = await import('@/lib/claude-code/owned');
    await expect(archiveOwnedClaudeCodeSession(sessionKey)).resolves.toMatchObject({ archived: true });
  }, 240_000);
});
