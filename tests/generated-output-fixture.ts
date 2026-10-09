import { lstat, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { expect, onTestFinished } from 'vitest';

/** Keep failures, intentional refusals, banks and journals outside teardown deletion. */
export async function createRetainedGeneratedOutputFixture(prefix: string): Promise<string> {
  const configured = process.env.O8_TEST_RUN_DATA_ROOT;
  if (!configured) throw new Error('Generated-output fixtures need an owned test run root.');
  const runRoot = await realpath(configured);
  if (!/^o8-test-data-run-[A-Za-z0-9]{6}$/.test(path.basename(runRoot))) {
    throw new Error('Generated-output fixture run root is not an owned test run.');
  }
  const marker = path.join(runRoot, '.o8-test-run-retain.json');
  await writeFile(marker, JSON.stringify({ schema: 'o8/generated-output-fixture-retention/v1',
    retainedAt: new Date().toISOString(), reason: 'Preserve generated-output native evidence and expected failures' }) + '\n',
  { flag: 'wx', mode: 0o600 }).catch(async error => {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const entry = await lstat(marker);
    if (!entry.isFile() || entry.isSymbolicLink() || (entry.mode & 0o777) !== 0o600) throw error;
  });
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
  if (path.dirname(root) !== runRoot) throw new Error('Generated-output fixture escaped its retained run root.');
  const entry = await lstat(root);
  const creation = { schema: 'o8/generated-output-fixture/v1', createdAt: new Date().toISOString(),
    case: expect.getState().currentTestName, runRoot, root,
    identity: { device: entry.dev, inode: entry.ino }, cleanup: 'retained' };
  await writeFile(path.join(root, 'fixture-creation.json'), JSON.stringify(creation, null, 2) + '\n',
    { flag: 'wx', mode: 0o600 });
  onTestFinished(async context => {
    const tables: Record<string, unknown[]> = {};
    const observed: Array<{ path: string; device: number; inode: number } | { path: string; error: string }> = [];
    let databaseError: string | null = null;
    const databasePath = path.join(root, 'data/fixture.db');
    try {
      const database = new Database(databasePath, { readonly: true });
      try {
        for (const table of ['workspace_generated_outputs', 'workspace_generated_output_recoveries',
          'workspace_generated_output_bank_entries', 'workspace_generated_output_recovery_entries',
          'workspace_exact_claims', 'workspace_exact_finalizations', 'workspace_retention_holds']) {
          tables[table] = database.prepare(`SELECT * FROM ${table} LIMIT 4096`).all();
        }
      } finally { database.close(); }
    } catch (error) { databaseError = String(error); }
    const paths = new Set([root, path.join(root, 'repo'), path.join(root, 'data'), databasePath]);
    for (const row of tables.workspace_generated_outputs ?? []) {
      const payload = JSON.parse((row as { payload_json: string }).payload_json);
      for (const candidate of [payload.workspace?.canonicalPath, payload.output?.canonicalPath,
        payload.bank?.root?.canonicalPath, payload.recovery?.path, payload.retirement?.claim?.claimPath,
        payload.recovery?.retirement?.claim?.claimPath]) if (candidate) paths.add(candidate);
    }
    for (const candidate of paths) {
      try { const identity = await lstat(candidate); observed.push({ path: candidate, device: identity.dev, inode: identity.ino }); }
      catch (error) { observed.push({ path: candidate, error: String(error) }); }
    }
    await readFile(path.join(root, 'fixture-creation.json'));
    await writeFile(path.join(root, 'fixture-outcome.json'), JSON.stringify({ ...creation,
      observedAt: new Date().toISOString(), outcome: context.task.result?.state ?? 'unknown',
      observed, tables, databaseError }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    console.error(`[generated-output-fixture] retained native evidence at ${root}`);
  });
  return root;
}
