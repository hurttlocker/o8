import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { composeComposerModeMessage } from '@/components/desktop/thoughts/composer-mode';
import { buildOrchestratorSendPayload } from '@/components/desktop/thoughts/use-orchestrator-stream/send-payload';
import { compactTitleFromMessage } from '@/lib/llm/thread-auto-title';
import { resolveOrchestratorTranscriptMessage } from '@/lib/orchestrator/composer-wire';

const tempHomes: string[] = [];
const originalOpenRouterKey = process.env.OPENROUTER_API_KEY;
const originalO8DataDir = process.env.O8_DATA_DIR;
const originalCortexDataDir = process.env.CORTEX_IDE_DATA_DIR;

async function loadHistoryInTempHome() {
  const home = mkdtempSync(join(tmpdir(), 'o8-solo-send-'));
  tempHomes.push(home);
  process.env.O8_DATA_DIR = home;
  process.env.CORTEX_IDE_DATA_DIR = home;
  vi.resetModules();
  vi.doMock('node:os', async () => ({
    ...(await vi.importActual<typeof import('node:os')>('node:os')),
    homedir: () => home,
  }));
  delete process.env.OPENROUTER_API_KEY;
  return import('@/lib/mobile/orchestrator-thread-history');
}

afterEach(() => {
  vi.doUnmock('node:os');
  vi.resetModules();
  if (originalOpenRouterKey === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = originalOpenRouterKey;
  if (originalO8DataDir === undefined) delete process.env.O8_DATA_DIR;
  else process.env.O8_DATA_DIR = originalO8DataDir;
  if (originalCortexDataDir === undefined) delete process.env.CORTEX_IDE_DATA_DIR;
  else process.env.CORTEX_IDE_DATA_DIR = originalCortexDataDir;
  for (const home of tempHomes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});

describe('solo composer wire separation', () => {
  it('persists and titles the real solo send from operator text while keeping the directive on the wire', async () => {
    const operatorText = 'Fix the solo transcript title';
    const { displayMessage, wireMessage } = composeComposerModeMessage(operatorText, 'solo');
    const serializedPayload = buildOrchestratorSendPayload({
      repoPath: '/tmp/repo',
      threadId: 'thoughts-solo-wire-real-path',
      clientMessageId: 'solo-send-1',
      wireMessage,
      displayMessage,
      permissionMode: 'full',
      orchestrationMode: 'single',
      model: 'codex',
      backend: 'codex',
    });
    const payload = JSON.parse(serializedPayload) as {
      message: string;
      displayMessage?: unknown;
    };

    expect(payload.message).toContain('[Mode: Solo]');
    expect(payload.message).toContain(operatorText);
    expect(payload.displayMessage).toBe(operatorText);

    const history = await loadHistoryInTempHome();
    const transcriptMessage = resolveOrchestratorTranscriptMessage(payload);
    history.appendMobileOrchestratorUserMessage({
      tabId: 'thoughts-solo-wire-real-path',
      repoPath: '/tmp/repo',
      message: transcriptMessage,
      messageId: 'orch-user-solo-send-1',
      backend: 'codex',
      timestampMs: 1_000,
    });
    history.upsertMobileOrchestratorAssistantMessage({
      tabId: 'thoughts-solo-wire-real-path',
      repoPath: '/tmp/repo',
      messageId: 'assistant-1000',
      content: 'Done.',
      backend: 'codex',
      timestampMs: 1_001,
    });

    const filePath = history.safeOrchestratorHistoryPath('thoughts-solo-wire-real-path');
    const beforeTitle = JSON.parse(readFileSync(filePath, 'utf8')) as {
      messages: Array<Record<string, unknown>>;
    };
    const { POST, GET } = await import('@/app/api/v2/chat-history/route');
    const postResponse = await POST(new NextRequest('http://localhost/api/v2/chat-history', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tabId: 'thoughts-solo-wire-real-path',
        messages: beforeTitle.messages,
        repoPath: '/tmp/repo',
        backend: 'codex',
      }),
    }));
    expect(postResponse.status).toBe(200);

    const expectedTitle = compactTitleFromMessage(operatorText);
    await vi.waitFor(() => {
      const record = JSON.parse(readFileSync(filePath, 'utf8')) as { title?: string };
      expect(record.title).toBe(expectedTitle);
    });

    const getResponse = await GET(new NextRequest(
      'http://localhost/api/v2/chat-history?tabId=thoughts-solo-wire-real-path',
    ));
    const desktopHistory = await getResponse.json() as {
      title?: string;
      messages?: Array<{ role?: string; content?: string }>;
    };
    expect(desktopHistory.messages?.find((message) => message.role === 'user')?.content).toBe(operatorText);
    expect(desktopHistory.title).toBe(expectedTitle);
    expect(history.listMobileOrchestratorThreads()[0]?.title).toBe(expectedTitle);
    expect(JSON.stringify(desktopHistory)).not.toContain('[Mode: Solo]');
  });

  it('keeps legacy solo payloads without displayMessage out of persisted history', () => {
    const operatorText = 'Inspect the legacy thread';
    const { wireMessage } = composeComposerModeMessage(operatorText, 'solo');

    expect(resolveOrchestratorTranscriptMessage({ message: wireMessage })).toBe(operatorText);
  });
});
