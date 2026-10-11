// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileViewer } from '../FileViewer';
import { getRichMarkdownEditorView } from './RichMarkdownEditor';

vi.mock('next/dynamic', async () => {
  const { createElement: element } = await import('react');
  return { default: () => (props: { value: string }) => element('textarea', {
    value: props.value, readOnly: true,
  }) };
});
vi.mock('@monaco-editor/react', () => ({ loader: { init: vi.fn() } }));
vi.mock('@/lib/theme/context', () => ({ useTheme: () => ({ themeId: 'light-solid' }) }));
vi.mock('@/lib/hooks/use-tauri-file-drop', () => ({ useTauriFileDrop: () => ({ dragOver: false }) }));
vi.mock('../lucide-shims', () => ({ FileText: () => createElement('svg') }));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// FileViewer and its ProseMirror node views run unchanged. File reads/writes
// use a retained source fixture; synthetic image events make no remote request.
// jsdom cannot prove geometry. Native failed SVG/raster layout and successful
// illustration proportions require separate acceptance.
describe('failed images through FileViewer Rich mode', () => {
  let container: HTMLDivElement;
  let root: Root;
  let storedSource: string;
  let writes: string[];

  beforeEach(() => {
    storedSource = '';
    writes = [];
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    Object.defineProperties(Range.prototype, {
      getClientRects: { configurable: true, value: () => [] },
      getBoundingClientRect: { configurable: true, value: () => new DOMRect() },
    });
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      if (url.pathname === '/api/panel/file-content') return Response.json({ content: storedSource, contentHash: 'fixture-hash' });
      if (url.pathname === '/api/panel/file-diff') return Response.json({ diff: '', hasDiff: false });
      if (url.pathname === '/api/v2/files' && init?.method === 'POST') {
        storedSource = (JSON.parse(String(init.body)) as { content: string }).content;
        writes.push(storedSource);
        return Response.json({ contentHash: 'saved-hash' });
      }
      throw new Error(`Unexpected request: ${url.pathname}`);
    }));
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    Reflect.deleteProperty(Range.prototype, 'getClientRects');
    Reflect.deleteProperty(Range.prototype, 'getBoundingClientRect');
    vi.unstubAllGlobals();
  });

  function button(label: string): HTMLButtonElement {
    const found = [...container.querySelectorAll('button')].find((item) => item.textContent === label);
    if (!found) throw new Error(`Missing ${label} button`);
    return found;
  }

  async function openFile(source?: string) {
    if (source !== undefined) storedSource = source;
    await act(async () => { root.render(createElement(FileViewer, { filePath: 'README.md' })); });
    await vi.waitFor(async () => {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
      expect(container.textContent).toContain('Rich');
    });
    act(() => button('Rich').click());
    const mount = container.querySelector('[data-rich-markdown-editor="true"]');
    expect(mount).not.toBeNull();
    return getRichMarkdownEditorView(mount!)!;
  }

  function image(): HTMLImageElement {
    const result = container.querySelector<HTMLImageElement>('[data-rich-markdown-editor] img');
    expect(result).not.toBeNull();
    return result!;
  }

  it.each(['svg', 'png'])(
    'keeps failed external %s badges accessible, linked, and unchanged across reopen', async (extension) => {
      const remote = `https://example.invalid/release-badge.${extension}`;
      const destination = 'https://example.invalid/releases';
      const source = `[![Release](${remote} "Latest release")](${destination})\n\nUseful prose.\n`;
      const location = window.location.href;
      container.style.width = '700px';
      const view = await openFile(source);
      const doc = view.state.doc;
      const img = image();
      const anchor = img.closest('a')!;
      const clicked = vi.fn();
      anchor.addEventListener('click', clicked);

      act(() => img.dispatchEvent(new Event('error')));
      expect(img.hidden).toBe(true);
      expect(img.style.display).toBe('none');
      const fallback = container.querySelector<HTMLElement>('[role="img"][aria-label="Image unavailable: Release"]');
      expect(fallback).not.toBeNull();
      expect(fallback!.textContent).toContain('Image unavailable: Release');
      expect(fallback!.closest('a')).toBe(anchor);
      expect(anchor.getAttribute('href')).toBe(destination);
      expect(clicked).not.toHaveBeenCalled();
      expect(window.location.href).toBe(location);
      const click = new Event('click', { bubbles: true, cancelable: true });
      act(() => fallback!.dispatchEvent(click));
      expect(clicked).toHaveBeenCalledOnce();
      expect(click.defaultPrevented).toBe(false);
      expect(view.state.doc).toBe(doc);
      expect(view.sourceChangeCount).toBe(0);
      expect(container.textContent).toContain('Useful prose.');

      container.style.width = '260px';
      act(() => window.dispatchEvent(new Event('resize')));
      expect(img.hidden).toBe(true);
      act(() => button('Source').click());
      expect(container.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe(source);
      act(() => root.render(null));
      const reopened = await openFile();
      expect(image().getAttribute('src')).toBe(remote);
      act(() => image().dispatchEvent(new Event('error')));
      expect(image().hidden).toBe(true);
      expect(container.querySelector('[aria-label="Image unavailable: Release"]')?.closest('a')?.getAttribute('href')).toBe(destination);
      expect(reopened.sourceChangeCount).toBe(0);
      await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true })); });
      expect(writes).toHaveLength(0);
      act(() => root.render(null));
      expect(storedSource).toBe(source);
    },
  );

  it('bounds a long failed-image label while retaining its full accessible meaning', async () => {
    const alt = `Release ${'details '.repeat(200)}`.trim();
    await openFile(`![${alt}](https://example.invalid/badge.svg)\n`);
    act(() => image().dispatchEvent(new Event('error')));
    const fallback = container.querySelector<HTMLElement>('[role="img"]');
    expect(fallback?.getAttribute('aria-label')).toBe(`Image unavailable: ${alt}`);
    const label = fallback!.querySelector<HTMLElement>('span')!;
    expect(label.textContent).toBe(`Image unavailable: ${alt}`);
    expect(label.style.whiteSpace).toBe('nowrap');
    expect(label.style.overflow).toBe('hidden');
    expect(label.style.textOverflow).toBe('ellipsis');
    expect(label.style.maxWidth).toBe('100%');
  });

  it('uses the raw URL as accessible feedback when an external image has no alt text', async () => {
    const remote = 'https://example.invalid/badge.png';
    await openFile(`![](${remote})\n`);
    act(() => image().dispatchEvent(new Event('error')));
    expect(container.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe(`Image unavailable: ${remote}`);
  });

  it.each(['https://example.invalid/illustration.svg', './assets/demo.gif'])(
    'restores the image after a successful retry without changing source (%s)', async (src) => {
      const source = `![Illustration](<${src}> "Example")\n`;
      const view = await openFile(source);
      const doc = view.state.doc;
      const img = image();
      const displaySrc = img.getAttribute('src');
      act(() => img.dispatchEvent(new Event('error')));
      expect(img.hidden).toBe(true);
      act(() => {
        img.setAttribute('src', displaySrc!);
        img.dispatchEvent(new Event('load'));
      });
      expect(img.hidden).toBe(false);
      expect(img.style.display).toBe('inline-block');
      expect(img.style.height).toBe('auto');
      expect(img.style.maxWidth).toBe('100%');
      expect(img.style.width).toBe('');
      expect(img.style.maxHeight).toBe('');
      expect(img.hasAttribute('width')).toBe(false);
      expect(img.hasAttribute('height')).toBe(false);
      expect(img.alt).toBe('Illustration');
      expect(img.title).toBe('Example');
      expect(container.querySelector('[role="img"][aria-label^="Image unavailable"]')).toBeNull();
      expect(img.nextElementSibling?.hasAttribute('hidden')).toBe(true);
      expect(view.state.doc).toBe(doc);
      expect(view.sourceChangeCount).toBe(0);
      act(() => button('Source').click());
      expect(container.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe(source);
      expect(storedSource).toBe(source);
    },
  );
});
