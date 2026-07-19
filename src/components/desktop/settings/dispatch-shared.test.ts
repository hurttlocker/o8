import { describe, expect, it } from 'vitest';

import {
  DISPATCH_RUNTIME_OPTIONS,
  PICKER_MENU_POPOVER_BG,
} from './dispatch-shared';

describe('settings dispatch picker menu surface', () => {
  it('uses an opaque themed content surface instead of transparent chrome tokens', () => {
    expect(PICKER_MENU_POPOVER_BG).toBe('var(--t-panel-solid)');
    expect(PICKER_MENU_POPOVER_BG).not.toContain('--t-chat-surface-bg');
    expect(PICKER_MENU_POPOVER_BG).not.toContain('transparent');
    expect(PICKER_MENU_POPOVER_BG).not.toContain('rgba(0,0,0,0)');
    expect(PICKER_MENU_POPOVER_BG).not.toContain('rgba(0, 0, 0, 0)');
  });

  it('keeps the default-worker picker scoped to Codex and Claude Code', () => {
    const labels = DISPATCH_RUNTIME_OPTIONS
      .filter((option) => option.value === 'codex' || option.value === 'claude-code')
      .map((option) => option.label);

    expect(labels).toEqual(['Codex', 'Claude Code']);
  });
});
