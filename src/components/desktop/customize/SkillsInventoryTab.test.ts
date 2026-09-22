/** @vitest-environment jsdom */

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SkillsInventoryTab, type SkillInventoryEntry } from './SkillsInventoryTab';

const skills: SkillInventoryEntry[] = [
  {
    name: 'review',
    description: 'Review repository changes',
    scope: 'project',
    source: 'shared',
    file: '/repo/.agents/skills/review/SKILL.md',
  },
  {
    name: 'review',
    description: 'Codex review workflow',
    scope: 'user',
    source: 'codex',
    file: '/home/.codex/skills/review/SKILL.md',
  },
  {
    name: 'visual-check',
    description: 'Gemini visual checks',
    scope: 'user',
    source: 'gemini',
    file: '/home/.gemini/skills/visual-check/SKILL.md',
  },
];

describe('SkillsInventoryTab', () => {
  let host: HTMLDivElement;
  let root: Root;
  const onOpenFile = vi.fn();

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    onOpenFile.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it('shows universal discovered metadata and keeps the Claude editor secondary and collapsed', () => {
    act(() => root.render(createElement(SkillsInventoryTab, { skills, query: '', onOpenFile })));

    expect(host.textContent).toContain('Discovered skills');
    expect(host.textContent).toContain('Discovery does not mean every runtime activates a skill');
    expect(host.textContent).toContain('Selected repository');
    expect(host.textContent).toContain('User folders');
    expect([...host.querySelectorAll<HTMLElement>('[role="button"]')]
      .filter((element) => element.textContent?.startsWith('review'))).toHaveLength(2);
    expect(host.textContent).toContain('shared');
    expect(host.textContent).toContain('Codex');
    const disclosure = host.querySelector('details');
    expect(disclosure?.open).toBe(false);
    expect(disclosure?.textContent).toContain('Claude Code worker injection');
    expect(host.querySelector('input[aria-label="Claude Code worker skill names"]')).toBeNull();
  });

  it('filters by source metadata and opens a selected skill file', () => {
    act(() => root.render(createElement(SkillsInventoryTab, { skills, query: 'gemini', onOpenFile })));

    expect(host.textContent).toContain('visual-check');
    expect(host.textContent).not.toContain('Codex review workflow');
    const row = [...host.querySelectorAll<HTMLElement>('[role="button"]')]
      .find((element) => element.textContent?.includes('visual-check'));
    act(() => row?.click());
    const open = [...host.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes('Open file'));
    act(() => open?.click());

    expect(onOpenFile).toHaveBeenCalledWith('/home/.gemini/skills/visual-check/SKILL.md');
  });
});
