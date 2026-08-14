import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { OrchestratorEvent } from '@/lib/lane/orchestrator-stream-events';

const enabled = process.env.O8_LIVE_CLAUDE_CODE_CODEX_ORCHESTRATOR === '1';
const dataDir = process.env.CORTEX_IDE_DATA_DIR ?? path.join(os.tmpdir(), 'o8-codex-orchestrator-live');
const repoRoot = path.join(dataDir, `codex-orchestrator-live-repo-${Date.now()}`);
const previousProxyRoot = process.env.O8_CLIPROXYAPI_ROOT;
const threadA = `thoughts-codex-harness-a-${Date.now()}`;
const threadB = `thoughts-codex-harness-b-${Date.now()}`;

function textCollector() {
  const chunks: string[] = [];
  const done: Array<Extract<OrchestratorEvent, { type: 'done' }>> = [];
  return {
    chunks,
    done,
    onEvent(event: OrchestratorEvent) {
      if (event.type === 'text') chunks.push(event.text);
      if (event.type === 'done') done.push(event);
      if (event.type === 'error') throw new Error(event.error);
    },
  };
}

beforeAll(async () => {
  if (!enabled) return;
  mkdirSync(repoRoot, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
  execFileSync('git', ['remote', 'add', 'origin', 'https://example.invalid/o8-live.git'], { cwd: repoRoot });
  writeFileSync(path.join(repoRoot, 'CLAUDE.md'), [
    '# Harness verification',
    '',
    'The project harness marker is `O8_FULL_HARNESS_CONTEXT_OK`.',
    'When asked for the project harness marker, reply with that marker only.',
    '',
  ].join('\n'));
  process.env.O8_CLIPROXYAPI_ROOT = previousProxyRoot ?? path.join(os.homedir(), '.o8', 'cliproxy');
  const { writeClaudeCodeWorkerProfile } = await import('@/lib/claude-code/worker-profile');
  await writeClaudeCodeWorkerProfile({
    source: 'codex-subscription',
    model: null,
    codexModel: 'gpt-5.6-sol',
  });
});

afterAll(async () => {
  if (enabled) {
    const { requestOrchestratorSessionReset } = await import('@/lib/lane/orchestrator-session');
    requestOrchestratorSessionReset(repoRoot, threadA);
    requestOrchestratorSessionReset(repoRoot, threadB);
  }
  if (previousProxyRoot === undefined) delete process.env.O8_CLIPROXYAPI_ROOT;
  else process.env.O8_CLIPROXYAPI_ROOT = previousProxyRoot;
  if (existsSync(repoRoot)) rmSync(repoRoot, { recursive: true, force: true });
});

describe.skipIf(!enabled)('Codex through the resident Claude Code orchestrator', () => {
  it('loads full project context once, keeps the process warm, and isolates each chat', async () => {
    const { ensureOrchestratorSession, sendToOrchestrator } = await import('@/lib/lane/orchestrator-session');
    const first = ensureOrchestratorSession(repoRoot, threadA);
    const second = ensureOrchestratorSession(repoRoot, threadB);

    const firstContext = textCollector();
    await sendToOrchestrator(
      first,
      'What is the project harness marker? Reply with only the marker. Do not call tools.',
      firstContext.onEvent,
    );
    expect(firstContext.chunks.join('')).toContain('O8_FULL_HARNESS_CONTEXT_OK');
    const firstProc = first.proc;
    const firstClaudeSessionId = first.claudeSessionId;

    const followup = textCollector();
    await sendToOrchestrator(first, 'Reply exactly O8_WARM_FOLLOWUP_OK.', followup.onEvent);
    expect(followup.chunks.join('')).toContain('O8_WARM_FOLLOWUP_OK');
    expect(first.proc).toBe(firstProc);
    expect(first.claudeSessionId).toBe(firstClaudeSessionId);
    expect(followup.done[0]?.usage?.cacheReadTokens).toBeGreaterThan(0);
    const followupPromptTokens = (followup.done[0]?.usage?.inputTokens ?? 0)
      + (followup.done[0]?.usage?.cacheReadTokens ?? 0);
    expect((followup.done[0]?.usage?.cacheReadTokens ?? 0) / followupPromptTokens).toBeGreaterThan(0.9);

    const secondContext = textCollector();
    await sendToOrchestrator(
      second,
      'What is the project harness marker? Reply with only the marker. Do not call tools.',
      secondContext.onEvent,
    );
    expect(secondContext.chunks.join('')).toContain('O8_FULL_HARNESS_CONTEXT_OK');
    expect(second.proc).not.toBe(first.proc);
    expect(second.claudeSessionId).not.toBe(first.claudeSessionId);
    expect(first.sessionName).not.toBe(second.sessionName);

    const firstConfig = path.join(dataDir, 'orchestrator', 'carrier', first.sessionName, 'claude-code-codex-config');
    const secondConfig = path.join(dataDir, 'orchestrator', 'carrier', second.sessionName, 'claude-code-codex-config');
    expect(firstConfig).not.toBe(secondConfig);
    expect(existsSync(firstConfig)).toBe(true);
    expect(existsSync(secondConfig)).toBe(true);
  }, 240_000);
});
