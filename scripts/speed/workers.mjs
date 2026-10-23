import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { tool } from './mcp.mjs';
import { round, sleep, writeJson } from './common.mjs';

export function prepareWorkerFixture(seeded) {
  // Local origin keeps network fetching separate from measured provisioning.
  const origin = path.join(seeded.dataDir, 'origin.git');
  execFileSync('git', ['clone', '--bare', seeded.repoDir, origin], { stdio: 'ignore' });
  execFileSync('git', ['remote', 'add', 'origin', origin], { cwd: seeded.repoDir, stdio: 'ignore' });
  execFileSync('git', ['fetch', 'origin'], { cwd: seeded.repoDir, stdio: 'ignore' });
  // A selected throwaway identity keeps mutable Codex session state out of the
  // operator's config home. Copy only the existing sign-in, never log it.
  const source = process.env.CODEX_HOME?.trim() || path.join(os.homedir(), '.codex');
  // Providers may materialize plugin TypeScript. Keep generated runtime state
  // outside the application's recursive source-discovery glob.
  const isolated = path.join(seeded.dataDir, '.speed-codex-identity');
  fs.mkdirSync(isolated, { recursive: true, mode: 0o700 });
  fs.copyFileSync(path.join(source, 'auth.json'), path.join(isolated, 'auth.json'));
  fs.chmodSync(path.join(isolated, 'auth.json'), 0o600);
  const now = new Date().toISOString();
  writeJson(path.join(seeded.dataDir, 'runtime-identities.json'), {
    schema: 'o8/runtime-identities/v1', identities: [{ id: 'speed-codex', runtime: 'codex', label: 'Speed fixture', configHomeRef: isolated, createdAt: now, updatedAt: now }],
    selectedByRuntime: { codex: 'speed-codex' }, packetBindings: {},
  });
  const nativeWorkerToken = path.join(os.homedir(), '.o8', 'native-worker-token.json');
  if (fs.existsSync(nativeWorkerToken)) {
    const destination = path.join(seeded.dataDir, 'native-worker-token.json');
    fs.copyFileSync(nativeWorkerToken, destination);
    fs.chmodSync(destination, 0o600);
  }
}
function sessions(seeded, runtime) {
  const dir = path.join(seeded.dataDir, runtime === 'codex' ? 'owned-codex' : 'owned-claude-code');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).flatMap(entry => {
    const file = path.join(dir, entry, 'session.json');
    try { return [{ ...JSON.parse(fs.readFileSync(file, 'utf8')), file }]; } catch { return []; }
  });
}
export function persistedWorkerStages(dataDir, packetId, dispatchAt, spawnAt) {
  const database = new Database(path.join(dataDir, 'cortex-ide.db'), { readonly: true });
  try {
    const lane = database.prepare('SELECT id FROM lanes WHERE packet_id = ? ORDER BY created_at DESC LIMIT 1').get(packetId)
      ?? database.prepare("SELECT lane_id AS id FROM lane_events WHERE verb = 'open_lane' AND json_extract(payload_json, '$.packetId') = ? ORDER BY timestamp DESC LIMIT 1").get(packetId);
    if (!lane) return { status: 'unavailable', reason: 'No persisted packet lane' };
    const events = database.prepare('SELECT verb, payload_json, timestamp FROM lane_events WHERE lane_id = ? ORDER BY timestamp').all(lane.id)
      .map(row => ({ ...row, payload: JSON.parse(row.payload_json), at: Date.parse(row.timestamp) }));
    const opened = events.find(row => row.verb === 'open_lane');
    const provisioned = events.find(row => row.verb === 'update' && row.payload.worktreePath);
    const timings = events.filter(row => row.verb === 'worktree_preparation_timing').map(row => ({
      stage: row.payload.stage, durationMs: row.payload.durationMs, completed: row.payload.completed,
    }));
    return { status: 'measured', admissionMs: opened ? opened.at - dispatchAt : null,
      workspaceProvisioningMs: opened && provisioned ? provisioned.at - opened.at : null,
      runtimeSpawnMs: provisioned && spawnAt ? spawnAt - provisioned.at : null,
      dependencyProvisioningMs: timings.find(row => row.stage === 'dependency_materialization')?.durationMs ?? 0,
      timings, limits: 'Dependency-free fixture; zero means no install was requested. Workspace stage includes launch preparation until the persisted worktree binding, not just clone I/O.' };
  } finally { database.close(); }
}
export async function measureWorker(stack, seeded, evidence, runtime, sample, timeoutMs = 240000) {
  const model = runtime === 'codex' ? 'gpt-6.1-sol' : 'claude-sonnet-5';
  const effort = 'medium';
  const requestedAt = Date.now();
  const prepared = await tool(stack, 'create_mission', { repoPath: seeded.repoDir, runtime, model,
    ...(runtime === 'claude-code' ? { carrier: 'native' } : {}), requestedEffort: effort, dispatch: false, holdMerges: true, useBrain: false,
    issues_inline: [{ title: `Speed measurement ${runtime} ${sample}`, body: 'Measurement only. Your entire task is to reply SPEED_READY immediately. Do not run tools, edit files, commit, push, create a PR, or delegate. Stop after the reply.' }],
    constraints: 'Reply SPEED_READY immediately; no tools, file changes, commits, pushes, PRs, or delegation.' });
  writeJson(path.join(evidence, `worker-${runtime}-${sample}-prepared.private.json`), prepared.data);
  const missionId = prepared.data.missionId;
  if (!missionId) throw new Error('Mission creation did not return missionId');
  const baselineSessions = new Set(sessions(seeded, runtime).map(row => row.surfaceId));
  const dispatchAt = Date.now();
  let dispatchError;
  const pending = tool(stack, 'dispatch_mission', { missionId }).catch(error => { dispatchError = error.message; });
  let firstByteAt;
  let firstAssistantAt;
  let tokenKind;
  let observed;
  while (Date.now() - dispatchAt < timeoutMs) {
    observed = sessions(seeded, runtime).find(row => !baselineSessions.has(row.surfaceId));
    const run = observed?.activeRun ?? observed?.recentRuns?.[0];
    if (run?.stdoutPath && fs.existsSync(run.stdoutPath)) {
      const text = fs.readFileSync(run.stdoutPath, 'utf8');
      if (text.length && !firstByteAt) firstByteAt = Date.now();
      const delta = /"(?:type|method)"\s*:\s*"(?:text_delta|item\/agentMessage\/delta)"/.test(text);
      const complete = /"type"\s*:\s*"(?:assistant|agent_message)"/.test(text);
      if (delta || complete) { firstAssistantAt = Date.now(); tokenKind = delta ? 'token-delta' : 'complete-assistant-message'; break; }
    }
    if (dispatchError) break;
    await sleep(50);
  }
  await pending;
  const run = observed?.activeRun ?? observed?.recentRuns?.[0];
  // Persist the observation before any teardown can archive the run journal.
  writeJson(path.join(evidence, `worker-${runtime}-${sample}-observation.private.json`), { dispatchAt, firstByteAt, firstAssistantAt, tokenKind, run });
  const packetId = prepared.data.packets?.[0]?.id;
  let stopStatus = null;
  if (packetId) {
    const response = await fetch(`${stack.base}/api/orchestrator/stop-packet`, { method: 'POST', headers: { Authorization: `Bearer ${stack.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ packetId }), signal: AbortSignal.timeout(30000) });
    stopStatus = { http: response.status, result: await response.json() };
  }
  const spansFile = path.join(evidence, 'process-spans.jsonl');
  const spans = fs.existsSync(spansFile) ? fs.readFileSync(spansFile, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(row => row.at >= dispatchAt) : [];
  const worktreeStart = spans.find(row => row.command === 'git' && row.operation === 'worktree:add' && row.event === 'start');
  const worktreeEnd = worktreeStart ? spans.find(row => row.id === worktreeStart.id && row.event === 'exit') : null;
  const spawnEvent = spans.find(row => row.event === 'spawned' && row.childPid === run?.pid);
  const spawnAt = spawnEvent?.at ?? (run?.startedAt ? Date.parse(run.startedAt) : null);
  const stages = packetId ? persistedWorkerStages(seeded.dataDir, packetId, dispatchAt, spawnAt) : null;
  if (!firstAssistantAt) throw new Error(dispatchError ?? 'No assistant output before deadline');
  if (stopStatus?.http !== 200) throw new Error('Owned worker stop did not succeed');
  if (stages?.status !== 'measured' || !['admissionMs', 'workspaceProvisioningMs', 'runtimeSpawnMs'].every(key => Number.isFinite(stages[key]) && stages[key] >= 0)) throw new Error('Worker stage evidence is incomplete');
  const offset = at => at == null ? null : round(at - dispatchAt);
  return { runtime, model, effectiveModel: observed?.model ?? null, effort, sample, requestedAt, missionPreparationMs: prepared.ms, dispatchAt, missionId, surfaceId: observed?.surfaceId ?? null,
    status: firstAssistantAt ? 'measured' : 'unavailable', error: dispatchError ?? (firstAssistantAt ? null : 'No assistant output before deadline'),
    requestToAssistantOutputMs: firstAssistantAt ? firstAssistantAt - requestedAt : null,
    dispatchToFirstByteMs: offset(firstByteAt), dispatchToAssistantOutputMs: offset(firstAssistantAt),
    admissionToWorktreeStartMs: offset(worktreeStart?.at), gitWorktreeMs: worktreeEnd ? worktreeEnd.at - worktreeStart.at : null,
    dispatchToRecordedSpawnMs: offset(spawnAt), spawnEvidence: spawnEvent ? 'Node child spawn event matched persisted run PID' : 'persisted run journal timestamp', spawnToAssistantOutputMs: firstAssistantAt && spawnAt ? firstAssistantAt - spawnAt : null,
    tokenKind, stopStatus, modelFirstTokenMs: tokenKind === 'token-delta' && spawnAt ? firstAssistantAt - spawnAt : null,
    stages, dependencyProvisioningMs: stages?.dependencyProvisioningMs ?? null, limits: 'Local fixture has no dependency install. Spawn evidence is labeled; complete assistant messages are an upper bound on first token. Polling resolution 50ms.',
    processSpans: spans };
}
