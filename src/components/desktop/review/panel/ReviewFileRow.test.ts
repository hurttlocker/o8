// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReviewFileRow } from './ReviewFileRow';
import type { ReviewChangedFile } from '@/lib/fleet/types';

let host: HTMLDivElement; let root: Root; let visible: (entries: Array<{ isIntersecting: boolean }>) => void;
const render = (file: ReviewChangedFile, options: { initialOpen?: boolean; preloadedDiff?: string; diffBase?: string } = {}) => act(async () => root.render(createElement(ReviewFileRow, { file, repoPath: '/workspace/site', mode: 'unified', wrap: true, wordDiff: false, hideWhitespace: false, richPreview: false, initialOpen: true, collapseSignal: { open: true, nonce: 0 }, focusSignal: { path: null, nonce: 0 }, selected: false, setRowRef() {}, ...options })));
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal('IntersectionObserver', class { constructor(callback: typeof visible) { visible = callback; } observe() {} disconnect() {} });
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ diff: '' })));
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
describe('review file presentation', () => {
  it('loads images only on expansion and near the viewport, and opens the exact file in Files', async () => {
    vi.mocked(fetch).mockResolvedValue(Response.json({ type: 'image', dataUrl: 'data:image/png;base64,eA==', size: 123 }));
    await render({ path: 'public/hero.png', status: 'added' }, { initialOpen: false });
    expect(fetch).not.toHaveBeenCalled();
    await act(async () => host.querySelector<HTMLButtonElement>('button')!.click()); expect(fetch).not.toHaveBeenCalled();
    await act(async () => visible([{ isIntersecting: true }]));
    expect(fetch).toHaveBeenCalledOnce(); expect(String(vi.mocked(fetch).mock.calls[0][0])).toContain('/api/panel/file-preview?');
    const image = host.querySelector('img')!; expect(image.alt).toBe('hero.png'); expect(image.style.maxHeight).toBe('240px');
    const open = vi.fn(); window.addEventListener('o8:browse-review-file', open);
    await act(async () => [...host.querySelectorAll('button')].find((button) => button.textContent === 'Open in Files')!.click());
    expect((open.mock.calls[0][0] as CustomEvent).detail).toEqual({ repoPath: '/workspace/site', path: 'public/hero.png' });
    window.removeEventListener('o8:browse-review-file', open);
  });
  it('keeps SVG scripts out of the DOM and provides an actual source diff', async () => {
    vi.mocked(fetch).mockImplementation(async (url) => String(url).includes('file-preview') ? Response.json({ type: 'svg', content: '<svg><script>alert(1)</script></svg>' }) : Response.json({ diff: '@@ -1 +1 @@\n-old\n+new', kind: 'image' }));
    await render({ path: 'public/icon.svg', status: 'modified' }); await act(async () => visible([{ isIntersecting: true }]));
    expect(host.querySelector('script')).toBeNull(); expect(host.querySelector('img')?.src).toMatch(/^data:image\/svg\+xml/);
    await act(async () => [...host.querySelectorAll('button')].find((button) => button.textContent === 'Source diff')!.click());
    expect(host.querySelector('img')).toBeNull(); expect(host.textContent).toContain('+new');
  });
  it('replaces legacy binary headers and oversized files with compact descriptive cards', async () => {
    await render({ path: 'archive.bin', status: 'added' }, { preloadedDiff: 'diff --git a/archive.bin b/archive.bin\nBinary files /dev/null and b/archive.bin differ' });
    expect(host.textContent).toContain('Binary file'); expect(host.textContent).not.toContain('diff --git');
    await act(async () => root.unmount()); root = createRoot(host);
    vi.mocked(fetch).mockResolvedValue(Response.json({ diff: '', kind: 'text', size: 11 * 1024 * 1024, diffStatus: 'too_large' }));
    await render({ path: 'large.txt', status: 'modified' });
    expect(host.textContent).toContain('Large text file'); expect(host.textContent).toContain('11.0 MB'); expect(host.textContent).toContain('Open in Files');
  });
  it('labels nested repositories and historical images without previewing a different working copy', async () => {
    vi.mocked(fetch).mockResolvedValue(Response.json({ diff: '', kind: 'directory', diffStatus: 'directory' }));
    await render({ path: '.worktrees/session', status: 'untracked' });
    expect(host.textContent).toContain('Nested repository or folder'); expect(host.textContent).toContain('Browse in Files');
    await act(async () => root.unmount()); root = createRoot(host); vi.mocked(fetch).mockClear();
    await render({ path: 'public/hero.jpg', status: 'modified' }, { diffBase: 'main', preloadedDiff: 'Binary files a/hero.jpg and b/hero.jpg differ' });
    expect(fetch).not.toHaveBeenCalled(); expect(host.textContent).toContain('Open working copy in Files'); expect(host.querySelector('img')).toBeNull();
  });
});
