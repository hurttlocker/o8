import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/theme/context', () => ({
  useTheme: () => ({ palettes: [], paletteId: 'dark', reduceTransparency: 'off', workspaceGlass: false }),
}));
vi.mock('@/lib/entitlement/context', () => ({ useEntitlement: () => ({ founder: null, plan: 'free' }) }));
vi.mock('@/components/desktop/canvas/index', () => ({
  CanvasEmpty: () => createElement('div', null, 'Idle canvas'),
  TimelineExpanded: () => { throw new Error('Retired timeline mounted'); },
}));

const { AppearanceTab } = await import('@/components/desktop/settings/AppearanceTab');
const { Canvas } = await import('@/components/desktop/Canvas');
const { searchSettings, SETTINGS_SEARCH_REGISTRY } = await import('@/components/desktop/settings/settings-search');

describe('retired desktop timeline', () => {
  it('keeps the components in source without a dashboard mount or launcher', () => {
    const page = readFileSync('src/app/dashboard/page.tsx', 'utf8');
    expect(page).not.toMatch(/SessionTimeline|timelineVisible|kind: 'timeline'/);
    expect(readFileSync('src/components/desktop/SessionTimeline.tsx', 'utf8')).toContain('export function SessionTimeline');
    expect(readFileSync('src/components/desktop/canvas/TimelineExpanded.tsx', 'utf8')).toContain('export function TimelineExpanded');
  });

  it('does not expose a settings toggle or search result for the retired strip', () => {
    const markup = renderToStaticMarkup(createElement(AppearanceTab));
    expect(markup).toContain('Window chrome');
    expect(markup).not.toMatch(/timeline/i);
    expect(searchSettings(SETTINGS_SEARCH_REGISTRY, 'timeline', { founder: true })).toEqual([]);
  });

  it('renders an old saved timeline tab without loading its component or polling', () => {
    const markup = renderToStaticMarkup(createElement(Canvas, {
      tabs: [{ id: 'timeline:session', kind: 'timeline', label: 'Session Replay', resourceId: 'session' }],
      activeTabId: 'timeline:session', onSelectTab: vi.fn(), onCloseTab: vi.fn(),
    }));
    expect(markup).toContain('Idle canvas');
  });

  it('routes first-completion discovery to the sidebar instead of the retired strip', () => {
    const page = readFileSync('src/app/dashboard/page.tsx', 'utf8');
    expect(page).toContain("activeFtuxMilestone === 'firstAgentSpawned' || showCompletionFtux");
    expect(page).toContain('Open Archived in Chats to revisit finished work.');
    expect(readFileSync('src/app/dashboard/hooks/useFtuxMilestones.ts', 'utf8'))
      .toContain("activeFtuxMilestone !== 'firstAgentSpawned' && activeFtuxMilestone !== 'firstCompletion'");
  });
});
