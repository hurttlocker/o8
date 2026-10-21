import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureMuseRuntimeConfig, museRoot } from './roots';

const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
describe('Muse trusted state roots', () => {
  it('captures ambient account state before persistence and preserves other pins', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'o8-muse-roots-'))); roots.push(root);
    vi.stubEnv('XDG_CONFIG_HOME', join(root, 'config')); vi.stubEnv('XDG_DATA_HOME', join(root, 'data'));
    expect(captureMuseRuntimeConfig({ workMode: 'read-only', museConfigRoot: '/caller/override' })).toEqual({ workMode: 'read-only', museConfigRoot: join(root, 'config'), museDataRoot: join(root, 'data') });
  });
  it('refuses relative, broad and redirected stored account roots', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'o8-muse-roots-'))); roots.push(root);
    mkdirSync(join(root, 'target')); symlinkSync(join(root, 'target'), join(root, 'redirect'));
    expect(() => museRoot('relative', true)).toThrow(); expect(() => museRoot('/', true)).toThrow();
    expect(() => museRoot(join(root, 'redirect'), true)).toThrow();
    symlinkSync(join(root, 'target'), join(root, 'muse'));
    expect(() => museRoot(root, true)).toThrow();
  });
});
