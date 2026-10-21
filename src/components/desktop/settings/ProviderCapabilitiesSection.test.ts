// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { ProviderCapabilitiesSection } from './ProviderCapabilitiesSection';
it('does not turn unavailable usage into zero or accept a stale runtime response', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  let finish!: (value: Response) => void;
  const request = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue(Response.json({ capabilities: { resume: true, interrupt: true, streaming: true, costTelemetry: false } }));
  vi.stubGlobal('fetch', request);
  const host = document.createElement('div'); const root = createRoot(host);
  await act(async () => root.render(createElement(ProviderCapabilitiesSection, { runtimeId: 'codex' })));
  await act(async () => root.render(createElement(ProviderCapabilitiesSection, { runtimeId: 'muse' })));
  expect(host.textContent).toContain('Missing usage is unknown'); expect(host.textContent).toContain('Not reported');
  await act(async () => finish(Response.json({ capabilities: { costTelemetry: true } })));
  expect(host.textContent).not.toContain('Reported when available');
  await act(async () => root.unmount()); vi.unstubAllGlobals();
});
