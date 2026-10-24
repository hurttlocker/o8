import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { expect } from 'vitest';

import { GET } from '@/app/api/orchestrator/workspace/preservation/route';
import { closeDb, getSqlite } from '@/lib/db';
import { readWorkspacePreservation } from '@/lib/workspace/preservation-store';

/** Called after the owning test establishes its isolated store and source receipt. */
export async function verifyHistoricalGitBundleManifest(preservationId: string, dataDir: string, packetId: string) {
  const archive = await readWorkspacePreservation(preservationId);
  const historical = { ...archive.payload };
  delete historical.gitBundle;
  const content = Buffer.from(JSON.stringify(historical));
  const legacyId = createHash('sha256').update(content).digest('hex');
  writeFileSync(path.join(dataDir, 'workspace-preservation', legacyId + '.json'), content, { mode: 0o600, flag: 'wx' });
  // Seed a separate historical fixture receipt; never rewrite an existing manifest or owner journal.
  const row = getSqlite().prepare('SELECT * FROM workspace_preservations WHERE preservation_id = ?')
    .get(preservationId) as Record<string, string | number | null>;
  const columns = Object.keys(row);
  getSqlite().prepare('INSERT INTO workspace_preservations (' + columns.join(', ') + ') VALUES ('
    + columns.map(() => '?').join(', ') + ')').run(...columns.map((column) => (
    column === 'preservation_id' || column === 'manifest_sha256' ? legacyId : row[column]
  )));
  closeDb();
  const legacy = await readWorkspacePreservation(legacyId);
  expect(legacy.payload.gitBundle).toBeUndefined();
  expect(legacy.receipt.headCommit).toBe(archive.receipt.headCommit);
  expect(legacy.payload.capture).toEqual(archive.payload.capture);
  const worker = new NextRequest('http://localhost/api/orchestrator/workspace/preservation?packetId=' + packetId + '&format=bundle', {
    headers: { authorization: 'Bearer git-bundle-worker-test-token', host: 'localhost' },
  });
  expect((await GET(worker)).status).toBe(403);
  expect((await GET(new NextRequest(worker.url))).status).toBe(401);
}
