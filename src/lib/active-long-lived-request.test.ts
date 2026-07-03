import { describe, expect, it } from 'vitest';
import { createActiveLongLivedRequestController } from './active-long-lived-request';

describe('active long-lived request controller', () => {
  it('aborts the current request when a tab becomes inactive and reacquires on focus', () => {
    const slot = createActiveLongLivedRequestController(true);

    const first = slot.begin();
    expect(first.signal.aborted).toBe(false);
    expect(slot.getCurrent()).toBe(first);

    slot.setActive(false);
    expect(first.signal.aborted).toBe(true);
    expect(slot.getCurrent()).toBeNull();

    const hiddenAttempt = slot.begin();
    expect(hiddenAttempt.signal.aborted).toBe(true);
    expect(slot.getCurrent()).toBeNull();

    slot.setActive(true);
    const focused = slot.begin();
    expect(focused.signal.aborted).toBe(false);
    expect(slot.getCurrent()).toBe(focused);

    slot.finish(focused);
    expect(slot.getCurrent()).toBeNull();
  });

  it('replaces an older stream before starting a new one', () => {
    const slot = createActiveLongLivedRequestController(true);
    const first = slot.begin();
    const second = slot.begin();

    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(false);
    expect(slot.getCurrent()).toBe(second);
  });
});
