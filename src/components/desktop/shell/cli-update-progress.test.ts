// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { ConnectedCliUpdateRows } from './ConnectedCliUpdateRows';
import { readCliUpdateResponse } from '@/lib/app-update/cli-update-response';
import type { CliUpdateStage } from '@/lib/setup/cli-update-progress';

it('shows each CLI stage and completion independently, including OpenCode, without a percentage', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host); const update = vi.fn();
  const tools = ['opencode', 'codex'].map(runtimeId => ({ runtimeId, label: runtimeId, selectedPath: `/fixture/${runtimeId}`, installedVersion: '1.0.0', latestVersion: '1.1.0', status: 'update-available' as const, updateUrl: 'https://example.test', updateSupported: true }));
  try {
    await act(async () => root.render(createElement(ConnectedCliUpdateRows, { tools, busy: null, onUpdate: update })));
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Update opencode"]')!.click());
    expect(update).not.toHaveBeenCalled();
    expect(host.textContent).toContain('Updates may introduce breaking changes');
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Confirm update opencode"]')!.click());
    expect(update).toHaveBeenCalledExactlyOnceWith('opencode');
    for (const [stage, label] of [['checking', 'Checking installation'], ['installing', 'Updating'], ['verifying', 'Verifying version'], ['succeeded', 'Verified'], ['failed', 'Update stopped']] as const) {
      await act(async () => root.render(createElement(ConnectedCliUpdateRows, { tools, busy: stage === 'succeeded' || stage === 'failed' ? null : 'opencode', progress: { opencode: { stage, startedAt: Date.now(), updatedAt: Date.now() } }, onUpdate: update })));
      expect(host.querySelector('[data-cli-update-row="opencode"] [role="status"]')?.textContent).toContain(label);
      expect(host.querySelector('[data-cli-update-row="codex"] [role="status"]')).toBeNull();
      expect(host.textContent).not.toContain('%');
    }
  } finally { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); }
});

it('consumes chunked progress but requires the verified terminal result', async () => {
  const text = 'event: progress\ndata: {"stage":"installing"}\n\nevent: progress\ndata: {"stage":"verifying"}\n\nevent: result\ndata: {"status":"succeeded"}\n\n';
  const chunks = [text.slice(0, 28), text.slice(28, 76), text.slice(76)];
  const stream = new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk)); controller.close(); } });
  const stages: CliUpdateStage[] = [];
  await readCliUpdateResponse(new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } }), stage => stages.push(stage));
  expect(stages).toEqual(['installing', 'verifying']);
  await expect(readCliUpdateResponse(new Response('event: progress\ndata: {"stage":"verifying"}\n\n', { headers: { 'Content-Type': 'text/event-stream' } }), () => {})).rejects.toThrow('before verification');
  await expect(readCliUpdateResponse(new Response('event: error\ndata: {"error":"Wait for active sessions"}\n\n', { headers: { 'Content-Type': 'text/event-stream' } }), () => {})).rejects.toThrow('Wait for active sessions');
});

it('offers an Update entry for externally managed tools without pretending an installer ran', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host); const update = vi.fn();
  try {
    await act(async () => root.render(createElement(ConnectedCliUpdateRows, { tools: [{ runtimeId: 'hermes', label: 'Hermes', selectedPath: '/fixture/hermes', installedVersion: null, latestVersion: null, status: 'unknown', updateUrl: '', updateSupported: false }], busy: null, onUpdate: update })));
    expect(host.textContent).not.toContain('Instructions');
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Update Hermes"]')!.click());
    expect(host.textContent).toContain('original updater'); expect(update).not.toHaveBeenCalled();
    expect(host.querySelector('[aria-label="Open updater for Hermes"]')).not.toBeNull();
  } finally { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); }
});
