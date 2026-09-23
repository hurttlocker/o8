import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { codexComposerImagePaths, persistComposerImages } from './orchestrator-image-media';

const previousMediaRoot = process.env.CORTEX_IDE_MEDIA_ROOT;
const roots: string[] = [];

afterEach(() => {
  if (previousMediaRoot === undefined) delete process.env.CORTEX_IDE_MEDIA_ROOT;
  else process.env.CORTEX_IDE_MEDIA_ROOT = previousMediaRoot;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('composer image media', () => {
  it('stores one content-addressed image for the transcript and Codex CLI', () => {
    const root = mkdtempSync(join(tmpdir(), 'o8-composer-image-'));
    roots.push(root);
    process.env.CORTEX_IDE_MEDIA_ROOT = join(root, 'media');
    const attachment = { dataUri: `data:image/png;base64,${Buffer.from('image').toString('base64')}`, name: 'photo.png' };
    const [media] = persistComposerImages([attachment]);
    const [retry] = persistComposerImages([attachment]);
    const [codexPath] = codexComposerImagePaths([attachment], join(root, 'codex-home'));

    expect(retry.path).toBe(media.path);
    expect(media.name).toBe('photo.png');
    expect(readFileSync(media.path).toString()).toBe('image');
    expect(statSync(codexPath).ino).toBe(statSync(media.path).ino);
  });

  it('rejects unsupported and malformed image data before persistence', () => {
    const root = mkdtempSync(join(tmpdir(), 'o8-composer-image-'));
    roots.push(root);
    process.env.CORTEX_IDE_MEDIA_ROOT = join(root, 'media');
    expect(() => persistComposerImages([{ dataUri: 'data:image/svg+xml;base64,PHN2Zz4=', name: 'unsafe.svg' }])).toThrow();
    expect(() => persistComposerImages([{ dataUri: 'data:image/png;base64,%%%=', name: 'broken.png' }])).toThrow();
  });
});
