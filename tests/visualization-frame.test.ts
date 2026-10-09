// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { VisualizationDocument } from '@/lib/visualizations/types';

const fixture = vi.hoisted(() => ({ nonce: '', doc: { kind: 'o8-visualization' as const, id: 'vis-11111111-1111-4111-8111-111111111111', title: 'Comparison', height: 300,
  createdAt: '2026-10-09T00:00:00Z', html: '<p>Comparison</p>', repoPath: '/workspace', threadId: null, packetId: null } as VisualizationDocument,
  pending: undefined as Promise<VisualizationDocument> | undefined, states: [] as Record<string, unknown>[] }));
vi.mock('@/lib/theme/context', () => ({ useTheme: () => ({ paletteId: 'dark' }) }));
vi.mock('@/lib/visualizations/document', () => ({ visualizationSrcdoc: async (_html: string, nonce: string, _theme: unknown, state: Record<string, unknown>) => { fixture.nonce = nonce; fixture.states.push(state); return '<p>Fixture</p>'; } }));
vi.mock('@/components/desktop/visualizations/theme', () => ({ readVisualizationTheme: () => ({ colorScheme: 'dark', variables: {} }) }));
vi.mock('@/components/desktop/visualizations/document-cache', () => ({ cachedVisualization: (id: string) => id === fixture.doc.id ? fixture.doc : undefined,
  loadVisualization: (id: string) => id === fixture.doc.id ? Promise.resolve(fixture.doc) : fixture.pending }));
vi.mock('@/components/desktop/settings/shared', () => ({ RamsButton: ({ children, onClick }: { children: React.ReactNode; onClick: () => void }) => React.createElement('button', { onClick }, children) }));
const { VisualizationFrame } = await import('@/components/desktop/visualizations/VisualizationFrame');
beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  fixture.pending = undefined; fixture.states = [];
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ result: { versions: [fixture.doc] } }) })));
});
afterEach(() => { document.body.replaceChildren(); localStorage.clear(); vi.unstubAllGlobals(); });

it('reviews a focused frame proposal when WebKit does not forward transient activation', async () => {
  vi.stubGlobal('navigator', { userActivation: { isActive: false } });
  const node = document.createElement('div'); document.body.append(node);
  const composer = document.createElement('textarea'); composer.dataset.o8ActiveComposer = 'true'; document.body.append(composer);
  const root = createRoot(node);
  try {
    await act(async () => root.render(React.createElement(VisualizationFrame, { reference: fixture.doc, expanded: true })));
    const frame = node.querySelector('iframe')!; await act(async () => frame.focus());
    const proposal = { type: 'o8-visualization:question', nonce: fixture.nonce, value: 'Explain the selected values' };
    await act(async () => window.dispatchEvent(new MessageEvent('message', { source: window, origin: 'null', data: proposal })));
    expect(node.textContent).not.toContain(proposal.value);
    await act(async () => window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, origin: 'null', data: proposal })));
    expect(node.textContent).toContain(proposal.value); expect(composer.value).toBe('');
    await act(async () => [...node.querySelectorAll('button')].find(button => button.textContent === 'Add to chat')!.click());
    expect(composer.value).toContain(proposal.value);
  } finally { await act(async () => root.unmount()); }
});

it('replaces the old frame while a revision loads and preserves choices under the root id', async () => {
  const reference = { ...fixture.doc, rootId: fixture.doc.id, version: 1 };
  const revised = { ...reference, id: 'vis-22222222-2222-4222-8222-222222222222', parentId: reference.id, version: 2, html: '<p>Quiet revision</p>' };
  let resolve!: (document: VisualizationDocument) => void;
  fixture.pending = new Promise<VisualizationDocument>(done => { resolve = done; });
  const node = document.createElement('div'); document.body.append(node); const root = createRoot(node);
  try {
    await act(async () => root.render(React.createElement(VisualizationFrame, { reference, expanded: true })));
    const oldFrame = node.querySelector('iframe')!, oldNonce = fixture.nonce;
    const state = { links: { exploration: { seriesId: 'review', x: 2 } }, dashboards: { exploration: { plot: 'bar' } } };
    await act(async () => window.dispatchEvent(new MessageEvent('message', { source: oldFrame.contentWindow, origin: 'null',
      data: { type: 'o8-visualization:state', nonce: oldNonce, value: state } })));
    await act(async () => root.render(React.createElement(VisualizationFrame, { reference: revised, expanded: true })));
    expect(node.querySelector('iframe')).toBeNull(); expect(node.textContent).toContain('Loading visualization');
    await act(async () => { resolve(revised); });
    const current = node.querySelector('iframe')!;
    expect(current).not.toBe(oldFrame); expect(fixture.nonce).not.toBe(oldNonce); expect(fixture.states.at(-1)).toEqual(state);
    await act(async () => current.focus());
    await act(async () => window.dispatchEvent(new MessageEvent('message', { source: oldFrame.contentWindow, origin: 'null',
      data: { type: 'o8-visualization:question', nonce: oldNonce, value: 'Old frame proposal' } })));
    expect(node.textContent).not.toContain('Old frame proposal');
    await act(async () => window.dispatchEvent(new MessageEvent('message', { source: current.contentWindow, origin: 'null',
      data: { type: 'o8-visualization:height', nonce: fixture.nonce, height: 240 } })));
    await act(async () => [...node.querySelectorAll('button')].find(button => button.textContent === 'Refine visual')!.click());
    expect(node.textContent).toContain(`id: ${revised.id}`);
  } finally { await act(async () => root.unmount()); }
});
