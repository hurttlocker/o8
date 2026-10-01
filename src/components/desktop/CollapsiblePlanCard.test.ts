// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CollapsiblePlanCard } from './CollapsiblePlanCard';

vi.mock('./MarkdownBody', () => ({
  MarkdownBody: ({ text }: { text: string }) =>
    createElement('div', { 'data-testid': 'markdown-body' }, text),
}));

const ACT_ENV = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
ACT_ENV.IS_REACT_ACT_ENVIRONMENT = true;

function planButtons(container: HTMLElement): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll('button')).filter((button) =>
    (button.textContent ?? '').includes('Plan'),
  );
}

describe('CollapsiblePlanCard accessible panel controls', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it('renders nothing for empty or whitespace-only plan text', () => {
    act(() => root.render(createElement(CollapsiblePlanCard, { text: '   ' })));
    expect(container.textContent).toBe('');
    expect(container.querySelector('button')).toBeNull();
  });

  it('keeps a native toggle button collapsed until activated', () => {
    act(() => root.render(createElement(CollapsiblePlanCard, {
      text: 'Ship the first-turn plan',
    })));

    const button = planButtons(container)[0];
    expect(button).toBeTruthy();
    expect(button.type).toBe('button');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(button.hasAttribute('aria-controls')).toBe(false);
    expect(container.querySelector('[data-testid="markdown-body"]')).toBeNull();
    expect(container.textContent).toContain('Show the first-turn plan');
  });

  it('wires aria-controls to a unique panel id when expanded and clears it on collapse', () => {
    act(() => root.render(createElement(CollapsiblePlanCard, {
      text: 'Inspect the accessible panel link',
    })));

    const button = planButtons(container)[0];
    act(() => button.click());

    expect(button.getAttribute('aria-expanded')).toBe('true');
    const panelId = button.getAttribute('aria-controls');
    expect(panelId).toBeTruthy();
    const panel = document.getElementById(panelId!);
    expect(panel).not.toBeNull();
    expect(panel?.querySelector('[data-testid="markdown-body"]')?.textContent)
      .toBe('Inspect the accessible panel link');
    expect(container.textContent).toContain('Hide the first-turn plan');

    act(() => button.click());
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(button.hasAttribute('aria-controls')).toBe(false);
    expect(document.getElementById(panelId!)).toBeNull();
  });

  it('gives two cards distinct panel ids with matching aria-controls when expanded', () => {
    act(() => root.render(createElement(
      'div',
      null,
      createElement(CollapsiblePlanCard, { text: 'Plan alpha' }),
      createElement(CollapsiblePlanCard, { text: 'Plan beta' }),
    )));

    const buttons = planButtons(container);
    expect(buttons).toHaveLength(2);

    act(() => {
      buttons[0].click();
      buttons[1].click();
    });

    const ids = buttons.map((button) => button.getAttribute('aria-controls'));
    expect(ids[0]).toBeTruthy();
    expect(ids[1]).toBeTruthy();
    expect(ids[0]).not.toBe(ids[1]);

    for (const [index, button] of buttons.entries()) {
      expect(button.getAttribute('aria-expanded')).toBe('true');
      const panel = document.getElementById(ids[index]!);
      expect(panel).not.toBeNull();
      expect(button.getAttribute('aria-controls')).toBe(panel!.id);
    }

    const bodies = Array.from(container.querySelectorAll('[data-testid="markdown-body"]'))
      .map((node) => node.textContent);
    expect(bodies).toEqual(['Plan alpha', 'Plan beta']);
  });
});
