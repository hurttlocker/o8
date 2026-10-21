// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ preload: vi.fn(), rendered: vi.fn() }));
vi.mock('@pierre/diffs', async (original) => ({ ...await original<typeof import('@pierre/diffs')>(), preloadHighlighter: mocks.preload }));
vi.mock('@pierre/diffs/react', () => ({ FileDiff: (props: unknown) => { mocks.rendered(props); return createElement('div', { 'data-rendered-diff': true }, 'Rendered code'); } }));
import PierrePrDiff from './PierrePrDiff';
import { PrDiffPatch } from './PrDiffPatch';
import type { PrFile } from './types';
let host: HTMLDivElement; let root: Root;
const file = (value: string): PrFile => ({ path: 'code.ts', status: 'modified', additions: 1, deletions: 1, patch: `@@ -1 +1 @@\n-const x = 1;\n+const x = ${value};` });
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); vi.clearAllMocks(); host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); });
describe('code view preparation', () => {
  it('keeps a named loading state until syntax assets are ready, then renders the current patch', async () => {
    let finish!: () => void; mocks.preload.mockReturnValue(new Promise<void>((resolve) => { finish = resolve; }));
    await act(async () => root.render(createElement(PierrePrDiff, { file: file('2'), diffStyle: 'unified' })));
    expect(host.textContent).toContain('Preparing code view'); expect(mocks.rendered).not.toHaveBeenCalled();
    await act(async () => finish()); expect(host.querySelector('[data-rendered-diff]')).not.toBeNull(); expect(mocks.preload.mock.calls[0][0]).toMatchObject({ themes: ['o8-pr-code'], langs: ['typescript'] });
  });
  it('shows the supplied patch and an in-place Retry when syntax loading fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {}); mocks.preload.mockRejectedValueOnce(new Error('Chunk unavailable')).mockResolvedValue(undefined);
    await act(async () => root.render(createElement(PrDiffPatch, { file: file('3') })));
    expect(host.querySelector('[role=alert]')?.textContent).toContain('supplied patch'); expect(host.querySelector('pre')?.textContent).toContain('+const x = 3;');
    await act(async () => host.querySelector<HTMLButtonElement>('button')!.click()); expect(host.querySelector('[data-rendered-diff]')).not.toBeNull();
  });
});
