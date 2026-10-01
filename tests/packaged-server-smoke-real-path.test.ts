import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { smokePackagedServer } from '../scripts/lib/packaged-server-smoke.mjs';

const roots: string[] = [];

function fixture(source: string): string {
  const root = mkdtempSync(join(tmpdir(), 'o8-packaged-server-fixture-'));
  roots.push(root);
  mkdirSync(join(root, 'node_modules'));
  writeFileSync(join(root, 'server.js'), source);
  return root;
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('packaged server startup gate', () => {
  it('rejects a module failure from the actual packaged server process', async () => {
    const root = fixture("require('next/dist/compiled/find-up');\n");
    await expect(smokePackagedServer(root, { timeoutMs: 5000 }))
      .rejects.toThrow("Cannot find module 'next/dist/compiled/find-up'");
  });

  it('accepts a server that serves the instance identity on its assigned port', async () => {
    const root = fixture(`const http = require('node:http');
http.createServer((request, response) => {
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify({product: 'o8', apiPort: Number(process.env.PORT), bootId: process.env.O8_BOOT_ID, version: 'test'}));
}).listen(Number(process.env.PORT), '127.0.0.1');`);
    await expect(smokePackagedServer(root, { timeoutMs: 5000 }))
      .resolves.toMatchObject({ version: 'test' });
  });
});
