// @vitest-environment jsdom

import { act, createElement, Fragment } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MobileTranscriptCommand } from '@/lib/mobile/types';
import { CommandStripNode } from './CommandStripNode';

vi.mock('@/lib/desktop/open-external', () => ({ openExternalUrl: vi.fn() }));

describe('CommandStripNode disclosure relationships', () => {
  let container: HTMLDivElement;
  let root: Root;

  function renderCommands(commands: MobileTranscriptCommand[], timestampLabel?: string) {
    act(() => root.render(createElement(Fragment, null, ...commands.map((command, index) =>
      createElement(CommandStripNode, { key: index, command, timestampLabel }),
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

  it('connects two same-name commands to distinct panels when expanded', () => {
    const buttons = renderCommands([
      { name: 'status', summary: 'First status', details: ['First detail'] },
      { name: 'status', summary: 'Second status', details: ['Second detail'] },
    ]);
    expect(buttons).toHaveLength(2);
    for (const button of buttons) {
      expect(button.type).toBe('button');
      expect(button.getAttribute('aria-expanded')).toBe('false');
      act(() => button.click());
      expect(button.getAttribute('aria-expanded')).toBe('true');
    }

    const firstPanel = controlledPanel(buttons[0]);
    const secondPanel = controlledPanel(buttons[1]);
    expect(firstPanel.id).not.toBe(secondPanel.id);
    expect(firstPanel.textContent).toContain('First detail');
    expect(firstPanel.textContent).not.toContain('Second detail');
    expect(secondPanel.textContent).toContain('Second detail');
    expect(secondPanel.textContent).not.toContain('First detail');

    act(() => buttons[0].click());
    expect(buttons[0].getAttribute('aria-expanded')).toBe('false');
    expect(buttons[0].hasAttribute('aria-controls')).toBe(false);
    expect(document.getElementById(firstPanel.id)).toBeNull();
    expect(controlledPanel(buttons[1])).toBe(secondPanel);

    act(() => buttons[0].click());
    expect(controlledPanel(buttons[0]).id).toBe(firstPanel.id);
    expect(controlledPanel(buttons[1])).toBe(secondPanel);
  });

  it('keeps a brain answer expanded by default and supports collapse and reopen', () => {
    const [button] = renderCommands([{
      name: 'ask', summary: 'Answer ready',
      brainAnswer: { tokens: 'A synthetic answer.', citations: [] },
    }]);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    const panel = controlledPanel(button);
    expect(panel.textContent).toContain('A synthetic answer.');

    act(() => button.click());
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(button.hasAttribute('aria-controls')).toBe(false);
    expect(container.textContent).not.toContain('A synthetic answer.');

    act(() => button.click());
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(controlledPanel(button).id).toBe(panel.id);
    expect(controlledPanel(button).textContent).toContain('A synthetic answer.');
  });

  it.each([
    { name: 'help', summary: 'Summary only' },
    { name: 'help', summary: 'Empty details', details: [], chips: [],
      brainAnswer: { tokens: '', citations: [] } },
  ])('omits disclosure attributes without details: $summary', (command) => {
    const [button] = renderCommands([command]);
    expect(button.type).toBe('button');
    expect(button.hasAttribute('aria-expanded')).toBe(false);
    expect(button.hasAttribute('aria-controls')).toBe(false);
    act(() => button.click());
    expect(button.hasAttribute('aria-expanded')).toBe(false);
    expect(button.hasAttribute('aria-controls')).toBe(false);
    expect(container.querySelector('[id]')).toBeNull();
  });

  it('connects a chips-only details panel', () => {
    const [button] = renderCommands([{
      name: 'status', summary: 'Chip status', chips: [{ label: 'Ready', tone: 'emerald' }],
    }]);
    expect(button.getAttribute('aria-expanded')).toBe('false');
    act(() => button.click());
    expect(controlledPanel(button).textContent).toContain('Ready');
  });

  it('connects a timestamp-only details panel', () => {
    const [button] = renderCommands([{ name: 'status', summary: 'Timestamp status' }], 'Just now');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    act(() => button.click());
    expect(controlledPanel(button).textContent).toContain('Just now');
  });
});
