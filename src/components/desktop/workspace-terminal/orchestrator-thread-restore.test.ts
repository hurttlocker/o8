// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearLastOrchestratorThreadForId,
  readLastOrchestratorThreadId,
  readLastOrchestratorThreadTitle,
  writeLastOrchestratorThread,
} from './orchestrator-thread-restore';

const LEGACY_ID_KEY = 'o8:last-orchestrator-thread-id';
const LEGACY_TITLE_KEY = 'o8:last-orchestrator-thread-title';
const LEGACY_TITLE_ID_KEY = 'o8:last-orchestrator-thread-title-id';

const REPO_A = '/Users/dev/repo-a';
const REPO_B = '/Users/dev/repo-b';

beforeEach(() => {
  window.localStorage.clear();
});

describe('orchestrator-thread-restore (per-repo scoping)', () => {
  it('round-trips the thread id + title within a repo scope', () => {
    writeLastOrchestratorThread(REPO_A, 'thoughts-a1', 'Repo A thread');
    expect(readLastOrchestratorThreadId(REPO_A)).toBe('thoughts-a1');
    expect(readLastOrchestratorThreadTitle(REPO_A)).toBe('Repo A thread');
  });

  it('only returns the title when it belongs to the stored id', () => {
    writeLastOrchestratorThread(REPO_A, 'thoughts-a1', 'Repo A thread');
    // A bare id write (no title) leaves the previous title/title-id in place,
    // but the title only surfaces while its title-id still matches.
    writeLastOrchestratorThread(REPO_A, 'thoughts-a2');
    expect(readLastOrchestratorThreadId(REPO_A)).toBe('thoughts-a2');
    expect(readLastOrchestratorThreadTitle(REPO_A)).toBeNull();
  });

  it('isolates repos — repo B cannot see the repo A thread', () => {
    writeLastOrchestratorThread(REPO_A, 'thoughts-a1', 'Repo A thread');
    writeLastOrchestratorThread(REPO_B, 'thoughts-b1', 'Repo B thread');
    expect(readLastOrchestratorThreadId(REPO_A)).toBe('thoughts-a1');
    expect(readLastOrchestratorThreadId(REPO_B)).toBe('thoughts-b1');
    expect(readLastOrchestratorThreadTitle(REPO_A)).toBe('Repo A thread');
    expect(readLastOrchestratorThreadTitle(REPO_B)).toBe('Repo B thread');
  });

  it('normalizes trailing slashes so the scope is stable', () => {
    writeLastOrchestratorThread(`${REPO_A}/`, 'thoughts-a1', 'Repo A thread');
    expect(readLastOrchestratorThreadId(REPO_A)).toBe('thoughts-a1');
    expect(readLastOrchestratorThreadTitle(`${REPO_A}///`)).toBe('Repo A thread');
  });

  describe('legacy migration', () => {
    it('falls back to the legacy global key when no per-repo value exists', () => {
      window.localStorage.setItem(LEGACY_ID_KEY, 'thoughts-legacy');
      window.localStorage.setItem(LEGACY_TITLE_KEY, 'Legacy thread');
      window.localStorage.setItem(LEGACY_TITLE_ID_KEY, 'thoughts-legacy');
      expect(readLastOrchestratorThreadId(REPO_A)).toBe('thoughts-legacy');
      expect(readLastOrchestratorThreadTitle(REPO_A)).toBe('Legacy thread');
    });

    it('drops the legacy keys after the first successful per-repo write', () => {
      window.localStorage.setItem(LEGACY_ID_KEY, 'thoughts-legacy');
      window.localStorage.setItem(LEGACY_TITLE_KEY, 'Legacy thread');
      window.localStorage.setItem(LEGACY_TITLE_ID_KEY, 'thoughts-legacy');

      writeLastOrchestratorThread(REPO_A, 'thoughts-a1', 'Repo A thread');

      expect(window.localStorage.getItem(LEGACY_ID_KEY)).toBeNull();
      expect(window.localStorage.getItem(LEGACY_TITLE_KEY)).toBeNull();
      expect(window.localStorage.getItem(LEGACY_TITLE_ID_KEY)).toBeNull();
      // Repo A now owns its own value; a fresh repo B no longer resurrects
      // the (now-deleted) legacy thread.
      expect(readLastOrchestratorThreadId(REPO_A)).toBe('thoughts-a1');
      expect(readLastOrchestratorThreadId(REPO_B)).toBeNull();
    });

    it('a null scope reads/writes the legacy (un-suffixed) bucket', () => {
      writeLastOrchestratorThread(null, 'thoughts-global', 'Global thread');
      expect(window.localStorage.getItem(LEGACY_ID_KEY)).toBe('thoughts-global');
      expect(readLastOrchestratorThreadId(null)).toBe('thoughts-global');
      expect(readLastOrchestratorThreadTitle(null)).toBe('Global thread');
    });
  });

  describe('clearLastOrchestratorThreadForId', () => {
    it('sweeps a deleted thread from every bucket that points at it', () => {
      writeLastOrchestratorThread(REPO_A, 'thoughts-dead', 'Doomed');
      // A second repo happens to also point at the same (now-deleted) thread.
      window.localStorage.setItem(`${LEGACY_ID_KEY}::${REPO_B}`, 'thoughts-dead');
      window.localStorage.setItem(LEGACY_ID_KEY, 'thoughts-dead');

      clearLastOrchestratorThreadForId('thoughts-dead');

      expect(readLastOrchestratorThreadId(REPO_A)).toBeNull();
      expect(window.localStorage.getItem(`${LEGACY_ID_KEY}::${REPO_B}`)).toBeNull();
      expect(window.localStorage.getItem(LEGACY_ID_KEY)).toBeNull();
    });

    it('leaves other repo threads untouched', () => {
      writeLastOrchestratorThread(REPO_A, 'thoughts-dead', 'Doomed');
      writeLastOrchestratorThread(REPO_B, 'thoughts-alive', 'Survivor');

      clearLastOrchestratorThreadForId('thoughts-dead');

      expect(readLastOrchestratorThreadId(REPO_A)).toBeNull();
      expect(readLastOrchestratorThreadId(REPO_B)).toBe('thoughts-alive');
      expect(readLastOrchestratorThreadTitle(REPO_B)).toBe('Survivor');
    });

    it('is a no-op when nothing matches', () => {
      writeLastOrchestratorThread(REPO_A, 'thoughts-a1', 'Repo A thread');
      clearLastOrchestratorThreadForId('thoughts-missing');
      expect(readLastOrchestratorThreadId(REPO_A)).toBe('thoughts-a1');
    });
  });
});
