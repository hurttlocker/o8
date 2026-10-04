// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FileViewer } from './FileViewer';

describe('right Files Markdown Preview', () => {
  let container: HTMLDivElement;
  let root: Root;
  let files: Record<string, string>;
  let reads: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    files = {};
    reads = vi.fn(async (input: string) => {
      const file = new URL(input, 'https://example.test').searchParams.get('path') ?? '';
      return new Response(JSON.stringify({ content: files[file] }), {
        headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', reads);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  async function open(selectedFile: string | null = 'procedure.md') {
    await act(async () => {
      root.render(createElement(FileViewer, { repoPath: '/workspace/example', selectedFile }));
    });
  }

  async function selectView(label: 'Source' | 'Preview') {
    const button = [...container.querySelectorAll('button')]
      .find((candidate) => candidate.textContent?.toLowerCase() === label.toLowerCase());
    expect(button).toBeDefined();
    await act(async () => button!.click());
  }

  function topLists() {
    return [...container.querySelectorAll<HTMLOListElement>('ol')]
      .filter((list) => !list.parentElement?.closest('ol, ul'));
  }

  function listNumbers(list: HTMLOListElement) {
    return [...list.querySelectorAll(':scope > li')].map((_, index) => list.start + index);
  }

  it.each([
    ['sequential markers', '1. First\n2. Second\n3. Third', [1, 2, 3]],
    ['repeated markers', '1. First\n1. Second\n1. Third', [1, 2, 3]],
    ['non-1 starting marker', '7. First\n1. Second\n1. Third', [7, 8, 9]],
    ['blank-separated items', '1. First\n\n1. Second\n\n1. Third', [1, 2, 3]],
    ['CRLF source', '1. First\r\n1. Second\r\n1. Third\r\n', [1, 2, 3]],
    ['nonsequential later markers', '3. First\n9. Second\n2. Third', [3, 4, 5]],
    ['parenthesis markers', '7) First\n1) Second\n1) Third', [7, 8, 9]],
    ['zero starting marker', '0. First\n1. Second\n1. Third', [0, 1, 2]],
  ])('renders %s as one sequential ordered list', async (_, source, expected) => {
    files['procedure.md'] = source as string;
    await open();

    expect(topLists()).toHaveLength(1);
    expect(listNumbers(topLists()[0])).toEqual(expected);
    expect([...topLists()[0].children].map((item) => item.textContent)).toEqual(['First', 'Second', 'Third']);
    expect(container.querySelector('textarea')).toBeNull();
  });

  it('keeps ordered and unordered children inside their own parent items', async () => {
    files['procedure.md'] = '1. Parent\n\n   3. Child one\n   1. Child two\n1. Parent two\n   - Bullet one\n   - Bullet two\n1. Final';
    await open();

    expect(topLists()).toHaveLength(1);
    expect(listNumbers(topLists()[0])).toEqual([1, 2, 3]);
    const nested = container.querySelector<HTMLOListElement>('ol > li > ol');
    expect(nested).not.toBeNull();
    expect(listNumbers(nested!)).toEqual([3, 4]);
    expect([...nested!.children].map((item) => item.textContent)).toEqual(['Child one', 'Child two']);
    const bullets = container.querySelector('ol > li > ul');
    expect([...bullets!.children].map((item) => item.textContent)).toEqual(['Bullet one', 'Bullet two']);
  });

  it('keeps continuation paragraphs in their item and inline formatting intact', async () => {
    files['procedure.md'] = '1. **First** with [guide](https://example.com/guide)\n   continued text\n\n   More `detail`.\n1. Second';
    await open();

    expect(topLists()).toHaveLength(1);
    expect(listNumbers(topLists()[0])).toEqual([1, 2]);
    const first = topLists()[0].children[0];
    expect(first.querySelector('strong')?.textContent).toBe('First');
    expect(first.querySelector('a')?.getAttribute('href')).toBe('https://example.com/guide');
    expect(first.querySelector('code')?.textContent).toBe('detail');
    expect(first.textContent).toContain('continued text');
    expect(first.textContent).toContain('More detail.');
  });

  it('restarts separate lists at prose and code boundaries without consuming surrounding content', async () => {
    files['procedure.md'] = '# Procedure\n\nBefore.\n\n1. First\n1. Second\n\nBetween.\n\n7. Third\n1. Fourth\n\n```text\n1. Literal code\n1. Still code\n```\n\n1. Fifth\n1. Sixth\n\n> After.';
    await open();

    expect(topLists()).toHaveLength(3);
    expect(topLists().map(listNumbers)).toEqual([[1, 2], [7, 8], [1, 2]]);
    expect(container.querySelector('h1')?.textContent).toBe('Procedure');
    expect([...container.querySelectorAll('p')].map((node) => node.textContent)).toContain('Between.');
    expect(container.querySelector('pre code')?.textContent).toBe('1. Literal code\n1. Still code');
    expect(container.querySelector('blockquote')?.textContent).toBe('After.');
  });

  it.each([440, 260])('preserves source bytes across repeat, switch, and reopen journeys at %ipx', async (width) => {
    const source = '7. First\r\n1. Second\r\n\r\n1. Third\r\n';
    files['procedure.md'] = source;
    files['other.md'] = '1. Other\n1. Another';
    container.style.width = `${width}px`;
    await open();

    for (let repeat = 0; repeat < 2; repeat += 1) {
      await selectView('Source');
      // HTML textarea value normalizes CRLF, while its text child retains the supplied source.
      expect(container.querySelector('textarea')?.textContent).toBe(source);
      await selectView('Preview');
      expect(topLists()).toHaveLength(1);
      expect(listNumbers(topLists()[0])).toEqual([7, 8, 9]);
    }

    await open('other.md');
    expect(listNumbers(topLists()[0])).toEqual([1, 2]);
    await open();
    expect(listNumbers(topLists()[0])).toEqual([7, 8, 9]);
    await open(null);
    await open();
    expect(listNumbers(topLists()[0])).toEqual([7, 8, 9]);
    await selectView('Source');
    expect(container.querySelector('textarea')?.textContent).toBe(source);
    expect(container.textContent).not.toContain('Modified');
    expect([...container.querySelectorAll('button')].some((button) => button.textContent === 'Save')).toBe(false);
    expect(reads.mock.calls.every((call) => call.length === 1)).toBe(true);
    expect(files['procedure.md']).toBe(source);
  });

  it('preserves existing fenced HTML and SVG/iframe security boundaries beside lists', async () => {
    files['procedure.md'] = '1. First\n1. Second\n\n```html\n<p>HTML content</p>\n```\n\n<svg><script>evil()</script><text>Safe SVG</text></svg>\n\n<iframe src="https://example.com/frame"></iframe>\n\n1. Third\n1. Fourth';
    await open();

    expect(topLists()).toHaveLength(2);
    expect(topLists().map(listNumbers)).toEqual([[1, 2], [1, 2]]);
    const frames = [...container.querySelectorAll('iframe')];
    expect(frames).toHaveLength(1);
    expect(frames[0].getAttribute('sandbox')).toBe('allow-scripts');
    expect(frames[0].getAttribute('srcdoc')).toContain('Content-Security-Policy');
    expect(frames[0].getAttribute('srcdoc')).toContain("connect-src 'none'");
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('svg text')?.textContent).toBe('Safe SVG');
    expect(container.querySelector('iframe[src]')).toBeNull();
  });
});
