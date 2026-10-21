import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it, vi } from 'vitest';

const root = mkdtempSync(join(tmpdir(), 'o8-cli-version-path-'));
vi.stubEnv('CORTEX_IDE_DATA_DIR', root);
const { GET } = await import('@/app/api/setup/cli-updates/route');
const { invalidateCliCache } = await import('@/lib/runtimes/shared/cli-resolver');
afterAll(() => { invalidateCliCache('codex'); vi.unstubAllEnvs(); vi.unstubAllGlobals(); rmSync(root, { recursive: true, force: true }); });

it.skipIf(process.platform === 'win32')('checks a selected Node CLI through the update route with a stripped desktop PATH', async () => {
  const binary = join(root, 'codex');
  writeFileSync(binary, '#!/usr/bin/env node\nconsole.log("codex-cli 0.162.1");\n');
  chmodSync(binary, 0o700);
  vi.stubEnv('O8_CODEX_BIN', binary);
  vi.stubEnv('PATH', '');
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ version: '0.162.1' })));
  const response = await GET(new Request('http://localhost/api/setup/cli-updates?runtime=codex&refresh=1'));
  expect(response.status).toBe(200);
  expect((await response.json()).tools[0]).toMatchObject({ selectedPath: binary, installedVersion: '0.162.1', latestVersion: '0.162.1', status: 'current' });
});
