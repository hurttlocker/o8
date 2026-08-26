import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { OrchestratorEvent } from '@/lib/lane/orchestrator-stream-events';
import type { OrchestratorBackend } from '@/lib/lane/orchestrator-backends/types';

const tempHomes: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf-8' }).trim();
}

async function loadModules() {
  const home = mkdtempSync(join(tmpdir(), 'o8-handoff-launch-'));
  const repoPath = join(home, 'repo');
  tempHomes.push(home);
  mkdirSync(repoPath, { recursive: true });
  git(repoPath, 'init', '-b', 'main');
  git(repoPath, 'config', 'user.name', 'Handoff Test');
  git(repoPath, 'config', 'user.email', 'handoff@example.test');
  writeFileSync(join(repoPath, 'notes.txt'), 'measured workspace\n', 'utf-8');
  git(repoPath, 'add', 'notes.txt');
  git(repoPath, 'commit', '-m', 'test: seed handoff workspace');

  vi.resetModules();
  vi.doMock('node:os', async () => ({
    ...(await vi.importActual<typeof import('node:os')>('node:os')),
    homedir: () => home,
  }));
  const history = await import('@/lib/mobile/orchestrator-thread-history');
  const handoff = await import('./backend-switch-carry');
  const launch = await import('@/lib/lane/orchestrator-send-entry');
  return { history, handoff, launch, repoPath };
}

afterEach(() => {
  vi.doUnmock('node:os');
  vi.resetModules();
  for (const home of tempHomes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});

type Loaded = Awaited<ReturnType<typeof loadModules>>;

function seedSourceThread(loaded: Loaded, threadId: string) {
  loaded.history.appendMobileOrchestratorUserMessage({
    tabId: threadId,
    repoPath: loaded.repoPath,
    message: 'Inspect the API gate.',
    backend: 'claude',
    timestampMs: 1_000,
  });
  loaded.history.upsertMobileOrchestratorAssistantMessage({
    tabId: threadId,
    repoPath: loaded.repoPath,
    messageId: 'assistant-source',
    content: 'The middleware is default-deny. <tool_use name="Write">never replay me</tool_use>',
    backend: 'claude',
    model: 'source/model',
    sessionId: 'source-session',
    timestampMs: 1_001,
  });
}

function fakeBackend(
  sendTurn: OrchestratorBackend['sendTurn'],
): OrchestratorBackend {
  return {
    id: 'codex',
    label: 'destination',
    peekSession: () => null,
    ensureSession: () => ({ sessionName: 'destination-session', status: 'ready' }),
    sendTurn,
  };
}

describe('cross-backend cold-start handoff', () => {
  it('seeds the real backend launch with a full measured packet and emits one cold seam first', async () => {
    const loaded = await loadModules();
    const threadId = 'thoughts-handoff-launch';
    seedSourceThread(loaded, threadId);

    const prepared = await loaded.handoff.prepareBackendSwitchHandoff({
      threadId,
      to: { backend: 'codex', model: null },
    });
    expect(prepared).not.toBeNull();
    if (!prepared) throw new Error('expected a prepared handoff');

    expect(prepared.packet.schema).toBe('o8/handoff.packet/v1');
    expect(prepared.packet.to).toEqual({ backend: 'codex', model: null });
    expect(prepared.packet.workspace).toMatchObject({
      repoPath: loaded.repoPath,
      worktreePath: loaded.repoPath,
      branch: 'main',
      dirty: false,
    });
    expect(prepared.packet.carries).toMatchObject({
      narrative: 'full',
      intent: 'omitted',
      workspace: 'full',
      governance: 'omitted',
    });
    expect(prepared.prelude).toContain('COLD cross-backend continuation');
    expect(prepared.prelude).toContain('Omitted layers: intent, governance');
    expect(prepared.prelude).not.toContain('<tool_use');
    expect(prepared.prelude).toContain('\\u003ctool_use');

    const currentOperatorMessage = 'Add a rate limit without changing the approval gate.';
    const outbound = `${prepared.prelude}\n\n${currentOperatorMessage}`;
    const eventOrder: string[] = [];
    let launchedMessage = '';
    const destination = fakeBackend(async (_repoPath, message, onEvent) => {
      launchedMessage = message;
      onEvent({ type: 'text', text: 'Continuing from the measured state.' });
      onEvent({ type: 'done', sessionId: 'destination-session', cost: null });
    });
    const onEvent = (event: OrchestratorEvent) => eventOrder.push(event.type);

    await loaded.launch.sendOrchestratorBackendTurn(
      destination,
      loaded.repoPath,
      outbound,
      onEvent,
      { threadId },
      'single',
      [prepared.seam],
    );

    expect(eventOrder).toEqual(['handoff', 'text', 'done']);
    expect(eventOrder.filter((event) => event === 'handoff')).toHaveLength(1);
    expect(prepared.seam).toMatchObject({
      from: { backend: 'claude', model: 'source/model' },
      to: { backend: 'codex', model: null },
      lossless: false,
    });
    expect(launchedMessage).toBe(outbound);
    expect(launchedMessage.endsWith(currentOperatorMessage)).toBe(true);
  });

  it('does not replay after the destination has produced the latest attributed turn', async () => {
    const loaded = await loadModules();
    const threadId = 'thoughts-handoff-once';
    seedSourceThread(loaded, threadId);
    loaded.history.appendMobileOrchestratorUserMessage({
      tabId: threadId,
      repoPath: loaded.repoPath,
      message: 'Continue here.',
      backend: 'codex',
      timestampMs: 2_000,
    });
    loaded.history.upsertMobileOrchestratorAssistantMessage({
      tabId: threadId,
      repoPath: loaded.repoPath,
      messageId: 'assistant-destination',
      content: 'The destination continued the work.',
      backend: 'codex',
      model: 'destination/model',
      timestampMs: 2_001,
    });

    await expect(loaded.handoff.prepareBackendSwitchHandoff({
      threadId,
      to: { backend: 'codex', model: 'destination/model' },
    })).resolves.toBeNull();
  });

  it('seeds a return switch even when that backend still has an older native session', async () => {
    const loaded = await loadModules();
    const threadId = 'thoughts-handoff-return';
    seedSourceThread(loaded, threadId);
    loaded.history.appendMobileOrchestratorUserMessage({
      tabId: threadId,
      repoPath: loaded.repoPath,
      message: 'A second backend did more work.',
      backend: 'codex',
      timestampMs: 2_000,
    });
    loaded.history.upsertMobileOrchestratorAssistantMessage({
      tabId: threadId,
      repoPath: loaded.repoPath,
      messageId: 'assistant-second',
      content: 'The intervening change is complete.',
      backend: 'codex',
      model: 'destination/model',
      timestampMs: 2_001,
    });

    const returned = await loaded.handoff.prepareBackendSwitchHandoff({
      threadId,
      to: { backend: 'claude', model: 'return/model' },
    });

    expect(returned?.seam).toMatchObject({
      from: { backend: 'codex', model: 'destination/model' },
      to: { backend: 'claude', model: 'return/model' },
      lossless: false,
    });
    expect(returned?.prelude).toContain('The intervening change is complete.');
  });

  it('excludes the already-persisted current message when preparing an automatic fallback', async () => {
    const loaded = await loadModules();
    const threadId = 'thoughts-handoff-fallback';
    const currentMessageId = 'current-user-message';
    seedSourceThread(loaded, threadId);
    loaded.history.appendMobileOrchestratorUserMessage({
      tabId: threadId,
      repoPath: loaded.repoPath,
      message: 'This current turn should appear only after the packet.',
      messageId: currentMessageId,
      backend: 'claude',
      timestampMs: 2_000,
    });

    const prepared = await loaded.handoff.prepareBackendSwitchHandoff({
      threadId,
      to: { backend: 'o8', model: 'fallback/model' },
      excludeMessageId: currentMessageId,
    });

    expect(prepared?.packet.narrative.messages.map((message) => message.content))
      .not.toContain('This current turn should appear only after the packet.');
  });

  it('does not invent a handoff for a fresh or unattributed legacy thread', async () => {
    const loaded = await loadModules();
    const freshId = 'thoughts-handoff-fresh';
    loaded.history.appendMobileOrchestratorUserMessage({
      tabId: freshId,
      repoPath: loaded.repoPath,
      message: 'First message.',
      backend: 'codex',
    });
    await expect(loaded.handoff.prepareBackendSwitchHandoff({
      threadId: freshId,
      to: { backend: 'codex', model: null },
    })).resolves.toBeNull();

    const legacyId = 'thoughts-handoff-legacy';
    loaded.history.appendMobileOrchestratorUserMessage({
      tabId: legacyId,
      repoPath: loaded.repoPath,
      message: 'Legacy prompt.',
      backend: 'claude',
    });
    loaded.history.upsertMobileOrchestratorAssistantMessage({
      tabId: legacyId,
      repoPath: loaded.repoPath,
      messageId: 'legacy-assistant',
      content: 'Legacy reply with unknown attribution.',
    });
    await expect(loaded.handoff.prepareBackendSwitchHandoff({
      threadId: legacyId,
      to: { backend: 'codex', model: null },
    })).resolves.toBeNull();
  });
});
