// @vitest-environment jsdom

import { execFile } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { act, createElement, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startJudgmentEndpointFixture, type JudgmentEndpointFixture } from './fixtures/judgment-endpoint';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import type { RuntimeTelemetry } from '@/lib/runtimes/types';

// Only discovery and the API's surrounding panel/repo checks are replaced.
// The bridge process, runtime telemetry, React trigger, compact route, scorer
// HTTP transport, summarizer process, history store and archive are real.
vi.mock('@/lib/codex/sessions', async (original) => ({
  ...await original<typeof import('@/lib/codex/sessions')>(),
  getCodexRolloutPath: async () => process.env.O8_COMPACTION_TEST_ROLLOUT,
}));
vi.mock('@/lib/panel/auth', () => ({ requirePanelAuth: () => null }));
vi.mock('@/lib/repos/repo-path-registry', () => ({
  resolveRepoPathFromRegistry: async (repoRoot: string) => ({ ok: true, repoRoot }),
}));

const rootDir = mkdtempSync(join(tmpdir(), 'o8-compaction-context-'));
const dataDir = join(rootDir, 'data');
const repoPath = join(rootDir, 'repo');
const binary = join(rootDir, 'fixture-codex.mjs');
const rollout = join(rootDir, 'rollout.jsonl');
const promptCapture = join(rootDir, 'prompt.txt');
vi.stubEnv('CORTEX_IDE_DATA_DIR', dataDir);
vi.stubEnv('O8_DATA_DIR', dataDir);
vi.stubEnv('O8_CODEX_BIN', binary);
vi.stubEnv('O8_COMPACTION_TEST_ROLLOUT', rollout);
mkdirSync(join(dataDir, 'chat-history'), { recursive: true });
mkdirSync(repoPath);
writeFileSync(binary, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
const out = (message) => console.log(JSON.stringify(message));
if (process.argv.includes('--version')) { console.log('codex-cli 0.161.0'); process.exit(0); }
if (process.argv[2] !== 'app-server') {
  const prompt = process.argv.at(-1);
  writeFileSync(${JSON.stringify(promptCapture)}, prompt);
  const text = ['Decisions made', prompt.includes('Decision: use cursor pagination.') ? '- Use cursor pagination.' : '- None.',
    'Files touched', '- None.', 'Open questions', '- None.', 'Current mission state',
    prompt.includes('Finding: offsets skip records.') ? '- Offsets skip records.' : '- Investigation has not started.',
    prompt.includes('Evidence: 42 records recovered.') ? '- 42 records recovered.' : '- No tool evidence.'].join('\\n');
  out({ type: 'item.completed', item: { type: 'agent_message', text } });
  out({ type: 'turn.completed', usage: { input_tokens: 500, output_tokens: 80 } });
  process.exit(0);
}
let buffer = '';
const threadId = 'synthetic-context-thread';
const notify = (method, params) => out({ method, params: { threadId, turnId: 'turn-1', ...params } });
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let at;
  while ((at = buffer.indexOf('\\n')) >= 0) {
    const message = JSON.parse(buffer.slice(0, at));
    buffer = buffer.slice(at + 1);
    if (message.method === 'initialize') out({ id: message.id, result: {} });
    if (message.method === 'thread/start') out({ id: message.id, result: { thread: { id: threadId } } });
    if (message.method === 'turn/start') {
      out({ id: message.id, result: { turn: { id: 'turn-1' } } });
      for (let i = 0; i < 16; i++) {
        notify('item/completed', { item: { type: 'mcpToolCall', id: 'tool-' + i, tool: 'inspect_records',
          result: { content: [{ type: 'text', text: 'Evidence: 42 records recovered.' }] } } });
        const inputTokens = Number(process.env.O8_COMPACTION_TEST_CONTEXT);
        notify('thread/tokenUsage/updated', { tokenUsage: {
          last: { inputTokens, cachedInputTokens: 18000, outputTokens: 100, reasoningOutputTokens: 0, totalTokens: inputTokens + 100 },
          total: { inputTokens: inputTokens * (i + 1), cachedInputTokens: 18000 * (i + 1), outputTokens: 100 * (i + 1),
            reasoningOutputTokens: 0, totalTokens: (inputTokens + 100) * (i + 1) },
          modelContextWindow: 1000000,
        } });
      }
      notify('item/completed', { item: { type: 'agentMessage', id: 'answer', text: 'Finding: offsets skip records. Decision: use cursor pagination.' } });
      notify('turn/completed', { turn: { id: 'turn-1', status: 'completed' } });
    }
  }
});
`);
chmodSync(binary, 0o700);

const { codexRuntime } = await import('@/lib/runtimes/codex');
const { handleCodexJsonLine } = await import('@/lib/lane/codex-orchestrator-events');
const { POST } = await import('@/app/api/orchestrator/compact/route');
const { updateOperatorDefaults } = await import('@/lib/operator/defaults');
const { judgmentKeyPath } = await import('@/lib/judgment/key');
const { setCompactionScorerTransportForTests } = await import('@/lib/orchestrator/compaction-scorer');
const { useOrchestratorTokenTelemetry } = await import('@/components/desktop/thoughts/use-orchestrator-stream/token-telemetry');
const { useOrchestratorAutoCompaction } = await import('@/components/desktop/thoughts/use-orchestrator-stream/auto-compaction');
let fixture: JudgmentEndpointFixture;
const nativeFetch = globalThis.fetch;

beforeAll(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  await updateOperatorDefaults({ inAppOrchestratorEnabled: true, judgmentProvider: 'typesafe', productTelemetryEnabled: false });
  fixture = await startJudgmentEndpointFixture();
  writeFileSync(judgmentKeyPath(), 'synthetic-compaction-key');
  chmodSync(judgmentKeyPath(), 0o600);
  setCompactionScorerTransportForTests({ endpoint: fixture.endpoint, timeoutMs: 2_000, maxAttempts: 1 });
});
afterAll(async () => {
  setCompactionScorerTransportForTests(undefined);
  await fixture.close();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  rmSync(rootDir, { recursive: true, force: true });
});

async function replay(threadId: string, promptTokens: number) {
  const specPath = join(rootDir, 'spec.json');
  writeFileSync(specPath, JSON.stringify({ codexBin: binary, cwd: repoPath, threadId: null,
    message: 'Inspect pagination.', imagePaths: [], config: {}, model: 'gpt-5.5', effort: 'medium', sandbox: 'read-only' }));
  const { stdout } = await promisify(execFile)(process.execPath, ['--import', 'tsx', resolve('src/lib/codex/app-server-exec-bridge.ts'), specPath], {
    env: { ...process.env, O8_COMPACTION_TEST_CONTEXT: String(promptTokens) }, timeout: 15_000,
  });
  writeFileSync(rollout, stdout);
  const assistant: MobileTranscriptEntry = { id: 'answer', role: 'assistant', text: '', toolCalls: [] };
  for (const line of stdout.trim().split('\n')) {
    handleCodexJsonLine(line, { threadId: null, cost: null }, (event) => {
      if (event.type === 'text') assistant.text += event.text;
      if (event.type === 'tool_use') assistant.toolCalls!.push({ id: event.id, name: event.name, status: 'done' });
      if (event.type === 'tool_result') assistant.toolCalls!.find((tool) => tool.id === event.id)!.result = event.output;
    }, { isLocalModel: true });
  }
  expect(assistant.toolCalls).toHaveLength(16);
  const historyPath = join(dataDir, 'chat-history', `${threadId}.json`);
  writeFileSync(historyPath, JSON.stringify({ repoPath, messages: [
    { id: 'question', role: 'user', content: 'Inspect pagination.' },
    { ...assistant, content: assistant.text },
  ] }));
  return { historyPath, telemetry: (await codexRuntime.getTelemetry!('codex:synthetic-context-thread'))! };
}

async function runTrigger(threadId: string, telemetry: RuntimeTelemetry) {
  let compacted: Record<string, unknown> | undefined;
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).startsWith('/api/runtime/telemetry')) return Response.json({ telemetry });
    if (String(url).startsWith(fixture.endpoint)) return nativeFetch(url, init);
    const response = await POST(new NextRequest('http://localhost/api/orchestrator/compact', {
      ...init, signal: init?.signal ?? undefined,
    }));
    compacted = await response.clone().json();
    return response;
  });
  vi.stubGlobal('fetch', fetchMock);
  function Harness() {
    const [runningTotal, updateRunningTotal] = useState(0);
    const threadIdRef = useRef<string | null>(threadId);
    const lastBackendRef = useRef<string | null>('codex');
    const [, setTokenCount] = useState(0);
    const { refreshTokenTelemetry, requestCompaction } = useOrchestratorTokenTelemetry({
      repoPathRef: useRef(repoPath), threadIdRef, lastBackendRef, updateRunningTotal, setTokenCount,
      telemetryBindingRef: useRef<string | null>(null), telemetryTotalRef: useRef<number | null>(null),
    });
    useEffect(() => { void refreshTokenTelemetry(); }, [refreshTokenTelemetry]);
    useOrchestratorAutoCompaction({ repoPath, threadId, runningTotal, status: 'ready',
      threadIdRef, statusRef: useRef('ready'), lastBackendRef,
      inFlightRef: useRef(false), armedRef: useRef(true),
      requestCompaction, primeCompactedSession: async () => {} });
    return null;
  }
  const host = document.createElement('div');
  const root = createRoot(host);
  await act(async () => root.render(createElement(Harness)));
  // Let the production 800 ms between-turn timer run, including the actual processes and HTTP scorer.
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1_100)); });
  if ((telemetry.contextTokens ?? 0) >= 300_000) await vi.waitFor(() => expect(compacted?.applied).toBeDefined(), { timeout: 10_000 });
  await act(async () => root.unmount());
  return { compacted, fetchMock };
}

describe('auto compaction context through bridge, telemetry, trigger and persisted compact route', () => {
  it('does not compact a 16-tool-call turn whose summed usage exceeds the threshold but last prompt does not', async () => {
    const { historyPath, telemetry } = await replay('thoughts-small-context', 24_000);
    const before = readFileSync(historyPath, 'utf8');
    expect(telemetry.totalTokens).toBe(385_600);
    const { compacted } = await runTrigger('thoughts-small-context', telemetry);
    expect(compacted).toBeUndefined();
    expect(readFileSync(historyPath, 'utf8')).toBe(before);
    expect(telemetry.contextTokens).toBe(24_000);
  });

  it('summarizes the completed answer and tool results, scores both entries, and records the measured context source', async () => {
    fixture.reset();
    fixture.replies.push({ status: 200, body: { model: 'synthetic', answers: {
      entry_question: { type: 'noul', noul: 0.8 }, entry_answer: { type: 'noul', noul: 0.9 },
    } } });
    const { historyPath, telemetry } = await replay('thoughts-large-context', 320_000);
    const { compacted } = await runTrigger('thoughts-large-context', telemetry);
    expect(compacted?.applied).toBe(true);
    const stored = JSON.parse(readFileSync(historyPath, 'utf8'));
    const record = stored.messages[0].compaction;
    // Assert findings first: the old split sends only the user to the summarizer.
    expect(record.summary).toContain('Offsets skip records.');
    expect(record.summary).toContain('Use cursor pagination.');
    expect(record.summary).toContain('42 records recovered.');
    expect(record.tokensBefore).toBe(320_000);
    expect(record.contextSource).toBe('codex-token-count-last-input');
    expect(Object.keys(record.scorer.scores)).toEqual(['question', 'answer']);
    const state = fixture.seen[0].body.state as { entries: Array<{ text: string }> };
    expect(state.entries[1].text).toContain('Decision: use cursor pagination.');
    expect(state.entries[1].text).toContain('Evidence: 42 records recovered.');
    expect(readFileSync(promptCapture, 'utf8')).toContain('Evidence: 42 records recovered.');
    const archive = JSON.parse(readFileSync(join(dataDir, 'orchestrator-archives', record.archiveRef), 'utf8'));
    expect(archive.turns.map((entry: { id: string }) => entry.id)).toEqual(['question', 'answer']);
    expect(archive.turns[1].toolCalls).toHaveLength(16);
  });

  it('uses the latest native token_count prompt even after a larger earlier request', async () => {
    const { historyPath } = await replay('thoughts-native-context', 24_000);
    const before = readFileSync(historyPath, 'utf8');
    writeFileSync(rollout, [350_000, 27_000].map((input_tokens) => JSON.stringify({
      type: 'event_msg', payload: { type: 'token_count', info: {
        last_token_usage: { input_tokens, cached_input_tokens: 20_000, output_tokens: 100 },
        total_token_usage: { input_tokens: 900_000, cached_input_tokens: 800_000, output_tokens: 2_000 },
      } },
    })).join('\n'));
    const telemetry = (await codexRuntime.getTelemetry!('codex:synthetic-context-thread'))!;
    expect(telemetry.contextTokens).toBe(27_000);
    expect((await runTrigger('thoughts-native-context', telemetry)).compacted).toBeUndefined();
    expect(readFileSync(historyPath, 'utf8')).toBe(before);
  });

  it('does not treat a billing-only runtime report as measured context', async () => {
    const { historyPath } = await replay('thoughts-unknown-context', 24_000);
    const before = readFileSync(historyPath, 'utf8');
    writeFileSync(rollout, JSON.stringify({ type: 'turn.completed', usage: {
      input_tokens: 700_000, cached_input_tokens: 600_000, output_tokens: 5_000,
    } }));
    const telemetry = (await codexRuntime.getTelemetry!('codex:synthetic-context-thread'))!;
    expect(telemetry.totalTokens).toBe(705_000);
    expect(telemetry.contextTokens).toBeUndefined();
    expect((await runTrigger('thoughts-unknown-context', telemetry)).compacted).toBeUndefined();
    expect(readFileSync(historyPath, 'utf8')).toBe(before);
  });
});
