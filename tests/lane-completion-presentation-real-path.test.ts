import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it, vi } from 'vitest';
import { mutationToLaneLifecyclePayload } from '@/lib/realtime/lane-lifecycle';
import { deriveLaneStatusEvent } from '@/lib/orchestrator/status-events';
import type { RealtimeMutationPublishRequest } from '@/lib/realtime/types';

const published = vi.hoisted(() => [] as Omit<RealtimeMutationPublishRequest, 'kind'>[]);
vi.mock('@/lib/realtime/publisher', () => ({
  publishRealtimeMutation: vi.fn(async (request) => { published.push(request); return true; }),
}));
const dataDir = mkdtempSync(join(tmpdir(), 'o8-completion-presentation-'));
process.env.CORTEX_IDE_DATA_DIR = dataDir;
const { createLane, updateLane, getLane } = await import('@/lib/lane/registry');
const { closeDb } = await import('@/lib/db');
afterAll(() => { closeDb(); rmSync(dataDir, { recursive: true, force: true }); });

it('publishes the persisted title and terminal outcome before the packet snapshot catches up', () => {
  const lane = createLane({ repoPath: '/repo', branch: 'task', baseBranch: 'main', runtime: 'codex',
    packetId: 'packet', label: 'Inspect packet state' });
  updateLane(lane.id, { status: 'completed', outcome: 'no_changes', lastEventLabel: 'read_only_completed' }, 'system');
  closeDb();
  expect(getLane(lane.id)).toMatchObject({ status: 'completed', outcome: 'no_changes', label: 'Inspect packet state' });
  const mutation = JSON.parse(JSON.stringify(published.at(-1)!.mutation));
  expect(mutation).toMatchObject({ laneLabel: 'Inspect packet state', laneOutcome: 'no_changes' });
  const payload = mutationToLaneLifecyclePayload(mutation)!;
  expect(deriveLaneStatusEvent(payload, () => null)).toEqual({ kind: 'packet-complete', packetTitle: 'Inspect packet state', closed: false });
});
