// @vitest-environment jsdom
import { act, createElement, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { ChatListResizeEdge } from './ChatListResizeEdge';

it('keeps a full-height drag target, lights only the straight edge, and preserves bounded keyboard resizing', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div'); document.body.appendChild(host);
  const root = createRoot(host);
  const drag = vi.fn();
  function Harness({ glass }: { glass: boolean }) {
    const [width, setWidth] = useState(496);
    return createElement(ChatListResizeEdge, { width, glass, setWidth, onStartDrag: drag });
  }
  try {
    await act(async () => root.render(createElement(Harness, { glass: true })));
    const handle = host.querySelector<HTMLElement>('[role="separator"]')!;
    const edge = host.querySelector<HTMLElement>('[data-resize-glow]')!;
    const glow = edge;
    expect(edge.style.top).toBe('53px'); expect(edge.style.bottom).toBe('0px');
    expect(glow.style.opacity).toBe('0'); expect(glow.style.borderRadius).toBe('');
    expect(handle.style.width).toBe('6px');
    await act(async () => edge.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
    expect(glow.style.opacity).toBe('0.85');
    await act(async () => edge.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
    expect(drag).toHaveBeenCalledOnce();
    await act(async () => edge.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })));
    expect(glow.style.opacity).toBe('0.85');
    await act(async () => document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })));
    expect(glow.style.opacity).toBe('0');
    await act(async () => handle.focus()); expect(glow.style.opacity).toBe('0.85');
    await act(async () => handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })));
    expect(handle.getAttribute('aria-valuenow')).toBe('500');
    await act(async () => handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })));
    expect(handle.getAttribute('aria-valuenow')).toBe('484');
    await act(async () => root.render(createElement(Harness, { glass: false })));
    expect(host.querySelector<HTMLElement>('[data-resize-glow]')?.style.top).toBe('18px');
    expect(host.querySelector<HTMLElement>('[data-resize-glow]')?.style.bottom).toBe('18px');
  } finally {
    await act(async () => root.unmount()); host.remove();
  }
});
