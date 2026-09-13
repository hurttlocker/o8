// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest';

import {
  composerModeStorageKey,
  legacySwarmStorageKey,
  readStoredComposerMode,
} from './composer-mode-storage';
import { composeComposerTurnMessage } from './composer-mode';

describe('composer mode storage', () => {
  beforeEach(() => localStorage.clear());

  it('migrates a legacy swarm flag to Fusion once unless a stored mode wins', () => {
    const legacyTab = 'legacy-tab';
    localStorage.setItem(legacySwarmStorageKey(legacyTab), '1');

    const migratedMode = readStoredComposerMode(legacyTab);
    expect(migratedMode).toBe('fusion');
    expect(localStorage.getItem(composerModeStorageKey(legacyTab))).toBe('fusion');
    expect(localStorage.getItem(legacySwarmStorageKey(legacyTab))).toBe('0');
    expect(readStoredComposerMode(legacyTab)).toBe('fusion');
    expect(composeComposerTurnMessage('Build it', migratedMode, false).wireMessage)
      .toContain('[Mode: Fusion]');

    const storedTab = 'stored-tab';
    localStorage.setItem(composerModeStorageKey(storedTab), 'solo');
    localStorage.setItem(legacySwarmStorageKey(storedTab), '1');
    expect(readStoredComposerMode(storedTab)).toBe('solo');
    expect(localStorage.getItem(legacySwarmStorageKey(storedTab))).toBe('0');
  });
});
