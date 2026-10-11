// @vitest-environment jsdom

import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { NextRequest } from 'next/server';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileViewer } from '../FileViewer';
import { getRichMarkdownEditorView } from './RichMarkdownEditor';

vi.mock('next/dynamic', async () => {
  const { createElement: element } = await import('react');
  return { default: () => (props: { value: string }) => element('textarea', {
    'data-testid': 'source-editor', value: props.value, readOnly: true,
  }) };
});
vi.mock('@monaco-editor/react', () => ({ loader: { init: vi.fn() } }));
vi.mock('@/lib/theme/context', () => ({ useTheme: () => ({ themeId: 'light-solid' }) }));
vi.mock('@/lib/hooks/use-tauri-file-drop', () => ({ useTauriFileDrop: () => ({ dragOver: false }) }));
vi.mock('../lucide-shims', () => ({ FileText: () => createElement('svg') }));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// All persisted registry entries, documents, and binary assets belong to this
// fixture. Production content/asset routes, scope resolution, and file opens
// are deliberately not mocked. No listener or remote image request is needed.
const fixture = mkdtempSync(join(tmpdir(), 'o8-rich-images-'));
const dataDir = join(fixture, 'data');
const repos = [join(fixture, 'repo-a'), join(fixture, 'repo-b')];
const oldDataDir = process.env.CORTEX_IDE_DATA_DIR;
process.env.CORTEX_IDE_DATA_DIR = dataDir;
mkdirSync(dataDir);
const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><path d="M0 0h1v1H0z"/></svg>';
for (const [index, repo] of repos.entries()) {
  mkdirSync(join(repo, 'assets'), { recursive: true });
  mkdirSync(join(repo, 'docs', 'assets'), { recursive: true });
  writeFileSync(join(repo, 'assets', 'demo.gif'), gif);
  writeFileSync(join(repo, 'docs', 'assets', 'diagram space.svg'), svg.replace('1v1', `${index + 1}v1`));
  writeFileSync(join(repo, 'assets', 'unsupported.txt'), 'not an image');
}
writeFileSync(join(fixture, 'outside.gif'), gif);
symlinkSync(join(fixture, 'outside.gif'), join(repos[0], 'assets', 'linked.gif'));
symlinkSync(fixture, join(repos[0], 'linked-directory'), 'dir');
writeFileSync(join(dataDir, 'repos.json'), JSON.stringify({
  version: 1,
  repos: repos.map((localPath, index) => ({ id: `image-repo-${index}`, name: `image-repo-${index}`, localPath })),
}));

let readContent: typeof import('@/app/api/panel/file-content/route').GET;
let readAsset: typeof import('@/app/api/panel/file-asset/route').GET;
beforeAll(async () => {
  ({ GET: readContent } = await import('@/app/api/panel/file-content/route'));
  ({ GET: readAsset } = await import('@/app/api/panel/file-asset/route'));
});
afterAll(() => {
  if (oldDataDir === undefined) delete process.env.CORTEX_IDE_DATA_DIR;
  else process.env.CORTEX_IDE_DATA_DIR = oldDataDir;
  rmSync(fixture, { recursive: true, force: true });
});

describe('Rich Markdown images through FileViewer and the workspace asset route', () => {
  let container: HTMLDivElement;
  let root: Root;
  const saves: Array<{ content: string }> = [];

  beforeEach(() => {
    saves.length = 0;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    Object.defineProperties(Range.prototype, {
      getClientRects: { configurable: true, value: () => [] },
      getBoundingClientRect: { configurable: true, value: () => new DOMRect() },
    });
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      if (url.pathname === '/api/panel/file-content') return readContent(new Request(url));
      if (url.pathname === '/api/panel/file-diff') return Response.json({ diff: '', hasDiff: false });
      if (url.pathname === '/api/v2/files' && init?.method === 'POST') {
        saves.push(JSON.parse(String(init.body)) as { content: string });
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

  async function renderFile(repo: string, filePath: string, source: string) {
    mkdirSync(dirname(join(repo, filePath)), { recursive: true });
    writeFileSync(join(repo, filePath), source);
    await act(async () => { root.render(createElement(FileViewer, { workspace: repo, filePath })); });
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

  async function requestImage(img = image()): Promise<Response> {
    const url = new URL(img.getAttribute('src')!, 'http://localhost');
    expect(url.pathname).toBe('/api/panel/file-asset');
    const response = await readAsset(new NextRequest(url));
    act(() => img.dispatchEvent(new Event(response.ok ? 'load' : 'error')));
    return response;
  }

  it('renders the root README GIF without replacing the raw Markdown URL', async () => {
    const source = '# Demo\n\n![Animation](./assets/demo.gif "Example")\n';
    const view = await renderFile(repos[0], 'README.md', source);
    const response = await requestImage();
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/gif');
    expect(Buffer.from(await response.arrayBuffer())).toEqual(gif);
    expect(image().alt).toBe('Animation');
    expect(image().title).toBe('Example');
    expect(view.sourceChangeCount).toBe(0);
    expect(view.state.doc.lastChild?.firstChild?.attrs.src).toBe('./assets/demo.gif');
    act(() => button('Source').click());
    expect(container.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe(source);
    act(() => button('Rich').click());
    act(() => view.dispatch(view.state.tr.insertText(' changed', 7)));
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true })); });
    expect(saves.at(-1)?.content).toContain('![Animation](./assets/demo.gif "Example")');
    expect(saves.at(-1)?.content).not.toContain('/api/panel/file-asset');
  });

  it.each(['./assets/diagram%20space.svg', './assets/diagram space.svg', '../docs/assets/diagram%20space.svg'])(
    'resolves nested documents and spaces (%s)', async (src) => {
      await renderFile(repos[0], 'docs/guide.md', `![Diagram](<${src}>)\n`);
      const response = await requestImage();
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(svg);
      expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
    },
  );

  it('updates same-named assets after document/repository switches and reopening', async () => {
    const source = '![Diagram](./assets/diagram%20space.svg)\n';
    await renderFile(repos[0], 'docs/first.md', source);
    expect(await (await requestImage()).text()).toBe(svg);
    const previousImage = image();
    await renderFile(repos[1], 'docs/first.md', source);
    expect(await (await requestImage()).text()).toBe(readFileSync(join(repos[1], 'docs/assets/diagram space.svg'), 'utf8'));
    act(() => previousImage.dispatchEvent(new Event('error')));
    expect(image().hidden).toBe(false);
    await renderFile(repos[1], 'README.md', '![Animation](./assets/demo.gif)\n');
    expect((await requestImage()).status).toBe(200);
    act(() => root.render(null));
    await renderFile(repos[0], 'docs/first.md', source);
    expect(await (await requestImage()).text()).toBe(svg);
  });

  it.each([
    ['./assets/missing.gif', 404],
    ['./assets/unsupported.txt', 415],
    ['../outside.gif', 404],
    ['./assets/linked.gif', 404],
    ['/outside.gif', 404],
    ['%2E%2E/outside.gif', 404],
    ['./linked-directory/outside.gif', 404],
  ])('keeps asset denial and compact accessible feedback for %s', async (src, status) => {
    await renderFile(repos[0], 'README.md', `![Example](<${src}>)\n`);
    expect((await requestImage()).status).toBe(status);
    expect(image().hidden).toBe(true);
    expect(image().style.display).toBe('none');
    const fallback = container.querySelector('[role="img"][aria-label="Image unavailable: Example"]');
    expect(fallback?.textContent).toContain('Image unavailable');
    expect((fallback as HTMLElement).style.width).not.toBe('100%');
  });

  it('replaces failed images when their Markdown target is edited', async () => {
    const view = await renderFile(repos[0], 'README.md', '![Example](./assets/missing.gif)\n');
    const oldImage = image();
    expect((await requestImage()).status).toBe(404);
    act(() => view.dispatch(view.state.tr.setNodeMarkup(1, undefined, {
      ...view.state.doc.firstChild!.firstChild!.attrs, src: './assets/demo.gif',
    })));
    expect(image()).not.toBe(oldImage);
    expect((await requestImage()).status).toBe(200);
    act(() => oldImage.dispatchEvent(new Event('error')));
    expect(image().hidden).toBe(false);
    expect(container.querySelector('[role="img"][aria-label^="Image unavailable"]')).toBeNull();
  });

  it('keeps unregistered workspaces rejected at the existing asset boundary', async () => {
    await renderFile(repos[0], 'README.md', '![Animation](./assets/demo.gif)\n');
    const url = new URL(image().getAttribute('src')!, 'http://localhost');
    expect(url.pathname).toBe('/api/panel/file-asset');
    url.searchParams.set('workspace', fixture);
    expect((await readAsset(new NextRequest(url))).status).toBe(400);
  });

  it('leaves remote image URLs unchanged without making remote requests', async () => {
    const remote = 'https://example.invalid/badge.svg';
    const view = await renderFile(repos[0], 'README.md', `![Badge](${remote})\n`);
    expect(image().getAttribute('src')).toBe(remote);
    expect(view.sourceChangeCount).toBe(0);
  });
});
