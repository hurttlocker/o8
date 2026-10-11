import { describe, expect, it } from 'vitest';
import { remotePreviewService, validPreviewPath } from './preview-contract';

describe('reviewed remote preview target', () => {
  const manifest = { version: 1 as const, services: [{ name: 'web', command: 'node server.js', port: { preferred: 3000 }, health: { tcp: true as const } }] };
  it('resolves a named reviewed service and preserves its path', () => {
    expect(remotePreviewService({ ...manifest, preview: { url: 'http://127.0.0.1:{{service:web}}/app?q=1' } }))
      .toMatchObject({ name: 'web', port: 3000, path: '/app?q=1', commandId: expect.stringMatching(/^[a-f0-9]{64}$/) });
  });
  it.each(['https://127.0.0.1:3000', 'http://example.invalid:3000', 'http://127.0.0.1:4000', 'http://user:secret@127.0.0.1:3000', 'http://127.0.0.1:3000/#secret', 'http://127.0.0.1:{{service:missing}}'])('rejects an unreviewed destination %s', (url) => {
    expect(() => remotePreviewService({ ...manifest, preview: { url } })).toThrow();
  });
  it('rejects ambiguous ports and services without health', () => {
    expect(() => remotePreviewService({ ...manifest, services: [...manifest.services, { ...manifest.services[0]!, name: 'other' }], preview: { url: 'http://127.0.0.1:3000' } })).toThrow();
    expect(() => remotePreviewService({ ...manifest, services: [{ ...manifest.services[0]!, health: undefined }], preview: { url: 'http://127.0.0.1:3000' } })).toThrow();
  });
  it.each(['//example.invalid/a', '/\\example.invalid', 'http://example.invalid', '/a\n', '/a#secret'])('rejects unsafe request paths %s', (path) => {
    expect(validPreviewPath(path)).toBe(false);
  });
});
