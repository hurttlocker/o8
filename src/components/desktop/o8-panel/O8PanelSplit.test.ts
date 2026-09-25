import { describe, expect, it } from 'vitest';
import { panelPaneStyle, panelPaneVisible } from './O8PanelSplit';

describe('right panel view placement', () => {
  it('keeps two distinct views visible without moving either into a second panel instance', () => {
    const browser = panelPaneStyle('browser', 'browser', 'spec', 60);
    const notes = panelPaneStyle('spec', 'browser', 'spec', 60);
    const activity = panelPaneStyle('activity', 'browser', 'spec', 60);

    expect(browser).toMatchObject({ display: 'flex', order: 0, height: 'calc(60% - 21.6px)' });
    expect(notes).toMatchObject({ display: 'flex', order: 2, height: 'calc(40% - 14.4px)' });
    expect(activity.display).toBe('none');
  });

  it('treats PR detail as the activity view and restores one full-height view', () => {
    expect(panelPaneVisible('activity', 'prs', 'browser')).toBe(true);
    expect(panelPaneStyle('activity', 'prs', null, 50)).toMatchObject({ display: 'flex', flex: 1 });
    expect(panelPaneStyle('browser', 'prs', null, 50).display).toBe('none');
  });
});
