// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MuseConnectionSection } from './MuseConnectionSection';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
const request = vi.fn();
beforeEach(async () => {
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  request.mockReset(); vi.stubGlobal('fetch', request);
  await act(async () => root.render(createElement(MuseConnectionSection)));
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

it('opens setup without starting a probe, inference, or a settings write', () => {
  expect(request).not.toHaveBeenCalled();
  expect(container.querySelector('a')?.href).toBe('https://dev.meta.ai/docs/muse-code');
  expect(container.textContent).toContain('Remaining account capacity is not reported');
});

it('coalesces repeated checks and keeps account access unknown after catalog discovery', async () => {
  let settle!: (response: Response) => void;
  request.mockReturnValue(new Promise<Response>(resolve => { settle = resolve; }));
  const button = container.querySelector('button')!;
  await act(async () => { button.click(); button.click(); });
  expect(request).toHaveBeenCalledTimes(1);
  expect(button.disabled).toBe(true);
  await act(async () => { settle(Response.json({ available: true, groups: [{ models: [{ id: 'muse-wonder', label: 'Muse Wonder' }] }] })); });
  expect(container.textContent).toContain('Muse Wonder');
  expect(container.textContent).toContain('Account access is checked when work starts');
  expect(button.disabled).toBe(false);
});

it('offers a clear retry after the installed runtime cannot connect', async () => {
  request.mockResolvedValue(Response.json({ available: true, error: 'provider unavailable' }));
  await act(async () => container.querySelector<HTMLButtonElement>('button')!.click());
  expect(container.textContent).toContain('Sign in through Muse Code, then retry');
  expect(container.querySelector<HTMLButtonElement>('button')!.disabled).toBe(false);
});
