import { describe, expect, it } from 'vitest';
import { MAX_RESIDENT_WORKSPACE_TABS, updateResidentTabIds } from './resident-tabs';

describe('workspace resident tab retention', () => {
  it('caps restored heavy surfaces while keeping the active tab', () => {
    const visible = ['one', 'two', 'three', 'four', 'five'];
    const resident = updateResidentTabIds([], visible, 'one');

    expect(resident).toHaveLength(MAX_RESIDENT_WORKSPACE_TABS);
    expect(resident).toContain('one');
  });

  it('moves a newly active tab into the retained LRU window', () => {
    const resident = updateResidentTabIds(['one', 'two', 'three'], ['one', 'two', 'three', 'four'], 'four');
    expect(resident).toEqual(['two', 'three', 'four']);
  });

  it('drops tabs that were closed', () => {
    const resident = updateResidentTabIds(['one', 'two', 'three'], ['one', 'three'], 'three');
    expect(resident).toEqual(['one', 'three']);
  });

  it('stays bounded across a long tab-switching session', () => {
    const visible = Array.from({ length: 50 }, (_, index) => `tab-${index}`);
    let resident: string[] = [];
    for (let index = 0; index < 10_000; index += 1) {
      resident = updateResidentTabIds(resident, visible, visible[index % visible.length]);
      expect(resident.length).toBeLessThanOrEqual(MAX_RESIDENT_WORKSPACE_TABS);
    }
  });
});
