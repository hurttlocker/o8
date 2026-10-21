// @vitest-environment jsdom

import { act, createElement, Fragment, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CompactionNode } from './CompactionNode';

describe('CompactionNode disclosure relationships', () => {
  let container: HTMLDivElement;
  let root: Root;

  function renderNodes(props: Array<ComponentProps<typeof CompactionNode>>) {
    act(() => root.render(createElement(Fragment, null, ...props.map((node, index) =>
      createElement(CompactionNode, { key: index, ...node }),
    ))));
    return Array.from(container.querySelectorAll<HTMLButtonElement>('button'));
  }

  function controlledPanel(button: HTMLButtonElement) {
    const id = button.getAttribute('aria-controls');
    expect(id).toBeTruthy();
    const panel = document.getElementById(id!);
    expect(panel).not.toBeNull();
    expect(container.contains(panel)).toBe(true);
    return panel!;
  }

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it('connects separate summaries to distinct panels and preserves collapse/reopen', () => {
    const buttons = renderNodes([
      { compactedCount: 2, summary: 'First synthetic summary' },
      { compactedCount: 2, summary: 'Second synthetic summary' },
    ]);
    expect(buttons).toHaveLength(2);
    for (const button of buttons) {
      expect(button.getAttribute('aria-expanded')).toBe('false');
      expect(button.hasAttribute('aria-controls')).toBe(false);
      expect(button.querySelector('svg')?.style.transform).toBe('rotate(0deg)');
      act(() => button.click());
      expect(button.getAttribute('aria-expanded')).toBe('true');
      expect(button.querySelector('svg')?.style.transform).toBe('rotate(180deg)');
    }

    const firstPanel = controlledPanel(buttons[0]);
    const secondPanel = controlledPanel(buttons[1]);
    expect(firstPanel.id).not.toBe(secondPanel.id);
    expect(firstPanel.textContent).toContain('First synthetic summary');
    expect(firstPanel.textContent).not.toContain('Second synthetic summary');
    expect(secondPanel.textContent).toContain('Second synthetic summary');
    expect(secondPanel.textContent).not.toContain('First synthetic summary');

    act(() => buttons[0].click());
    expect(buttons[0].getAttribute('aria-expanded')).toBe('false');
    expect(buttons[0].hasAttribute('aria-controls')).toBe(false);
    expect(buttons[0].querySelector('svg')?.style.transform).toBe('rotate(0deg)');
    expect(document.getElementById(firstPanel.id)).toBeNull();
    expect(controlledPanel(buttons[1])).toBe(secondPanel);

    act(() => buttons[0].click());
    expect(controlledPanel(buttons[0]).id).toBe(firstPanel.id);
    expect(controlledPanel(buttons[1])).toBe(secondPanel);
  });

  it('uses an explicit non-submit button inside a form', () => {
    const onSubmit = vi.fn((event: { preventDefault(): void }) => event.preventDefault());
    act(() => root.render(createElement('form', { onSubmit },
      createElement(CompactionNode, { summary: 'Form summary' }),
    )));
    const button = container.querySelector('button')!;
    act(() => button.click());
    expect(onSubmit).not.toHaveBeenCalled();
    expect(button.getAttribute('type')).toBe('button');
    expect(button.getAttribute('aria-expanded')).toBe('true');
  });

  it.each([
    {},
    { compactedCount: 2, summary: ' \n ' },
  ])('omits disclosure attributes when no details exist (%j)', (props) => {
    const [button] = renderNodes([props]);
    expect(button.hasAttribute('aria-expanded')).toBe(false);
    expect(button.hasAttribute('aria-controls')).toBe(false);
    act(() => button.click());
    expect(button.hasAttribute('aria-expanded')).toBe(false);
    expect(button.hasAttribute('aria-controls')).toBe(false);
    expect(container.querySelector('[id]')).toBeNull();
  });

  it.each<Array<ComponentProps<typeof CompactionNode>>[number]>([
    { trigger: 'manual' },
    { tokensBefore: 1_000, tokensAfter: 500 },
    { timestampLabel: 'Just now' },
  ])('connects metadata-only details (%j)', (props) => {
    const [button] = renderNodes([props]);
    expect(button.getAttribute('aria-expanded')).toBe('false');
    act(() => button.click());
    expect(button.getAttribute('aria-expanded')).toBe('true');
    controlledPanel(button);
  });
});
