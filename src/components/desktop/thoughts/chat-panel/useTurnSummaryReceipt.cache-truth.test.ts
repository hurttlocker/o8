// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import { TurnSummaryCard } from './TurnSummaryCard';
import { useTurnSummaryReceipt } from './useTurnSummaryReceipt';

type Input = Parameters<typeof useTurnSummaryReceipt>[0];
type Tokens = NonNullable<MobileTranscriptEntry['tokens']>;
const missionState: Input['missionState'] = { version: 2, prompt: '', summary: '', packets: [], updatedAt: '' };
const observed: Tokens = { input: 100, output: 10, cacheRead: 100, cacheWrite: 0 };
let root: Root; let host: HTMLDivElement;
const telemetry = vi.fn(async () => ({ totalTokens: null, estimatedCostUsd: null, model: null }));
function Receipt({ status, messages }: { status: Input['stream']['status']; messages: MobileTranscriptEntry[] }) {
  const summary = useTurnSummaryReceipt({ displayMessages: messages, isChatMode: false, isOrchestratorMode: true,
    missionState, repoPath: null, threadId: 'fixture-thread',
    stream: { status, runningTotal: 0, fetchTelemetrySnapshot: telemetry } });
  return summary ? createElement(TurnSummaryCard, { summary }) : null;
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected cache probe'); }));
  telemetry.mockClear();
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals();
});
async function completeTurn(tokens: Tokens[]) {
  const render = (status: Input['stream']['status'], messages: MobileTranscriptEntry[] = []) => act(async () => {
    root.render(createElement(Receipt, { status, messages }));
  });
  await render('ready'); await render('busy');
  await render('ready', tokens.map((value, i) => ({ id: `assistant-${i}`, role: 'assistant', text: 'Fixture reply', tokens: value })));
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Show turn details"]')!.click());
  expect(telemetry).toHaveBeenCalledTimes(2);
  expect(fetch).not.toHaveBeenCalled();
  expect(host.textContent).toContain('tokens');
}

it.each([
  ['mixed cache-aware and unreported', [observed, { input: 100, output: 10 }]],
  ['zero reads mixed with unreported', [{ ...observed, cacheRead: 0 }, { input: 100, output: 10 }]],
  ['explicit undefined reads', [{ ...observed, cacheRead: undefined }]],
  ['non-finite reads', [{ ...observed, cacheRead: Number.NaN }]],
  ['negative reads', [{ ...observed, cacheRead: -1 }]],
  ['non-finite input', [{ ...observed, input: Infinity }]],
  ['negative input', [{ ...observed, input: -1 }]],
  ['non-finite writes', [{ ...observed, cacheWrite: Infinity }]],
  ['negative writes', [{ ...observed, cacheWrite: -1 }]],
] satisfies Array<[string, Tokens[]]>)('omits a whole-turn cache claim for %s evidence', async (_name, tokens) => {
  await completeTurn(tokens);
  expect(host.textContent).not.toMatch(/prompt cached|cold prompt/);
});
it.each([
  [[observed], '50.0% prompt cached', '210 tokens'],
  [[observed, { input: 100, output: 10, cacheRead: 0, cacheWrite: 100 }], '25.0% prompt cached', '420 tokens'],
  [[{ input: 100, output: 10, cacheRead: 0 }], 'cold prompt', '110 tokens'],
] satisfies Array<[Tokens[], string, string]>)('keeps complete observed cache statistics and token totals (%s)', async (tokens, label, total) => {
  await completeTurn(tokens);
  expect(host.textContent).toContain(label);
  expect(host.textContent).toContain(total);
});
