import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { resolveMuseBinary } from './host';

let root: string | undefined;
afterEach(() => { vi.unstubAllEnvs(); if (root) rmSync(root, { recursive: true, force: true }); });
it('finds a custom installation on PATH without executing it', async () => {
  if (process.platform === 'win32') return;
  root = realpathSync(mkdtempSync(join(tmpdir(), 'o8-muse-path-')));
  const binary = join(root, 'muse');
  writeFileSync(binary, '#!/bin/sh\nexit 99\n'); chmodSync(binary, 0o700);
  vi.stubEnv('O8_MUSE_BIN', ''); vi.stubEnv('PATH', root);
  expect(await resolveMuseBinary()).toBe(binary);
});
