import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';

const dataDir = mkdtempSync(join(tmpdir(), 'o8-worker-poll-revocation-'));
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;
const poll = await import('@/app/api/cloud/worker-poll/route');
const { createCloudWorkerKey, revokeCloudWorkerKey } = await import('@/lib/cloud/worker-auth');
const { enqueueCloudJob, getJob } = await import('@/lib/cloud/job-queue');
const { closeDb } = await import('@/lib/db');
afterAll(() => { closeDb(); rmSync(dataDir, { recursive: true, force: true }); });

it('refuses a revoked open poll without claiming, allowing another scoped worker to claim once', async () => {
  const revoked = createCloudWorkerKey({ teamId: 'team_default', label: 'revoked waiter fixture' });
  const valid = createCloudWorkerKey({ teamId: 'team_default', label: 'valid waiter fixture' });
  const waiting = poll.GET(new Request('http://localhost/api/cloud/worker-poll?workerId=revoked-worker&waitMs=1000', {
    headers: { Authorization: `Bearer ${revoked.plaintext}` },
  }));
  revokeCloudWorkerKey(revoked.record.id);
  const job = enqueueCloudJob('team_default', 'revocation-job', {
    cwd: dataDir, prompt: 'Private task fixture.', packetId: 'revocation-packet',
    remoteSource: { repoUrl: 'https://example.invalid/fixture.git', baseSha: 'a'.repeat(40), branch: 'test/revocation' },
  });
  const refused = await waiting;
  expect(refused.status).toBe(403);
  expect(await refused.json()).toMatchObject({ reason: 'revoked' });
  closeDb();
  expect(getJob('team_default', job.id)).toMatchObject({ status: 'pending', claimCount: 0, claimedBy: undefined });
  const accepted = await poll.GET(new Request('http://localhost/api/cloud/worker-poll?workerId=valid-worker&waitMs=0', {
    headers: { Authorization: `Bearer ${valid.plaintext}` },
  }));
  expect(accepted.status).toBe(200);
  expect((await accepted.json()).job).toMatchObject({ id: job.id, claimedBy: 'valid-worker', claimCount: 1 });
});
