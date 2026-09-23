/** @vitest-environment jsdom */

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SkillsInventoryTab, type SkillInventoryEntry } from './SkillsInventoryTab';

describe('SkillsInventoryTab', () => {
  let host: HTMLDivElement;
  let root: Root;
  const onOpenFile = vi.fn();
  const onUseSkill = vi.fn();

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    onOpenFile.mockReset();
    onUseSkill.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it('keeps the same skill name separate across repositories and searches by repository name', () => {
    const skills: SkillInventoryEntry[] = [
      {
        name: 'review',
        description: 'Review Acorn repository changes',
        scope: 'project',
        source: 'shared',
        file: '/work/acorn/.agents/skills/review/SKILL.md',
        repoName: 'Acorn',
        repoPath: '/work/acorn',
      },
      {
        name: 'review',
        description: 'Review Birch repository changes',
        scope: 'project',
        source: 'o8',
        file: '/work/birch/.o8/skills/review/SKILL.md',
        repoName: 'Birch',
        repoPath: '/work/birch',
      },
    ];

    act(() => root.render(createElement(SkillsInventoryTab, { skills, query: '', onOpenFile })));

    expect(host.textContent).toContain('Discovered skills');
    expect(host.textContent).toContain('Automatic loading depends on the agent.');
    expect(host.textContent).toContain('Project · Acorn · files found');
    expect(host.textContent).toContain('Project · Birch · files found');
    expect([...host.querySelectorAll<HTMLElement>('[role="button"]')]
      .filter((element) => element.textContent?.startsWith('review'))).toHaveLength(2);
    expect(host.textContent?.match(/1 copy/g)).toHaveLength(2);

    act(() => root.render(createElement(SkillsInventoryTab, { skills, query: 'birch', onOpenFile })));

    expect(host.textContent).not.toContain('Project · Acorn · files found');
    expect(host.textContent).toContain('Project · Birch · files found');
    expect([...host.querySelectorAll<HTMLElement>('[role="button"]')]
      .filter((element) => element.textContent?.startsWith('review'))).toHaveLength(1);
    const disclosure = host.querySelector('details');
    expect(disclosure?.open).toBe(false);
    expect(disclosure?.textContent).toContain('Claude Code worker injection');
    expect(host.querySelector('input[aria-label="Claude Code worker skill names"]')).toBeNull();
  });

  it('groups personal copies while keeping every origin, description, and file accessible through search', () => {
    const skills: SkillInventoryEntry[] = [
      {
        name: 'visual-check',
        description: 'Codex visual review workflow',
        scope: 'user',
        source: 'codex',
        file: '/home/.codex/skills/visual-check/SKILL.md',
      },
      {
        name: 'visual-check',
        description: 'Gemini visual checks',
        scope: 'user',
        source: 'gemini',
        file: '/home/.gemini/skills/visual-check/SKILL.md',
      },
    ];

    act(() => root.render(createElement(SkillsInventoryTab, { skills, query: 'gemini', onOpenFile, onUseSkill })));

    expect(host.textContent).toContain('Personal skills · files found');
    expect(host.textContent).toContain('visual-check');
    expect(host.textContent).toContain('Found in Codex, Gemini');
    expect(host.textContent).toContain('2 copies');
    expect([...host.querySelectorAll<HTMLElement>('[role="button"]')]
      .filter((element) => element.textContent?.startsWith('visual-check'))).toHaveLength(1);
    const row = [...host.querySelectorAll<HTMLElement>('[role="button"]')]
      .find((element) => element.textContent?.includes('visual-check'));
    act(() => row?.click());

    expect([...host.querySelectorAll('span')]
      .filter((element) => element.textContent === 'Found in')).toHaveLength(2);
    expect(host.textContent).toContain('Codex visual review workflow');
    expect(host.textContent).toContain('Gemini visual checks');
    expect(host.textContent).toContain('/home/.codex/skills/visual-check/SKILL.md');
    expect(host.textContent).toContain('/home/.gemini/skills/visual-check/SKILL.md');
    const openButtons = [...host.querySelectorAll<HTMLButtonElement>('button')]
      .filter((button) => button.textContent?.includes('Open file'));
    expect(openButtons).toHaveLength(2);
    act(() => openButtons.forEach((button) => button.click()));
    expect(onOpenFile).toHaveBeenNthCalledWith(1, '/home/.codex/skills/visual-check/SKILL.md');
    expect(onOpenFile).toHaveBeenNthCalledWith(2, '/home/.gemini/skills/visual-check/SKILL.md');
    const useButtons = [...host.querySelectorAll<HTMLButtonElement>('button')]
      .filter((button) => button.textContent === 'Use in task');
    expect(useButtons).toHaveLength(2);
    act(() => useButtons[1].click());
    expect(onUseSkill).toHaveBeenCalledExactlyOnceWith(skills[1]);

    act(() => root.render(createElement(SkillsInventoryTab, { skills, query: 'Codex visual review', onOpenFile })));
    expect(host.textContent).toContain('2 copies');

    act(() => root.render(createElement(SkillsInventoryTab, { skills, query: 'visual-check', onOpenFile })));
    expect(host.textContent).toContain('2 copies');
  });
});
