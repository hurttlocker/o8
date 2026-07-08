import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  evaluateReleaseHealth,
  isVersionPulled,
  normalizeVersion,
  parseReleaseHealth,
} from './release-health';

describe('release-health — pure decision', () => {
  it('normalizeVersion strips a leading v and trims', () => {
    expect(normalizeVersion('v0.1.567')).toBe('0.1.567');
    expect(normalizeVersion(' 0.1.567 ')).toBe('0.1.567');
  });

  it('isVersionPulled matches with and without a leading v', () => {
    const health = { pulled: ['0.1.567'] };
    expect(isVersionPulled('0.1.567', health)).toBe(true);
    expect(isVersionPulled('v0.1.567', health)).toBe(true);
    expect(isVersionPulled('0.1.568', health)).toBe(false);
  });

  it('isVersionPulled returns false for an empty manifest (fail-open)', () => {
    expect(isVersionPulled('0.1.567', { pulled: [] })).toBe(false);
  });

  it('isVersionPulled returns false for a null manifest (fail-open)', () => {
    expect(isVersionPulled('0.1.567', null)).toBe(false);
  });

  it('parseReleaseHealth accepts a valid manifest and captures the note', () => {
    const parsed = parseReleaseHealth({ pulled: ['0.1.567'], note: 'bad build' });
    expect(parsed).toEqual({ pulled: ['0.1.567'], note: 'bad build' });
  });

  it('parseReleaseHealth rejects malformed payloads → null', () => {
    expect(parseReleaseHealth(null)).toBeNull();
    expect(parseReleaseHealth('nope')).toBeNull();
    expect(parseReleaseHealth({ pulled: 'not-an-array' })).toBeNull();
    expect(parseReleaseHealth([])).toBeNull();
  });

  it('parseReleaseHealth drops non-string entries from pulled', () => {
    expect(parseReleaseHealth({ pulled: ['0.1.1', 42, null] })).toEqual({ pulled: ['0.1.1'] });
  });
});

describe('release-health — evaluate (fetch seam, fail-open)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('a fetch failure → proceed with the update (pulled: false)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    const decision = await evaluateReleaseHealth('0.1.567');
    expect(decision.pulled).toBe(false);
  });

  it('a non-2xx response → proceed (pulled: false)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404 }));
    const decision = await evaluateReleaseHealth('0.1.567');
    expect(decision.pulled).toBe(false);
  });

  it('a manifest listing the version → blocked (pulled: true) with the note', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ pulled: ['0.1.567'], note: 'crashes on launch' }),
    }));
    const decision = await evaluateReleaseHealth('0.1.567');
    expect(decision.pulled).toBe(true);
    expect(decision.note).toBe('crashes on launch');
  });

  it('a manifest NOT listing the version → proceed (pulled: false)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ pulled: ['0.1.999'] }),
    }));
    const decision = await evaluateReleaseHealth('0.1.567');
    expect(decision.pulled).toBe(false);
  });

  it('malformed JSON → proceed (pulled: false)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => { throw new Error('bad json'); },
    }));
    const decision = await evaluateReleaseHealth('0.1.567');
    expect(decision.pulled).toBe(false);
  });
});
