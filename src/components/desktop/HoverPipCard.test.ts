// @vitest-environment jsdom

import { act, createElement, type ComponentProps, type ReactNode, type HTMLAttributes } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HoverPipCard } from './HoverPipCard';

vi.mock('framer-motion', () => ({
  AnimatePresence: ({ children }: { children: ReactNode }) => children,
  motion: { div: 'div' },
  useReducedMotion: () => false,
}));
vi.mock('@lisse/react', () => ({ SmoothCorners: ({ children, style }: HTMLAttributes<HTMLDivElement>) => createElement('div', { style }, children) }));
vi.mock('@/lib/theme/context', () => ({ useTheme: () => ({ workspaceGlass: true, surface: 'glass', paletteId: 'dark' }) }));

const ACT_ENV = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
ACT_ENV.IS_REACT_ACT_ENVIRONMENT = true;

function Preview({
  eventName,
  title,
  onOpen,
  contextKey,
}: {
  eventName: string;
  title: string;
  onOpen?: () => void;
  contextKey?: string;
}) {
  const props: ComponentProps<typeof HoverPipCard> = {
    active: true,
    available: true,
    eventName,
    storageKey: `${eventName}:orientation`,
    title,
    onOpen,
    contextKey,
    children: () => createElement('div', null, `${title} body`),
  };
  return createElement(HoverPipCard, props);
}

describe('HoverPipCard', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.clear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    localStorage.clear();
  });

  it('toggles explicitly and closes the previous preview when another opens', () => {
    act(() => {
      root.render(createElement('div', null,
        createElement(Preview, { eventName: 'test:first-pip', title: 'First' }),
        createElement(Preview, { eventName: 'test:second-pip', title: 'Second' }),
      ));
    });

    act(() => window.dispatchEvent(new CustomEvent('test:first-pip', { detail: { toggle: true } })));
    expect(container.textContent).toContain('First body');
    expect(container.textContent).not.toContain('Second body');

    act(() => window.dispatchEvent(new CustomEvent('test:second-pip', { detail: { toggle: true } })));
    expect(container.textContent).not.toContain('First body');
    expect(container.textContent).toContain('Second body');

    act(() => window.dispatchEvent(new CustomEvent('test:second-pip', { detail: { toggle: true } })));
    expect(container.textContent).not.toContain('Second body');
  });

  it('persists orientation and opens the full surface from the header control', () => {
    const onOpen = vi.fn();
    act(() => root.render(createElement(Preview, {
      eventName: 'test:open-pip',
      title: 'Openable',
      onOpen,
    })));
    act(() => window.dispatchEvent(new CustomEvent('test:open-pip', { detail: { toggle: true } })));

    const orientation = container.querySelector<HTMLButtonElement>('button[aria-label="Switch to mobile-style view"]');
    expect(orientation).not.toBeNull();
    act(() => orientation?.click());
    expect(localStorage.getItem('test:open-pip:orientation')).toBe('tall');

    const open = container.querySelector<HTMLButtonElement>('button[aria-label="Open preview"]');
    expect(open).not.toBeNull();
    act(() => open?.click());
    expect(onOpen).toHaveBeenCalledOnce();
    expect(container.textContent).not.toContain('Openable body');
  });

  it('closes an old workspace preview on focus change and preserves its position', async () => {
    localStorage.setItem('test:context:orientation:position', JSON.stringify({ x: 100, y: 80 }));
    const render = (contextKey: string) => act(async () => root.render(createElement(Preview, { eventName: 'test:context', title: 'Notes', contextKey })));
    await render('workspace-a');
    act(() => window.dispatchEvent(new CustomEvent('test:context', { detail: { toggle: true } })));
    const card = container.querySelector<HTMLElement>('[data-hover-pip]')!;
    expect(card.style.left).toBe('100px');
    expect(card.querySelector('[style*="var(--t-glass-elevated)"]')).not.toBeNull();
    expect(card.querySelector('[style*="var(--t-popover-surface)"]')).toBeNull();
    await render('workspace-b');
    expect(container.textContent).not.toContain('Notes body');
    act(() => window.dispatchEvent(new CustomEvent('test:context', { detail: { toggle: true } })));
    expect(container.textContent).toContain('Notes body');
    expect(container.querySelector<HTMLElement>('[data-hover-pip]')?.style.left).toBe('100px');
  });

  it('drags the complete glass card and persists the position from its header', () => {
    act(() => root.render(createElement(Preview, { eventName: 'test:drag', title: 'Draggable' })));
    act(() => window.dispatchEvent(new CustomEvent('test:drag', { detail: { toggle: true } })));
    const card = container.querySelector<HTMLElement>('[data-hover-pip]')!;
    vi.spyOn(card, 'getBoundingClientRect').mockReturnValue({ left: 100, top: 80, width: 440, height: 294 } as DOMRect);
    const header = card.querySelector<HTMLElement>('[style*="cursor: grab"]')!;
    header.setPointerCapture = vi.fn();
    header.hasPointerCapture = () => true;
    header.releasePointerCapture = vi.fn();
    const pointer = (type: string, x: number, y: number) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperties(event, { button: { value: 0 }, pointerId: { value: 1 }, clientX: { value: x }, clientY: { value: y } });
      act(() => header.dispatchEvent(event));
    };
    pointer('pointerdown', 110, 90);
    pointer('pointermove', 190, 140);
    pointer('pointerup', 190, 140);
    expect(card.style.left).toBe('180px');
    expect(card.style.top).toBe('130px');
    expect(header.setPointerCapture).toHaveBeenCalledWith(1);
    expect(header.releasePointerCapture).toHaveBeenCalledWith(1);
    expect(JSON.parse(localStorage.getItem('test:drag:orientation:position')!)).toEqual({ x: 180, y: 130 });
  });
});
