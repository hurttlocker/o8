/**
 * Per-message attribution across a mid-thread handoff.
 *
 * Real path: every message is written through the actual
 * `upsertMobileOrchestratorAssistantMessage` / `appendMobileOrchestratorUserMessage`
 * writers against a real on-disk thread, then read back through the real
 * reader. Asserting on a hand-built record would prove the reader parses a
 * shape I invented, not that the writer records what actually happened.
 *
 * The bug this pins: the thread-level `backend`/`model` are "what runs next"
 * and get overwritten every turn. Before stamping, switching backend at turn N
 * made all N-1 earlier turns read as the NEW agent's — a false record, not
 * merely a missing one.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'o8-attrib-'));
  process.env.CORTEX_IDE_DATA_DIR = dataDir;
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.CORTEX_IDE_DATA_DIR;
});

async function history() {
  return import('./orchestrator-thread-history');
}

async function seedTurn(
  tabId: string,
  userText: string,
  assistantText: string,
  backend: string,
  model: string,
  messageId: string,
) {
  const h = await history();
  h.appendMobileOrchestratorUserMessage({
    tabId,
    message: userText,
    repoPath: '/tmp/repo',
    backend: backend as never,
  });
  h.upsertMobileOrchestratorAssistantMessage({
    tabId,
    messageId,
    content: assistantText,
    repoPath: '/tmp/repo',
    backend: backend as never,
    model,
  });
}

describe('per-message attribution survives a handoff', () => {
  it('does not re-attribute earlier turns to the new agent', async () => {
    const h = await history();
    const tabId = h.createMobileOrchestratorThread({ repoPath: '/tmp/repo', backend: 'codex' as never }).id;

    await seedTurn(tabId, 'first question', 'codex answer', 'codex', 'gpt-5.6-sol', 'm1');
    await seedTurn(tabId, 'second question', 'opencode answer', 'opencode', 'openrouter/deepseek/deepseek-chat', 'm2');

    const { messages } = h.readAttributedThreadMessages(tabId);
    const assistants = messages.filter((m) => m.role === 'assistant');
    expect(assistants).toHaveLength(2);

    // THE regression: before stamping, both of these read as the newest backend.
    expect(assistants[0].backend).toBe('codex');
    expect(assistants[0].model).toBe('gpt-5.6-sol');
    expect(assistants[1].backend).toBe('opencode');
    expect(assistants[1].model).toBe('openrouter/deepseek/deepseek-chat');
  });

  it('reports the seam where the agent changed', async () => {
    const h = await history();
    const tabId = h.createMobileOrchestratorThread({ repoPath: '/tmp/repo', backend: 'codex' as never }).id;
    await seedTurn(tabId, 'q1', 'a1', 'codex', 'gpt-5.6-sol', 'm1');
    await seedTurn(tabId, 'q2', 'a2', 'codex', 'gpt-5.6-sol', 'm2');
    await seedTurn(tabId, 'q3', 'a3', 'opencode', 'xai/grok-4.5', 'm3');

    const { messages, seams } = h.readAttributedThreadMessages(tabId);
    expect(seams).toHaveLength(1);
    expect(messages[seams[0]].backend).toBe('opencode');
    expect(messages[seams[0]].model).toBe('xai/grok-4.5');
  });

  it('treats a model swap within one backend as a seam too', async () => {
    const h = await history();
    const tabId = h.createMobileOrchestratorThread({ repoPath: '/tmp/repo', backend: 'opencode' as never }).id;
    await seedTurn(tabId, 'q1', 'a1', 'opencode', 'openrouter/deepseek/deepseek-chat', 'm1');
    await seedTurn(tabId, 'q2', 'a2', 'opencode', 'xai/grok-4.5', 'm2');

    const { seams } = h.readAttributedThreadMessages(tabId);
    expect(seams).toHaveLength(1);
  });

  it('reports no seam for a single-agent thread', async () => {
    const h = await history();
    const tabId = h.createMobileOrchestratorThread({ repoPath: '/tmp/repo', backend: 'codex' as never }).id;
    await seedTurn(tabId, 'q1', 'a1', 'codex', 'gpt-5.6-sol', 'm1');
    await seedTurn(tabId, 'q2', 'a2', 'codex', 'gpt-5.6-sol', 'm2');
    expect(h.readAttributedThreadMessages(tabId).seams).toEqual([]);
  });

  it('leaves user messages unattributed — a human wrote them', async () => {
    const h = await history();
    const tabId = h.createMobileOrchestratorThread({ repoPath: '/tmp/repo', backend: 'codex' as never }).id;
    await seedTurn(tabId, 'q1', 'a1', 'codex', 'gpt-5.6-sol', 'm1');

    const user = h.readAttributedThreadMessages(tabId).messages.filter((m) => m.role === 'user');
    expect(user.length).toBeGreaterThan(0);
    for (const message of user) {
      expect(message.backend).toBeUndefined();
      expect(message.model).toBeUndefined();
    }
  });

  it('draws no seam against an unstamped legacy turn', async () => {
    // Missing data is not a handoff. Inventing a seam here would show the
    // operator an event that never happened.
    const h = await history();
    const tabId = h.createMobileOrchestratorThread({ repoPath: '/tmp/repo', backend: 'codex' as never }).id;
    h.upsertMobileOrchestratorAssistantMessage({
      tabId, messageId: 'legacy', content: 'no attribution', repoPath: '/tmp/repo',
    });
    await seedTurn(tabId, 'q2', 'a2', 'opencode', 'xai/grok-4.5', 'm2');

    expect(h.readAttributedThreadMessages(tabId).seams).toEqual([]);
  });

  it('keeps the first stamp across streaming re-upserts of one turn', async () => {
    const h = await history();
    const tabId = h.createMobileOrchestratorThread({ repoPath: '/tmp/repo', backend: 'opencode' as never }).id;
    for (const chunk of ['partial', 'partial answer', 'partial answer complete']) {
      h.upsertMobileOrchestratorAssistantMessage({
        tabId, messageId: 'stream1', content: chunk, repoPath: '/tmp/repo',
        backend: 'opencode' as never, model: 'openrouter/deepseek/deepseek-chat',
      });
    }
    // A later upsert with no backend must not blank what was already stamped.
    h.upsertMobileOrchestratorAssistantMessage({
      tabId, messageId: 'stream1', content: 'partial answer complete', repoPath: '/tmp/repo',
    });

    const assistants = h.readAttributedThreadMessages(tabId).messages.filter((m) => m.role === 'assistant');
    expect(assistants).toHaveLength(1);
    expect(assistants[0].backend).toBe('opencode');
    expect(assistants[0].model).toBe('openrouter/deepseek/deepseek-chat');
  });
});
