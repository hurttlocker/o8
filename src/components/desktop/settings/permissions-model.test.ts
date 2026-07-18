import { describe, expect, it } from 'vitest';

import {
  PERMISSIONS,
  PERM_IDS,
  permMeta,
  micStatus,
  boolStatus,
  permPillText,
  permPillTone,
  fixActionLabel,
  shouldPrompt,
  isFreshGrant,
} from './permissions-model';

describe('permissions-model status mappers', () => {
  it('maps the microphone bridge return (bool | null) with the never-asked case', () => {
    expect(micStatus(true)).toBe('granted');
    expect(micStatus(false)).toBe('denied');
    expect(micStatus(null)).toBe('not-asked');
    expect(micStatus(undefined)).toBe('not-asked');
  });

  it('collapses the boolean-only grants (no never-asked signal) to granted/denied', () => {
    expect(boolStatus(true)).toBe('granted');
    expect(boolStatus(false)).toBe('denied');
    expect(boolStatus(null)).toBe('denied');
    expect(boolStatus(undefined)).toBe('denied');
  });

  it('gives every status a pill copy + tone', () => {
    expect(permPillText('granted')).toBe('Granted');
    expect(permPillText('denied')).toBe('Denied');
    expect(permPillText('not-asked')).toBe('Not asked');
    expect(permPillText('unknown')).toBe('Checking…');
    expect(permPillTone('granted')).toBe('success');
    expect(permPillTone('denied')).toBe('destructive');
    expect(permPillTone('not-asked')).toBe('default');
    expect(permPillTone('unknown')).toBe('default');
  });
});

describe('permissions-model fix-flow shape', () => {
  it('only fires the OS prompt for a promptable permission that was never asked', () => {
    const mic = permMeta('microphone');
    const acc = permMeta('accessibility');
    // Mic (canPrompt) — prompt only when never-asked; denied must deep-link.
    expect(shouldPrompt(mic, 'not-asked')).toBe(true);
    expect(shouldPrompt(mic, 'denied')).toBe(false);
    expect(shouldPrompt(mic, 'granted')).toBe(false);
    // Accessibility (deep-link only) — never fires a prompt.
    expect(shouldPrompt(acc, 'not-asked')).toBe(false);
    expect(shouldPrompt(acc, 'denied')).toBe(false);
  });

  it('labels the fix action Allow when it can prompt, Open Settings otherwise', () => {
    expect(fixActionLabel(permMeta('microphone'), 'not-asked')).toBe('Allow…');
    expect(fixActionLabel(permMeta('microphone'), 'denied')).toBe('Open Settings');
    expect(fixActionLabel(permMeta('input-monitoring'), 'not-asked')).toBe('Allow…');
    expect(fixActionLabel(permMeta('accessibility'), 'not-asked')).toBe('Open Settings');
    expect(fixActionLabel(permMeta('screen-recording'), 'denied')).toBe('Open Settings');
  });

  it('detects a fresh grant only when an actionable state flips to granted', () => {
    expect(isFreshGrant('denied', 'granted')).toBe(true);
    expect(isFreshGrant('not-asked', 'granted')).toBe(true);
    // Already granted at open → not a fresh grant (no relaunch nag).
    expect(isFreshGrant('granted', 'granted')).toBe(false);
    // Pre-first-read → not a fresh grant.
    expect(isFreshGrant('unknown', 'granted')).toBe(false);
    // Still not granted → not a fresh grant.
    expect(isFreshGrant('denied', 'denied')).toBe(false);
  });
});

describe('permissions-model metadata', () => {
  it('exposes the four concierge permissions in render order with the right relaunch/prompt flags', () => {
    expect(PERM_IDS).toEqual(['microphone', 'accessibility', 'input-monitoring', 'screen-recording']);
    // Microphone applies live (no relaunch) and can self-prompt.
    expect(permMeta('microphone')).toMatchObject({ canPrompt: true, needsRelaunch: false });
    // The three TCC-cached grants need a relaunch to take effect.
    expect(permMeta('accessibility').needsRelaunch).toBe(true);
    expect(permMeta('input-monitoring').needsRelaunch).toBe(true);
    expect(permMeta('screen-recording').needsRelaunch).toBe(true);
    // Only mic + input-monitoring can fire their own prompt.
    expect(permMeta('input-monitoring').canPrompt).toBe(true);
    expect(permMeta('accessibility').canPrompt).toBe(false);
    expect(permMeta('screen-recording').canPrompt).toBe(false);
  });

  it('deep-links the exact Privacy_* pane for every permission', () => {
    const byId = Object.fromEntries(PERMISSIONS.map((p) => [p.id, p.deepLink]));
    expect(byId['microphone']).toContain('Privacy_Microphone');
    expect(byId['accessibility']).toContain('Privacy_Accessibility');
    expect(byId['input-monitoring']).toContain('Privacy_ListenEvent');
    expect(byId['screen-recording']).toContain('Privacy_ScreenCapture');
    for (const meta of PERMISSIONS) {
      expect(meta.deepLink.startsWith('x-apple.systempreferences:')).toBe(true);
    }
  });

  it('throws on an unknown permission id', () => {
    // @ts-expect-error — exercising the runtime guard with a bad id.
    expect(() => permMeta('bluetooth')).toThrow();
  });
});
