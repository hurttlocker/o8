import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Exercise the actual dashboard expression: a development preview previously
// passed component tests while the production entry point hid the entire rail.
const dashboard = readFileSync(new URL('./page.tsx', import.meta.url), 'utf8');
const expression = dashboard.match(/const show(?:DevChatRailStudy|CompactNavigationRail) = ([\s\S]*?);/)?.[1];
const visible = new Function('process', 'showSidebarColumn', 'compactShell', 'settingsTakeoverActive', `return ${expression};`);

describe('desktop navigation entry point', () => {
  it.each(['production', 'development'])('shows the collapsed rail in %s', (mode) => {
    expect(expression).toBeDefined();
    expect(visible({ env: { NODE_ENV: mode } }, false, false, false)).toBe(true);
  });
  it.each([[true, false, false], [false, false, true], [true, false, true]])('keeps navigation available beside the list and on destination pages %j', (...state) => {
    expect(visible({ env: { NODE_ENV: 'production' } }, ...state)).toBe(true);
  });
  it('preserves the existing compact mobile shell', () => {
    const state = [false, true, false];
    expect(visible({ env: { NODE_ENV: 'production' } }, ...state)).toBe(false);
  });
});
