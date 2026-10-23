import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AssistantMessage, AssistantMessageEvent } from '@earendil-works/pi-ai';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPiOrchestratorBackend } from '@/lib/lane/orchestrator-backends/pi';
import type { OrchestratorBackend, OrchestratorTurnOptions } from '@/lib/lane/orchestrator-backends/types';
import { sendOrchestratorBackendTurn } from '@/lib/lane/orchestrator-send-entry';
import { readPersistedLlmChat } from '@/lib/llm/chat-history-store';
import type { ReviewChatOrigin } from '@/lib/orchestrator/review-continuation-origin';
import { runBoundChatContinuation } from '@/lib/ws-server/bound-chat-continuation';
import { buildPiWriteHelper } from './helpers/pi-write-helper';

const state = vi.hoisted(() => ({ backend: null as OrchestratorBackend | null }));
vi.mock('@/lib/lane/orchestrator-backends/registry', () => ({
  getOrchestratorBackend: () => state.backend!,
}));

let root: string;
let repo: string;
const backends: Array<ReturnType<typeof createPiOrchestratorBackend>> = [];
beforeAll(async () => {
  buildPiWriteHelper();
  root = await realpath(await mkdtemp(join(tmpdir(), 'o8-outside-workspace-')));
  repo = join(root, 'repo');
  await mkdir(repo);
  execFileSync('git', ['init', '-q', repo]);
}, 600_000);
afterAll(async () => {
  await Promise.all(backends.map(backend => backend.closeAll()));
  if (root) await rm(root, { recursive: true, force: true });
});

function answer(content: AssistantMessage['content'], stopReason: 'stop' | 'toolUse'): AssistantMessage {
  return { role: 'assistant', content, stopReason, model: 'fixture-model', api: 'openai-completions', provider: 'fixture',
    timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}

describe('explicit outside-workspace command permission', () => {
  it('changes the real command boundary on each turn and persists the selected mode in the transcript', async () => {
    const outside = join(root, 'outside.txt');
    const command = `printf changed > '${outside.replace(/'/g, "'\\''")}'`;
    let step = 0;
    let opens = 0;
    const backend = createPiOrchestratorBackend({ stateRoot: () => join(root, 'state'),
      openServers: async () => { opens++; return { servers: [], close: async () => {} }; },
      transport: async function* () {
        const message = step++ % 2 === 0
          ? answer([{ type: 'toolCall', id: `command-${step}`, name: 'run_command', arguments: { command } }], 'toolUse')
          : answer([{ type: 'text', text: 'Command inspected.' }], 'stop');
        yield { type: 'start', partial: message } as AssistantMessageEvent;
        yield { type: 'done', reason: message.stopReason, message } as AssistantMessageEvent;
      } });
    backends.push(backend);
    state.backend = backend;
    const threadId = `thoughts-outside-${Date.now()}`;
    const published: Array<Record<string, unknown>> = [];
    // Reuse the same resident thread across grant and downgrade, then restart it.
    for (const [index, permissionMode] of ['full', 'outside-workspace', 'full', 'outside-workspace'].entries()) {
      await rm(outside, { force: true });
      if (index === 3) await backend.closeAll();
      await runBoundChatContinuation({ repoPath: repo, message: 'Run the selected command.',
        assistantMessageId: `assistant-${index}`, check: () => {},
        origin: { threadId, turnId: `assistant-${index}`, backend: 'pi', model: 'pi', effort: 'medium',
          mode: 'single', permissionMode } as ReviewChatOrigin }, {
        registerAbort: () => () => {}, publish: (_session, event, data) => { published.push({ event, ...data }); },
      });
      if (permissionMode === 'outside-workspace') expect(await readFile(outside, 'utf8')).toBe('changed');
      else await expect(readFile(outside, 'utf8')).rejects.toThrow();
      // Read the canonical persisted chat file, rather than an in-memory event.
      const row = readPersistedLlmChat(threadId)?.history.messages.find(row => row.id === `assistant-${index}`);
      expect(row?.receipt?.permissionMode).toBe(permissionMode);
    }
    expect(opens).toBe(4);
    expect(published.filter(row => row.event === 'error')).toEqual([]);
    await backend.closeAll();
  }, 180_000);

  it('refuses this permission for another backend before invoking it', async () => {
    const sendTurn = vi.fn(async () => {});
    const backend: OrchestratorBackend = { id: 'codex', label: 'Codex', sendTurn,
      ensureSession: () => ({ sessionName: 'fixture', status: 'ready' }), peekSession: () => null };
    const options = { permissionMode: 'outside-workspace' } as OrchestratorTurnOptions;
    await expect(sendOrchestratorBackendTurn(backend, repo, 'Write outside', () => {}, options, 'single'))
      .rejects.toThrow(/outside.workspace/i);
    expect(sendTurn).not.toHaveBeenCalled();
  });

  it('refuses an outside grant on a proposer surface before starting a model session', async () => {
    const openServers = vi.fn(async () => ({ servers: [], close: async () => {} }));
    const backend = createPiOrchestratorBackend({ stateRoot: () => join(root, 'proposer'), openServers,
      transport: async function* () {
        const message = answer([{ type: 'text', text: 'Read only.' }], 'stop');
        yield { type: 'done', reason: 'stop', message } as AssistantMessageEvent;
      } });
    backends.push(backend);
    const events: unknown[] = [];
    await backend.sendTurn(repo, 'Write outside', event => events.push(event), {
      permissionMode: 'outside-workspace', toolProfile: 'propose',
    } as OrchestratorTurnOptions);
    expect(events).toEqual([expect.objectContaining({ type: 'error' }), expect.objectContaining({ type: 'done' })]);
    expect(openServers).not.toHaveBeenCalled();
  });
});
