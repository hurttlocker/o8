import { describe, expect, it } from 'vitest';
import { composerBackendSupportsImages, validateComposerImageAttachments } from './composer-image-validation';

describe('composer image preflight', () => {
  const png = { dataUri: 'data:image/png;base64,aW1hZ2U=', name: 'photo.png' };

  it('retains valid images and known image-capable backends', () => {
    expect(validateComposerImageAttachments([png])).toEqual([png]);
    expect(composerBackendSupportsImages('codex')).toBe(true);
    expect(composerBackendSupportsImages('claude')).toBe(true);
    expect(composerBackendSupportsImages('fable')).toBe(true);
    expect(composerBackendSupportsImages('collide')).toBe(true);
    expect(composerBackendSupportsImages('opencode')).toBe(false);
  });

  it('normalizes accepted URI casing for the image consumers', () => {
    expect(validateComposerImageAttachments([{ dataUri: 'DATA:IMAGE/PNG;BASE64,aW1hZ2U=' }]))
      .toEqual([{ dataUri: png.dataUri }]);
  });

  it('rejects unsupported, oversized, and extra images instead of dropping them', () => {
    expect(() => validateComposerImageAttachments([{ dataUri: 'data:image/heic;base64,aW1hZ2U=' }])).toThrow(/PNG, JPEG, GIF, or WebP/);
    expect(() => validateComposerImageAttachments([{ dataUri: `data:image/png;base64,${'a'.repeat(5_000_000)}` }])).toThrow(/under 5 MB/);
    expect(() => validateComposerImageAttachments(Array.from({ length: 9 }, () => png))).toThrow(/at most 8/);
    expect(() => validateComposerImageAttachments([{ dataUri: 'data:image/png;base64,%%%' }])).toThrow(/PNG, JPEG, GIF, or WebP/);
    expect(() => validateComposerImageAttachments([{ dataUri: 'data:image/png;base64,a' }])).toThrow(/invalid data/);
  });
});
