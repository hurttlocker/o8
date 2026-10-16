// @vitest-environment jsdom
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { GET } from '@/app/api/review/workspace/route';
import { ReviewPanel } from '@/components/desktop/review/ReviewPanel';

vi.mock('@/components/desktop/o8-panel/workspace-rail/O8ScratchChat', () => ({ O8ScratchChat: () => null }));
let folder: string;
afterEach(() => { vi.unstubAllGlobals(); if (folder) rmSync(folder, { recursive: true, force: true }); });
it('keeps accurate Review messages when navigating between real folders repeatedly', async () => {
  folder = mkdtempSync(join(tmpdir(), 'o8-review-panel-'));
  const plain = join(folder, 'plain'); mkdirSync(plain);
  const repo = join(folder, 'repo'); execFileSync('git', ['init', '-q', repo]);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('fetch', vi.fn(async (input: string) => input.startsWith('/api/review/workspace?')
    ? GET(new Request(new URL(input, 'http://localhost')))
    : Response.json({ ok: false, error: 'No architecture data in fixture', artifacts: [] })));
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  try {
    for (const location of [plain, repo, join(folder, 'missing'), plain, repo]) {
      await act(async () => root.render(createElement(ReviewPanel, { repoPath: location })));
      await vi.waitFor(async () => {
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
        const message = location === repo ? 'Working tree clean' : location === plain ? 'not a Git repository' : 'no longer available';
        expect(host.textContent).toContain(message);
      });
      if (location !== repo) {
        expect(host.textContent).not.toContain('Working tree clean');
        expect(host.querySelector('[aria-label="Commit"]')).toBeNull();
      }
    }
    await act(async () => root.render(createElement(ReviewPanel, { repoPath: plain })));
    await vi.waitFor(() => expect(host.textContent).toContain('not a Git repository'));
    execFileSync('git', ['init', '-q', plain]);
    await act(async () => host.querySelector<HTMLButtonElement>('[title="Refresh review"]')!.click());
    await vi.waitFor(async () => {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
      expect(host.textContent).toContain('Working tree clean');
    });
    expect(host.querySelector('[title="Refresh review"]')).toBeNull();
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).startsWith('/api/review/workspace?')).length).toBeGreaterThanOrEqual(5);
  } finally { await act(async () => root.unmount()); host.remove(); }
});
