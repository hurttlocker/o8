import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// RC2 (69RMXR) — auto-carry conversation history across an orchestrator backend
// switch. Driven against REAL persisted thread state written by the REAL store
// functions (append/upsert/writeSessionId), the exact inputs the ws-server send
// path feeds `buildBackendSwitchCarryPrelude` at its `withSessionRules`
// chokepoint. homedir() is mocked to a temp dir per the store's isolation
// pattern (see orchestrator-thread-history.test.ts).

const tempHomes: string[] = [];

async function loadModules() {
  const home = mkdtempSync(join(tmpdir(), 'o8-carry-'));
  tempHomes.push(home);
  vi.resetModules();
  vi.doMock('node:os', async () => ({
    ...(await vi.importActual<typeof import('node:os')>('node:os')),
    homedir: () => home,
  }));
  const history = await import('@/lib/mobile/orchestrator-thread-history');
  const carry = await import('./backend-switch-carry');
  return { history, carry };
}

afterEach(() => {
  vi.doUnmock('node:os');
  vi.resetModules();
  for (const home of tempHomes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});

type History = Awaited<ReturnType<typeof loadModules>>['history'];

const REPO = '/tmp/repo';

// Seed a thread that ran on `claude`: two prior exchanges + a stored claude
// session id (so claude "keeps its own context", codex does not).
function seedClaudeThread(history: History, tabId: string) {
  history.appendMobileOrchestratorUserMessage({ tabId, repoPath: REPO, message: 'How does the API gate work?', backend: 'claude', timestampMs: 1000 });
  history.upsertMobileOrchestratorAssistantMessage({ tabId, repoPath: REPO, messageId: 'assistant-1000', content: 'The middleware is default-deny on /api/*.', backend: 'claude', timestampMs: 1001 });
  history.appendMobileOrchestratorUserMessage({ tabId, repoPath: REPO, message: 'And how is the token checked?', backend: 'claude', timestampMs: 2000 });
  history.upsertMobileOrchestratorAssistantMessage({ tabId, repoPath: REPO, messageId: 'assistant-2000', content: 'A bearer ws-token, constant-time compared.', backend: 'claude', timestampMs: 2001 });
  history.writeOrchestratorBackendSessionId(tabId, 'claude', 'claude-session-xyz');
}

describe('buildBackendSwitchCarryPrelude — RC2 auto-carry on backend switch', () => {
  it('switching to a backend with NO session on this thread carries the prior transcript', async () => {
    const { history, carry } = await loadModules();
    const tabId = 'thoughts-switch-1';
    seedClaudeThread(history, tabId);

    // Operator switched the picker to codex; codex has never run on this thread.
    const prelude = carry.buildBackendSwitchCarryPrelude({ threadId: tabId, backend: 'codex' });

    expect(prelude).not.toBeNull();
    expect(prelude).toContain('<carried_context>');
    // Prior BOTH-role history is carried so the new model has full context.
    expect(prelude).toContain('The middleware is default-deny on /api/*.');
    expect(prelude).toContain('A bearer ws-token, constant-time compared.');
    expect(prelude).toContain('How does the API gate work?');
  });

  it('the ws-server outbound payload (carry + message) carries the prior transcript AND the new turn', async () => {
    const { history, carry } = await loadModules();
    const tabId = 'thoughts-switch-2';
    seedClaudeThread(history, tabId);

    const newMessage = 'Now add a rate limit to the gate.';
    const prelude = carry.buildBackendSwitchCarryPrelude({ threadId: tabId, backend: 'codex' });
    // Mirrors ws-server: `carryPrelude ? `${carryPrelude}\n\n${message}` : message`.
    const outbound = prelude ? `${prelude}\n\n${newMessage}` : newMessage;

    expect(outbound).toContain('A bearer ws-token, constant-time compared.'); // prior context
    expect(outbound).toContain(newMessage); // the new operator turn
  });

  it('the SAME backend (already has a session id) does NOT carry — the CLI keeps its own context', async () => {
    const { history, carry } = await loadModules();
    const tabId = 'thoughts-switch-3';
    seedClaudeThread(history, tabId);

    const prelude = carry.buildBackendSwitchCarryPrelude({ threadId: tabId, backend: 'claude' });
    expect(prelude).toBeNull();
  });

  it('a fresh thread with no prior assistant reply does not carry', async () => {
    const { history, carry } = await loadModules();
    const tabId = 'thoughts-switch-4';
    history.appendMobileOrchestratorUserMessage({ tabId, repoPath: REPO, message: 'first message', backend: 'codex', timestampMs: 1000 });

    const prelude = carry.buildBackendSwitchCarryPrelude({ threadId: tabId, backend: 'codex' });
    expect(prelude).toBeNull();
  });

  it('backends that do not track a resumable session id are excluded (would carry every turn)', async () => {
    const { history, carry } = await loadModules();
    const tabId = 'thoughts-switch-5';
    seedClaudeThread(history, tabId);

    expect(carry.buildBackendSwitchCarryPrelude({ threadId: tabId, backend: 'openclaw' })).toBeNull();
    expect(carry.buildBackendSwitchCarryPrelude({ threadId: tabId, backend: 'collide' })).toBeNull();
  });

  it('a non-thoughts thread id never carries', async () => {
    const { carry } = await loadModules();
    expect(carry.buildBackendSwitchCarryPrelude({ threadId: 'mission-123', backend: 'codex' })).toBeNull();
    expect(carry.buildBackendSwitchCarryPrelude({ threadId: null, backend: 'codex' })).toBeNull();
  });
});
