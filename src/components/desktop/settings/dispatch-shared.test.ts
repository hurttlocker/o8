import { describe, expect, it } from 'vitest';
import { listDispatchableRuntimes } from '@/lib/orchestrator/runtime-capabilities';

import {
  DISPATCH_RUNTIME_OPTIONS,
  nextPickerHighlightIndex,
  PICKER_MENU_POPOVER_BG,
  REQUIRE_APPROVAL_OPTIONS,
  resolvePickerGroupOpen,
} from './dispatch-shared';

describe('settings dispatch picker menu surface', () => {
  it('uses an opaque themed content surface instead of transparent chrome tokens', () => {
    expect(PICKER_MENU_POPOVER_BG).toBe('var(--t-panel-solid)');
    expect(PICKER_MENU_POPOVER_BG).not.toContain('--t-chat-surface-bg');
    expect(PICKER_MENU_POPOVER_BG).not.toContain('transparent');
    expect(PICKER_MENU_POPOVER_BG).not.toContain('rgba(0,0,0,0)');
    expect(PICKER_MENU_POPOVER_BG).not.toContain('rgba(0, 0, 0, 0)');
  });

  it('derives every dispatchable worker option from the runtime catalog', () => {
    expect(DISPATCH_RUNTIME_OPTIONS.map((option) => option.value)).toEqual(listDispatchableRuntimes());
  });

  it('keeps only one Dispatch Runtime picker open at a time', () => {
    let openPicker: string | null = null;
    openPicker = resolvePickerGroupOpen(openPicker, 'subscription-profile', true);
    openPicker = resolvePickerGroupOpen(openPicker, 'codex-effort', true);

    expect(openPicker).toBe('codex-effort');
    expect(resolvePickerGroupOpen(openPicker, 'subscription-profile', false)).toBe('codex-effort');
    expect(resolvePickerGroupOpen(openPicker, 'codex-effort', false)).toBeNull();
  });

  it('offers the dispatcher-routed surface merge posture', () => {
    expect(REQUIRE_APPROVAL_OPTIONS).toContainEqual({ value: 'surface', label: 'Surface' });
  });

  it('wraps arrow navigation and supports first/last keyboard jumps', () => {
    expect(nextPickerHighlightIndex(0, 4, 'ArrowUp')).toBe(3);
    expect(nextPickerHighlightIndex(3, 4, 'ArrowDown')).toBe(0);
    expect(nextPickerHighlightIndex(2, 4, 'Home')).toBe(0);
    expect(nextPickerHighlightIndex(1, 4, 'End')).toBe(3);
  });
});
