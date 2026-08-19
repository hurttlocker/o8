import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Leases written before the namespace fix stored their paths under /private, which
// the disk-image tooling never reports back. A registry opened by a later process
// has to keep serving those rows through the real lookup and authority entry points.
const RECIPE_KEY = 'a'.repeat(64);
const GENERATION = '3b0c4c0e-4a2f-4bb0-9f52-6a5d4c8e1f77';
const LEASE_ID = 'b0a1d2c3-4e5f-4a6b-8c9d-0e1f2a3b4c5d';

let dataDir = '';
let previousDataDir: string | undefined;
let previousO8DataDir: string | undefined;

function preFixPaths() {
  // Exactly what the pre-fix writer persisted: path.resolve of the canonical
  // workspace, which keeps the /private prefix that hdiutil and mount never use.
  const canonicalWorkspace = path.resolve(`/private${dataDir}`, 'workspaces/image-second');
  return {
    canonicalWorkspace,
    canonicalShadow: path.resolve(`/private${dataDir}`, 'shadows/image-second.shadow'),
    canonicalMount: path.join(canonicalWorkspace, 'node_modules'),
    reportedWorkspace: path.resolve(dataDir, 'workspaces/image-second'),
    reportedShadow: path.resolve(dataDir, 'shadows/image-second.shadow'),
    reportedMount: path.join(path.resolve(dataDir, 'workspaces/image-second'), 'node_modules'),
  };
}

async function writePreFixLeaseRow(): Promise<void> {
  const db = await import('@/lib/db');
  const registry = await import('@/lib/workspace/dependency-seed-registry');
  // Touch a real read first so the production schema is created by production code.
  expect(registry.listDependencySeedLeases()).toEqual([]);
  const paths = preFixPaths();
  const now = Date.now();
  const sqlite = db.getSqlite();
  sqlite.prepare(`
    INSERT INTO dependency_seed_images (
      recipe_key, generation, state, image_path, manifest_path,
      staging_directory, staging_path, staging_device, staging_inode,
      created_at, updated_at
    ) VALUES (?, ?, 'ready', ?, ?, ?, ?, 1, 1, ?, ?)
  `).run(
    RECIPE_KEY,
    GENERATION,
    path.join(dataDir, 'images/image.dmg'),
    path.join(dataDir, 'images/image.dmg.manifest.json'),
    path.join(dataDir, 'staging'),
    path.join(dataDir, 'staging/image.dmg'),
    now,
    now,
  );
  sqlite.prepare(`
    INSERT INTO dependency_seed_leases (
      lease_id, recipe_key, generation, workspace_path, shadow_path, mount_path,
      state, owner_pid, owner_identity_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'mounted', ?, ?, ?, ?)
  `).run(
    LEASE_ID,
    RECIPE_KEY,
    GENERATION,
    paths.canonicalWorkspace,
    paths.canonicalShadow,
    paths.canonicalMount,
    process.pid,
    JSON.stringify({ pid: process.pid, startedAt: now }),
    now,
    now,
  );
  db.closeDb();
}

beforeEach(() => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), 'o8-lease-namespace-backcompat-'));
  previousDataDir = process.env.CORTEX_IDE_DATA_DIR;
  previousO8DataDir = process.env.O8_DATA_DIR;
  process.env.CORTEX_IDE_DATA_DIR = dataDir;
  process.env.O8_DATA_DIR = dataDir;
  vi.resetModules();
});

afterEach(async () => {
  await import('@/lib/db').then((db) => db.closeDb()).catch(() => undefined);
  vi.resetModules();
  if (previousDataDir === undefined) delete process.env.CORTEX_IDE_DATA_DIR;
  else process.env.CORTEX_IDE_DATA_DIR = previousDataDir;
  if (previousO8DataDir === undefined) delete process.env.O8_DATA_DIR;
  else process.env.O8_DATA_DIR = previousO8DataDir;
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

describe('dependency seed lease namespace back-compat', () => {
  it('serves a pre-fix lease row through lookup and the expected-lease authority', async () => {
    await writePreFixLeaseRow();
    const paths = preFixPaths();

    // A later process opens the same registry.
    vi.resetModules();
    const registry = await import('@/lib/workspace/dependency-seed-registry');
    const receipt = await import('@/lib/workspace/dependency-image-lease-receipt');

    // Site 1: lookup answers for both spellings of the same workspace.
    const byCanonical = registry.findDependencySeedLeaseForWorkspace(paths.canonicalWorkspace);
    const byReported = registry.findDependencySeedLeaseForWorkspace(paths.reportedWorkspace);
    expect(byCanonical?.leaseId).toBe(LEASE_ID);
    expect(byReported?.leaseId).toBe(LEASE_ID);

    // The stored row now speaks the namespace the disk-image tooling reports.
    expect(byCanonical?.workspacePath).toBe(paths.reportedWorkspace);
    expect(byCanonical?.mountPath).toBe(paths.reportedMount);
    // Site 3: cleanup planning compares this against normalized hdiutil output.
    expect(byCanonical?.shadowPath).toBe(paths.reportedShadow);

    // Site 2: the expected-lease authority accepts the row for either spelling.
    for (const workspacePath of [paths.canonicalWorkspace, paths.reportedWorkspace]) {
      expect(() => receipt.assertExpectedDependencyImageLease(byCanonical, {
        leaseId: LEASE_ID,
        recipeKey: RECIPE_KEY,
        generation: GENERATION,
        workspacePath,
      })).not.toThrow();
    }

    // The sweep is a one-time collapse, not a lookup-time rewrite: no row survives
    // in the old namespace for a second opener to strand itself against.
    expect(registry.listDependencySeedLeases().map((lease) => lease.workspacePath))
      .toEqual([paths.reportedWorkspace]);
  });
});
