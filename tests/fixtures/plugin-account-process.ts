import Database from 'better-sqlite3';
import { getDataDir } from '../../src/lib/data-dir-migration';
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { POST } from '../../src/app/api/panel/entitlement/sync/route';
import { withAccountStateLease } from '../../src/lib/auth/account-state';
import { markAuthSignedOut } from '../../src/lib/auth/sign-out-marker';
import { withTaskDraftAccountAdmission } from '../../src/lib/mcp/task-draft-account';

const [mode, scratch, accountId, license] = process.argv.slice(2);
const signal = (name: string) => writeFileSync(join(scratch, name), '1');
async function wait() {
  const deadline = Date.now() + 15_000;
  while (!existsSync(join(scratch, 'release'))) {
    if (Date.now() > deadline) throw new Error('Fixture barrier timed out.');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
async function sync(body: Record<string, unknown>) {
  return POST(new Request('http://localhost/api/panel/entitlement/sync', { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-clerk-session-token': 'fixture-current-session' },
    body: JSON.stringify(body) }));
}
globalThis.fetch = async (input) => {
  if (!String(input).endsWith('/account/license')) return new Response('{}', { status: 503 });
  if (mode === 'refresh') { signal('fetching'); await wait(); }
  return Response.json({ license });
};

async function run() {
  signal('started');
  if (mode === 'db-write-lock') {
    const db = new Database(join(getDataDir(), 'account-state.sqlite'), { timeout: 0 });
    try {
      db.exec('BEGIN IMMEDIATE'); signal('entered'); await wait(); db.exec('ROLLBACK');
    } finally { db.close(); }
    return { locked: false };
  }
  if (mode === 'signout') return (await sync({ signedOut: true })).json();
  if (mode === 'transition' || mode === 'crash-transition') {
    return withAccountStateLease(async () => {
      markAuthSignedOut(); // Commits blocked before this first legacy write.
      signal('entered');
      if (mode === 'crash-transition') process.exit(17);
      await wait();
      return (await sync({ signedOut: true })).json();
    });
  }
  if (mode === 'refresh' || mode === 'crash-ready') {
    return withAccountStateLease(async () => {
      // Refresh is normally outside the lock; crash-ready intentionally retains
      // an outer lease to simulate process death just after ready publication.
      if (mode === 'refresh') throw new Error('Use the unlocked refresh branch.');
      await sync({ clearSignInMarker: true });
      const result = await (await sync({ clerkUserId: accountId })).json();
      signal('entered');
      process.exit(17);
      return result;
    });
  }
  try {
    return await withTaskDraftAccountAdmission({ accountId, expiresAt: Date.now() + 60_000 }, undefined, async () => {
      signal('entered');
      if (mode === 'admit-wait') await wait();
      // Real process creation is the boundary. This is a fixture, not a provider
      // CLI or a production dispatch tool, and grants no new launch permission.
      const child = spawn(process.execPath, ['-e', 'require("node:fs").appendFileSync(process.argv[1], "run\\n")', join(scratch, 'children')]);
      await new Promise<void>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code) => code === 0 ? resolve() : reject(new Error('Fixture child failed.')));
      });
      return { admitted: true };
    });
  } catch { return { admitted: false }; }
}
async function main() {
  const result = mode === 'refresh' ? await (await sync({ clerkUserId: accountId })).json() : await run();
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
main().catch(() => { process.stderr.write('Account fixture failed.\n'); process.exitCode = 1; });
