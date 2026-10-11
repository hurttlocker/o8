// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { O8ScratchChat } from './O8ScratchChat';
import { MarkdownRender, proseWithoutBrainCitationMarkers } from '../markdown-render';

let finishCortexAskStream: (() => void) | null = null;

function cortexAskResponse(): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(
        'event: token\ndata: {"text":"Read [the guide](https://example.com/guide). The first result [CITATION:outcome-"}\n\n',
      ));
      finishCortexAskStream = () => {
        controller.enqueue(encoder.encode(
          'event: token\ndata: {"text":"row-1] and the second [O-outcome-row-2]."}\n\n'
          + 'event: citation\ndata: {"kind":"outcome","rowId":"row-1","title":"First source"}\n\n'
          + 'event: citation\ndata: {"kind":"outcome","rowId":"row-2","title":"Second source"}\n\n',
        ));
        controller.close();
      };
    },
  });
  return new Response(body, { status: 200 });
}

describe('O8ScratchChat Brain answers', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() });
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => cortexAskResponse()));
    finishCortexAskStream = null;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it('renders Brain prose without composer markers while keeping citation pills', async () => {
    await act(async () => {
      root.render(createElement(O8ScratchChat, {
        repoPath: '/workspace/o8',
        selectedFile: null,
        surface: 'diff',
      }));
    });

    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Ask o8"]')!.click();
    });
    const input = document.body.querySelector<HTMLTextAreaElement>('textarea[data-o8-scratch-input="true"]')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      setter.call(input, 'What changed?');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      [...document.body.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent === 'Ask Brain')!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // A split marker is not removed until the whole marker is available.
    expect(document.body.textContent).toContain('[CITATION:outcome-');
    await act(async () => {
      finishCortexAskStream!();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(document.body.textContent).toContain('Read the guide. The first result and the second.');
    expect(document.body.textContent).not.toContain('[CITATION:');
    expect(document.body.textContent).not.toContain('[O-outcome-');
    const guide = [...document.body.querySelectorAll<HTMLAnchorElement>('a')]
      .find((link) => link.textContent === 'the guide');
    expect(guide?.href).toBe('https://example.com/guide');
    expect(document.body.textContent).toContain('First source');
    expect(document.body.textContent).toContain('Second source');
  });

  it('preserves paragraph boundaries when stripping a leading citation marker', async () => {
    // Named invariant: citation_marker_strip_preserves_paragraph_boundaries
    const raw = 'First paragraph.\n\n[CITATION:source-1] Second paragraph.';
    const cleaned = proseWithoutBrainCitationMarkers(raw);
    expect(cleaned).toContain('\n\n');
    expect(cleaned).not.toBe('First paragraph. Second paragraph.');
    expect(cleaned).toBe('First paragraph.\n\n Second paragraph.');

    await act(async () => {
      root.render(createElement(MarkdownRender, { content: cleaned }));
    });

    const paragraphs = [...container.querySelectorAll('p')].map((node) => node.textContent);
    expect(paragraphs).toEqual(['First paragraph.', ' Second paragraph.']);
    expect(container.textContent).not.toContain('[CITATION:');
  });
});
