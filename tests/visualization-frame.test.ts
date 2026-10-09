// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ nonce: '', doc: { kind: 'o8-visualization' as const, id: 'vis-11111111-1111-4111-8111-111111111111', title: 'Comparison', height: 300,
  createdAt: '2026-10-09T00:00:00Z', html: '<p>Comparison</p>', repoPath: '/workspace', threadId: null, packetId: null } }));
vi.mock('@/lib/theme/context', () => ({ useTheme: () => ({ paletteId: 'dark' }) }));
vi.mock('@/lib/visualizations/document', () => ({ visualizationSrcdoc: async (_html: string, nonce: string) => { fixture.nonce = nonce; return '<p>Fixture</p>'; } }));
vi.mock('@/components/desktop/visualizations/theme', () => ({ readVisualizationTheme: () => ({ colorScheme: 'dark', variables: {} }) }));
vi.mock('@/components/desktop/visualizations/document-cache', () => ({ cachedVisualization: () => fixture.doc, loadVisualization: async () => fixture.doc }));
vi.mock('@/components/desktop/settings/shared', () => ({ RamsButton: ({ children, onClick }: { children: React.ReactNode; onClick: () => void }) => React.createElement('button', { onClick }, children) }));
const { VisualizationFrame } = await import('@/components/desktop/visualizations/VisualizationFrame');
afterEach(() => { document.body.replaceChildren(); localStorage.clear(); vi.unstubAllGlobals(); });

it('reviews a focused frame proposal when WebKit does not forward transient activation', async () => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('navigator', { userActivation: { isActive: false } });
  const node = document.createElement('div'); document.body.append(node);
  const composer = document.createElement('textarea'); composer.dataset.o8ActiveComposer = 'true'; document.body.append(composer);
  const root = createRoot(node);
  try {
    await act(async () => root.render(React.createElement(VisualizationFrame, { reference: fixture.doc, expanded: true })));
    const frame = node.querySelector('iframe')!; frame.focus();
    const proposal = { type: 'o8-visualization:question', nonce: fixture.nonce, value: 'Explain the selected values' };
    await act(async () => window.dispatchEvent(new MessageEvent('message', { source: window, origin: 'null', data: proposal })));
    expect(node.textContent).not.toContain(proposal.value);
    await act(async () => window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, origin: 'null', data: proposal })));
    expect(node.textContent).toContain(proposal.value); expect(composer.value).toBe('');
    await act(async () => [...node.querySelectorAll('button')].find(button => button.textContent === 'Add to chat')!.click());
    expect(composer.value).toContain(proposal.value);
  } finally { await act(async () => root.unmount()); }
});
