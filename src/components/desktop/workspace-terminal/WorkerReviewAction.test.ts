// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkerReviewAction } from './WorkerReviewAction';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe('shared worker review control', () => {
  let container: HTMLDivElement;
  let root: Root;
  const open = vi.fn();
  const select = vi.fn();
  const packet = { status: 'awaiting_review' as const, title: 'Review fixture' };
  const button = () => container.querySelector<HTMLButtonElement>('button')!;
  const render = async (props = {}) => {
    await act(async () => root.render(createElement('div', { onClick: select },
      createElement(WorkerReviewAction, { packet, onOpenReview: open, ...props }))));
  };
  const event = async (type: string) => {
    await act(async () => button().dispatchEvent(new MouseEvent(type, { bubbles: true })));
  };

  beforeEach(() => {
    open.mockClear(); select.mockClear();
    container = document.createElement('div'); document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount()); container.remove();
  });

  it.each([20, 30])('resets global button padding and protects the icon at %ipx', async (size) => {
    await render({ size });
    expect(button().style.width).toBe(`${size}px`);
    expect(button().style.height).toBe(`${size}px`);
    expect(button().style.padding).toBe('0px');
    expect(button().style.boxSizing).toBe('border-box');
    expect(button().querySelector('svg')!.style.flexShrink).toBe('0');
    expect(button().style.background).toBe('transparent');
    expect(button().style.color).toBe('var(--t-text-muted)');
  });

  it('retains hover feedback after blur and keyboard feedback after pointer exit', async () => {
    await render();
    await act(async () => button().focus());
    expect(button().style.background).toBe('var(--t-hover)');
    await event('mouseover');
    await act(async () => button().blur());
    expect(button().style.background).toBe('var(--t-hover)');
    await event('mouseout');
    expect(button().style.background).toBe('transparent');
    await act(async () => button().focus());
    await event('mouseover'); await event('mouseout');
    expect(button().style.background).toBe('var(--t-hover)');
    await act(async () => button().blur());
    expect(button().style.background).toBe('transparent');
  });

  it('keeps the accessible action and opens review without selecting its parent row', async () => {
    await render();
    expect(button().getAttribute('aria-label')).toBe('Review merge for Review fixture');
    expect(button().title).toBe('Review changes and merge checks');
    expect(button().querySelector('svg')!.getAttribute('aria-hidden')).toBe('true');
    await act(async () => button().click());
    expect(open).toHaveBeenCalledOnce(); expect(select).not.toHaveBeenCalled();
    await render({ packet: { ...packet, status: 'running' } });
    expect(button()).toBeNull();
    await render({ packet: { ...packet, status: 'blocked', blockedReason: 'Awaiting operator input' } });
    expect(button()).not.toBeNull();
    await render({ onOpenReview: undefined });
    expect(button()).toBeNull();
  });
});
