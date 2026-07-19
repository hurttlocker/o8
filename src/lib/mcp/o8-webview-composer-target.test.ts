import { describe, expect, it } from 'vitest';
import {
  buildPrepareComposerTargetScript,
  resolveComposerTargetIndex,
} from './o8-webview-composer-target';

describe('active webview composer targeting', () => {
  it('ignores a hidden focused composer and resolves the visible active composer', () => {
    expect(resolveComposerTargetIndex([
      { activeComposer: false, disabled: false, focused: true, visible: false },
      { activeComposer: true, disabled: false, focused: false, visible: true },
    ])).toBe(1);
  });

  it('preserves a visible focused form input ahead of the chat composer', () => {
    expect(resolveComposerTargetIndex([
      { activeComposer: false, disabled: false, focused: true, visible: true },
      { activeComposer: true, disabled: false, focused: false, visible: true },
    ])).toBe(0);
  });

  it('returns no target when the only candidates are hidden or disabled', () => {
    expect(resolveComposerTargetIndex([
      { activeComposer: true, disabled: true, focused: false, visible: true },
      { activeComposer: false, disabled: false, focused: true, visible: false },
    ])).toBe(-1);
  });

  it('emits a syntactically valid active-composer focus script', () => {
    const script = buildPrepareComposerTargetScript();
    expect(script).toContain('data-o8-active-composer');
    expect(() => new Function(`return ${script};`)).not.toThrow();
  });
});
