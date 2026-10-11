// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ preload: vi.fn(), rendered: vi.fn() }));
vi.mock('@pierre/diffs', async (original) => ({ ...await original<typeof import('@pierre/diffs')>(), preloadHighlighter: mocks.preload }));
vi.mock('@pierre/diffs/react', () => ({ File: (props: unknown) => { mocks.rendered(props); return createElement('div', { 'data-rendered-file': true }, 'Colored code'); } }));
import PierreFileView from './PierreFileView';
import { SyntaxFileView } from './SyntaxFileView';

let host: HTMLDivElement;
let root: Root;
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); host = document.createElement('div'); document.body.append(host); root = createRoot(host); mocks.preload.mockReset(); mocks.rendered.mockClear(); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('prepares the shared code palette and rejects a stale file preparation', async () => {
  const complete: Array<() => void> = [];
  mocks.preload.mockImplementation(() => new Promise<void>((resolve) => complete.push(resolve)));
  const render = (path: string, content: string) => createElement(PierreFileView, { path, content, fallback: createElement('pre', null, content) });
  await act(async () => root.render(render('one.ts', 'const first = 1;')));
  expect(host.textContent).toBe('const first = 1;');
  await act(async () => root.render(render('two.json', '{"second":2}')));
  await act(async () => complete[0]());
  expect(host.textContent).toBe('{"second":2}');
  expect(mocks.rendered).not.toHaveBeenCalled();
  await act(async () => complete[1]());
  expect(mocks.rendered.mock.calls.at(-1)?.[0]).toMatchObject({ file: { name: 'two.json', contents: '{"second":2}' }, options: { theme: 'o8-pr-code', overflow: 'wrap', disableFileHeader: true } });
  expect(mocks.preload.mock.calls.map(([options]) => options.langs)).toEqual([['typescript'], ['json']]);
});

it('keeps the exact source visible when highlighting fails and supports Retry', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  mocks.preload.mockRejectedValueOnce(new Error('Missing language chunk')).mockResolvedValue(undefined);
  const content = 'const example = "<script>safe text</script>";\r\n';
  await act(async () => root.render(createElement(SyntaxFileView, { path: 'safe.ts', content })));
  expect(host.querySelector('pre')?.textContent).toBe(content);
  expect(host.querySelector('script')).toBeNull();
  expect(host.textContent).toContain('Syntax colors are unavailable.');
  await act(async () => host.querySelector<HTMLButtonElement>('button')!.click());
  expect(host.querySelector('[data-rendered-file]')).not.toBeNull();
});
