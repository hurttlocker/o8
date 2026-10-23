// @vitest-environment jsdom
import { act, createElement, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import { PacketCard } from './PacketCard';
import { O8ActivityPacketRow } from '@/components/desktop/o8-panel/O8ActivityPacketRow';

const context = vi.hoisted(() => ({ packets: [] as OrchestratorPacket[] }));
vi.mock('@/components/desktop/orchestrator-data-context', () => ({
  useOrchestratorData: () => ({ missionState: { packets: context.packets }, workspaceTargets: [] }),
}));

vi.mock('@/components/desktop/thoughts/ContextRecallCard', () => ({ ContextRecallCard: () => null }));
vi.mock('@/components/desktop/thoughts/PacketActionStrip', () => ({ PacketActionStrip: () => null }));
vi.mock('@/components/desktop/thoughts/PacketDetailsPopover', () => ({ PacketDetailsPopover: () => null }));
vi.mock('./PacketMetaRows', () => ({ PacketMetaRows: () => null }));
vi.mock('./PacketReviewCard', () => ({ PacketReviewCard: () => null }));
vi.mock('./PacketReviewPanel', () => ({ PacketReviewPanel: () => null }));
vi.mock('./review-card/PacketBuyinDocPane', () => ({ PacketBuyinDocPane: () => null }));
vi.mock('@/components/desktop/artifacts/ArtifactStrip', () => ({ ArtifactStrip: () => null }));
vi.mock('@/components/desktop/artifacts/useArtifacts', () => ({ useArtifacts: () => ({ artifacts: [] }) }));
vi.mock('./PacketSpecEditor', () => ({ PacketSpecEditor: () => null }));
vi.mock('./RejectedFeedbackPanel', () => ({ RejectedFeedbackPanel: () => null }));
vi.mock('@/components/desktop/orchestrator/PacketTabStrip', () => ({ PacketTabStrip: () => null }));
vi.mock('@/components/desktop/orchestrator/LivingAgentPanel', () => ({ LivingAgentPanel: () => null }));
vi.mock('./PacketSpendLine', () => ({ PacketSpendLine: () => null }));
vi.mock('./PacketClaimUnbackedRow', () => ({ PacketClaimUnbackedRow: () => null }));

const key = 'o8:first-merge-feedback';
const prompt = 'First merge done. Anything that nearly stopped you?';
let root: Root;
let host: HTMLDivElement;
let enabled: boolean;
let payloads: unknown[];
let reply: () => Promise<Response>;
let fetchMock: ReturnType<typeof vi.fn>;
const packet = (id = 'first', merged = false, date = '2026-10-23T12:00:00Z'): OrchestratorPacket => ({
  id, referenceLabel: '#2871', title: `Packet ${id}`, summary: 'Private task context', runtime: 'codex',
  workspaceTargetPath: '/private/project', branchTarget: 'fix/feedback', dependencyLabels: [], dependencyPacketIds: [],
  queueState: 'queued', releaseState: merged ? 'released' : 'pending', status: merged ? 'released' : 'running',
  releaseStatePayload: merged ? { mergeCommit: 'a'.repeat(40), releasedAt: date } : null,
});
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); localStorage.clear(); enabled = true; payloads = [];
  reply = async () => Response.json({ ok: true, reportId: 'receipt' });
  fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
    if (url === '/api/telemetry/config') return Response.json({ enabled });
    if (url === '/api/feedback/report') { payloads.push(JSON.parse(String(options?.body))); return reply(); }
    throw new Error(`Unexpected request ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function render(packets = [packet()], expanded = false) {
  const base = { isExpanded: expanded, onToggleExpanded: vi.fn(), editingField: null, onEditingFieldChange: vi.fn(),
    workspaceTargets: [], reviewState: null, onPatch: vi.fn(), onHoldChange: vi.fn(), pendingAction: null,
    onLaunch: vi.fn(), onFocus: vi.fn(), onDelete: vi.fn(), onReviewAction: vi.fn(), onToggleShowAllFiles: vi.fn(), onResume: vi.fn() };
  await act(async () => root.render(createElement('div', null, ...packets.map(p => createElement(PacketCard,
    { ...base, key: p.id, packet: p, allPackets: packets } as ComponentProps<typeof PacketCard>)))));
}
function button(text: string) { return [...host.querySelectorAll('button')].find(b => b.textContent === text)!; }
async function type(value = 'The next step was unclear.') {
  const field = host.querySelector<HTMLInputElement>('input[aria-label="First merge feedback"]')!;
  expect(field).not.toBeNull();
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value); field.dispatchEvent(new Event('input', { bubbles: true })); });
}

it('offers feedback only on a confirmed merged card, including while collapsed', async () => {
  await render(); expect(host.textContent).not.toContain(prompt); expect(fetchMock).not.toHaveBeenCalled();
  await render([packet('first', true)]); expect(host.textContent).toContain(prompt);
  expect(host.querySelector('[role="dialog"]')).toBeNull(); expect(payloads).toEqual([]);
});
it('does not confuse released read-only work or archived packets with a merge', async () => {
  await render([{ ...packet('read-only', true), releaseStatePayload: { releasedAt: '2026-10-23T12:00:00Z' } },
    { ...packet('archived'), status: 'archived' }]);
  expect(host.textContent).not.toContain(prompt); expect(localStorage.getItem(key)).toBeNull(); expect(fetchMock).not.toHaveBeenCalled();
});
it('chooses the earliest known merge and remembers dismissal across remounts and later packets', async () => {
  await render([packet('later', true, '2026-10-23T13:00:00Z'), packet('first', true)]);
  expect(host.textContent?.split(prompt)).toHaveLength(2);
  await act(async () => { button('Dismiss').focus(); button('Dismiss').click(); });
  expect(host.textContent).not.toContain(prompt); expect(document.activeElement?.textContent).toContain('Packet first');
  expect(JSON.parse(localStorage.getItem(key)!)).toMatchObject({ packetId: 'first', done: true });
  await render([]); await render([packet('another', true)]); expect(host.textContent).not.toContain(prompt);
});
it('posts only explicit text without metadata or ambient packet context and retires the prompt on receipt', async () => {
  await render([packet('first', true)]); await type();
  await act(async () => button('Send feedback').click());
  expect(payloads).toEqual([{ kind: 'feedback', message: 'The next step was unclear.', includeMetadata: false }]);
  expect(host.textContent).not.toContain(prompt);
  await render([]); await render([packet('first', true)]); expect(host.textContent).not.toContain(prompt);
});
it('keeps the draft after failure and retries only on an explicit click', async () => {
  reply = async () => Response.json({ error: 'Try again' }, { status: 503 });
  await render([packet('first', true)]); await type('Keep this draft.');
  await act(async () => button('Send feedback').click());
  expect(host.querySelector('input')?.value).toBe('Keep this draft.'); expect(host.textContent).toContain('Try again');
  expect(payloads).toHaveLength(1);
  reply = async () => Response.json({ ok: true, reportId: 'retry-receipt' });
  await act(async () => button('Send feedback').click()); expect(payloads).toHaveLength(2); expect(host.textContent).not.toContain(prompt);
});
it('preserves disabled sharing and still allows permanent dismissal', async () => {
  enabled = false; await render([packet('first', true)]); await type();
  expect(button('Send feedback').disabled).toBe(true); expect(payloads).toEqual([]);
  await act(async () => button('Dismiss').click()); expect(host.textContent).not.toContain(prompt);
  expect(fetchMock.mock.calls.every(([, options]) => !options?.method)).toBe(true);
});
it('suppresses duplicate clicks while an explicit submission is pending', async () => {
  let resolve!: (value: Response) => void; reply = () => new Promise(done => { resolve = done; });
  await render([packet('first', true)]); await type();
  await act(async () => { button('Send feedback').click(); button('Send feedback').click(); });
  expect(payloads).toHaveLength(1); expect(host.querySelector('input')?.disabled).toBe(true);
  await act(async () => resolve(Response.json({ ok: true, reportId: 'receipt' }))); expect(host.textContent).not.toContain(prompt);
});
it('does not move an unanswered prompt to another packet or reset it on expand', async () => {
  await render([packet('first', true)]); await type('Remember me.');
  await render([packet('first', true)], true); expect(host.querySelector('input')?.value).toBe('Remember me.');
  await render([packet('other', true)]); expect(host.textContent).not.toContain(prompt);
  await render([packet('first', true)]); expect(host.textContent).toContain(prompt);
});
it('does not offer feedback when its local persistence is malformed or unavailable', async () => {
  localStorage.setItem(key, 'invalid'); await render([packet('first', true)]);
  expect(host.textContent).not.toContain(prompt); expect(fetchMock).not.toHaveBeenCalled();
  localStorage.clear();
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('storage unavailable'); });
  await render([packet('other', true)]); expect(host.textContent).not.toContain(prompt); expect(payloads).toEqual([]);
});
it('honors a dismissal from another app window', async () => {
  await render([packet('first', true)]);
  await act(async () => {
    localStorage.setItem(key, JSON.stringify({ packetId: 'first', done: true }));
    window.dispatchEvent(new StorageEvent('storage', { key }));
  });
  expect(host.textContent).not.toContain(prompt); expect(payloads).toEqual([]);
});
it('records an explicit receipt arriving after the card closes without moving focus', async () => {
  let resolve!: (value: Response) => void; reply = () => new Promise(done => { resolve = done; });
  await render([packet('first', true)]); await type(); await act(async () => button('Send feedback').click());
  await render([]);
  await act(async () => resolve(Response.json({ ok: true, reportId: 'late-receipt' })));
  expect(JSON.parse(localStorage.getItem(key)!)).toMatchObject({ done: true });
  await render([packet('first', true)]); expect(host.textContent).not.toContain(prompt); expect(payloads).toHaveLength(1);
});
it('preserves the existing saved Files tab and its allowed-file contents', async () => {
  localStorage.setItem('cortex-ide:packet-tab:first', 'files');
  await render([{ ...packet(), allowedFiles: ['src/first.ts', 'src/second.ts'] }], true);
  expect(host.querySelector('[title="src/first.ts"]')?.textContent).toBe('src/first.ts');
  expect(host.querySelector('[title="src/second.ts"]')?.textContent).toBe('src/second.ts');
  expect(host.textContent).not.toContain(prompt);
});
it('reaches the question and sender through the production Activity row', async () => {
  const merged = packet('first', true); context.packets = [merged];
  const props = { packet: merged, onToggleExpanded: vi.fn() };
  await act(async () => root.render(createElement(O8ActivityPacketRow, { ...props, isExpanded: false })));
  expect(host.textContent).not.toContain(prompt); expect(fetchMock).not.toHaveBeenCalled();
  await act(async () => root.render(createElement(O8ActivityPacketRow, { ...props, isExpanded: true })));
  expect(host.textContent).toContain(prompt); await type('Keep this flow clear.');
  await act(async () => button('Send feedback').click());
  expect(payloads).toEqual([{ kind: 'feedback', message: 'Keep this flow clear.', includeMetadata: false }]);
  expect(JSON.parse(localStorage.getItem(key)!)).toMatchObject({ done: true });
});
