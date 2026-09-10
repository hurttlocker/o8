// A real queue owner which can be killed without killing its detached provider.
import { spawn } from 'node:child_process';
import { getSqlite } from '../../src/lib/db';
import { drainPacketExplainerQueue } from '../../src/lib/lane/packet-explainer-queue';
import { createOrchestratorTurnRecord } from '../../src/lib/lane/orchestrator-crash-survival';
import { sessionNameForRepo } from '../../src/lib/lane/orchestrator-session-core';

void drainPacketExplainerQueue(async (params) => {
  const provider = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: true, stdio: 'ignore',
  });
  provider.unref();
  const record = createOrchestratorTurnRecord({
    backend: 'codex',
    sessionName: sessionNameForRepo('cortex-codex-orchestrator', params.lane.repoPath, params.generationId),
    repoPath: params.lane.repoPath, threadId: params.generationId, pid: provider.pid!,
  });
  const row = getSqlite().prepare('SELECT * FROM explainer_queue WHERE status = ?').get('in_progress');
  process.send?.({ providerPid: provider.pid, record, row });
  await new Promise(() => {});
  return { outcome: 'ready', backend: 'codex', durationMs: 0, approximateCost: null };
});
setInterval(() => {}, 1000);
