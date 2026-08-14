import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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

const enabled = process.env.O8_LIVE_CLAUDE_CODE_CODEX === '1';
const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'o8-claude-code-codex-live-'));
const repoRoot = path.join(
  process.env.CORTEX_IDE_DATA_DIR ?? tempRoot,
  `claude-code-codex-live-repo-${Date.now()}`,
);
const previousProxyRoot = process.env.O8_CLIPROXYAPI_ROOT;

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
  throw new Error(`Timed out waiting for the Codex subscription carrier proof: ${expected}`);
}

beforeAll(async () => {
  if (!enabled) return;
  execFileSync('git', ['init', '-q', repoRoot]);
  process.env.CORTEX_IDE_OWNED_CLAUDE_CODE_ROOT = path.join(tempRoot, 'owned');
  process.env.O8_CLIPROXYAPI_ROOT = previousProxyRoot ?? path.join(os.homedir(), '.o8', 'cliproxy');
  const { writeClaudeCodeWorkerProfile } = await import('@/lib/claude-code/worker-profile');
  await writeClaudeCodeWorkerProfile({
    source: 'codex-subscription',
    model: null,
    codexModel: 'gpt-5.6-sol',
  });
});

afterAll(() => {
  delete process.env.CORTEX_IDE_OWNED_CLAUDE_CODE_ROOT;
  if (previousProxyRoot === undefined) delete process.env.O8_CLIPROXYAPI_ROOT;
  else process.env.O8_CLIPROXYAPI_ROOT = previousProxyRoot;
  rmSync(tempRoot, { recursive: true, force: true });
  rmSync(repoRoot, { recursive: true, force: true });
});

describe.skipIf(!enabled)('Claude Code Codex subscription carrier live smoke', () => {
  it('runs GPT-5.6 Sol through the owned Claude Code worker path without an API key', async () => {
    const { claudeCodeRuntime } = await import('@/lib/runtimes/claude-code');
    const launched = await claudeCodeRuntime.launch({
      cwd: repoRoot,
      prompt: 'Reply exactly O8_CODEX_CLAUDE_OWNED_OK. Do not inspect or modify files and do not call tools.',
      clientMutationId: 'claude-code-codex-subscription-live-proof',
    });
    expect(launched).toMatchObject({ ok: true });
    const sessionKey = launched.sessionKey!;
    const sessionRoot = path.join(
      process.env.CORTEX_IDE_OWNED_CLAUDE_CODE_ROOT!,
      sessionKey.replace('claude-code-owned:', ''),
    );
    const metadata = JSON.parse(readFileSync(path.join(sessionRoot, 'session.json'), 'utf8')) as {
      model?: string;
      runtimeConfig?: { modelSource?: string };
    };
    expect(metadata).toMatchObject({
      model: 'gpt-5.6-sol',
      runtimeConfig: { modelSource: 'codex-subscription' },
    });
    await waitForText(() => claudeCodeRuntime.readTranscript(sessionKey), 'O8_CODEX_CLAUDE_OWNED_OK');

    const { archiveOwnedClaudeCodeSession } = await import('@/lib/claude-code/owned');
    await expect(archiveOwnedClaudeCodeSession(sessionKey)).resolves.toMatchObject({ archived: true });
  }, 240_000);
});
