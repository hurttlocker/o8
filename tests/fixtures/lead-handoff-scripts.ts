export const dispatchWorkerHelper = `
  import { execFileSync } from 'node:child_process';
  import { existsSync, writeFileSync } from 'node:fs';
  import path from 'node:path';
  const repos = (await import('./src/lib/repos/registry.ts')).default;
  const missions = (await import('./src/lib/orchestrator/operator-mission-service.ts')).default;
  const laneRegistry = (await import('./src/lib/lane/registry.ts')).default;
  const readiness = await fetch('http://127.0.0.1:' + process.env.O8_API_PORT + '/api/setup/status', {
    headers: { authorization: 'Bearer ' + process.env.O8_API_TOKEN },
  });
  console.log('[lead-fixture] readiness=' + readiness.status + ' port=' + process.env.O8_API_PORT);
  await repos.addRepo(process.env.O8_TEST_TARGET_REPO);
  const mission = await missions.createMission({
    issues: [{ number: 2541, title: 'Persistent lead worker fixture', body: 'Write the deterministic proof file.', url: '' }],
    repoPath: process.env.O8_TEST_TARGET_REPO,
    runtime: 'codex',
    constraints: '',
    orchestratorThreadId: process.env.O8_TEST_THREAD_ID,
    orchestratorTurnId: process.env.O8_TEST_TURN_ID,
  });
  await missions.dispatchMission({ missionId: mission.missionId });
  const packetId = mission.packets[0].id;
  const deadline = Date.now() + 15000;
  let lane;
  while (Date.now() < deadline) {
    lane = laneRegistry.findLaneByPacket(packetId);
    if (lane?.sessionKey) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!lane?.sessionKey) throw new Error('Worker did not launch for packet ' + packetId);
  const proofPath = path.join(lane.worktreePath, 'lead-worker-proof.txt');
  const proofDeadline = Date.now() + 10_000;
  while (Date.now() < proofDeadline && !existsSync(proofPath)) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (!existsSync(proofPath)) throw new Error('Worker did not produce its proof file for packet ' + packetId);
  const workerHead = execFileSync('git', ['-C', lane.worktreePath, 'log', '-1', '--format=%s'], { encoding: 'utf8' }).trim();
  if (workerHead !== 'test: add persistent lead proof') throw new Error('Worker proof was not committed.');
  writeFileSync(process.env.O8_TEST_CONNECTED_WORKER_FILE, JSON.stringify({
    missionId: mission.missionId,
    packetId,
    laneId: lane.id,
    sessionKey: lane.sessionKey,
    worktreePath: lane.worktreePath,
    threadId: process.env.O8_TEST_THREAD_ID,
    turnId: process.env.O8_TEST_TURN_ID,
  }));
  process.exit(0);
`;

export const reviewWorkerHelper = `
  import { execFileSync } from 'node:child_process';
  import { readFileSync, writeFileSync } from 'node:fs';
  const missions = (await import('./src/lib/orchestrator/operator-mission-service.ts')).default;
  const worker = JSON.parse(readFileSync(process.env.O8_TEST_CONNECTED_WORKER_FILE, 'utf8'));
  if (!worker.packetId || !worker.worktreePath) throw new Error('Review worker binding is missing.');
  const head = execFileSync('git', ['-C', worker.worktreePath, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const review = await missions.submitPacketReview({
    packetId: worker.packetId,
    approved: true,
    findings: [],
    reviewedHeadSha: head,
  });
  writeFileSync(process.env.O8_TEST_REVIEW_FILE, JSON.stringify({ review }));
`;

export const fakeCodexScript = `#!/usr/bin/env node
import { appendFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('codex-cli 0.145.0'); process.exit(0); }
if (args[0] === 'login' && args[1] === 'status') { console.log('Logged in'); process.exit(0); }
if (args.includes('--input-format')) process.exit(0);
appendFileSync(process.env.O8_TEST_LEAD_ARGS, JSON.stringify(args) + '\\n');
const prompt = args.at(-1) || '';
const resumeIndex = args.indexOf('resume');
const threadId = resumeIndex < 0 ? 'fixture-persistent-lead-thread' : args[resumeIndex + 1];
console.log(JSON.stringify({ type: 'thread.started', thread_id: threadId }));
if (process.env.O8_WORKER_PACKET_ID) {
  writeFileSync('lead-worker-proof.txt', 'worker returned to persistent lead\\n');
  const commit = spawnSync('git', [
    '-c', 'user.name=o8 test', '-c', 'user.email=test@o8.local',
    'add', 'lead-worker-proof.txt',
  ], { cwd: process.cwd(), encoding: 'utf8' });
  if (commit.status !== 0) { console.error(commit.stderr); process.exit(commit.status || 1); }
  const saved = spawnSync('git', [
    '-c', 'user.name=o8 test', '-c', 'user.email=test@o8.local',
    'commit', '-qm', 'test: add persistent lead proof',
  ], { cwd: process.cwd(), encoding: 'utf8' });
  if (saved.status !== 0) { console.error(saved.stderr); process.exit(saved.status || 1); }
}
if (prompt.includes('[fixture:dispatch-worker]')) {
  const turnThreadId = prompt.match(/orchestratorThreadId: "([^"]+)"/)?.[1];
  const turnId = prompt.match(/orchestratorTurnId: "([^"]+)"/)?.[1];
  const result = spawnSync(process.execPath, [
    '--import=./scripts/register-server-only-stub.mjs', '--import=tsx',
    '--input-type=module', '--eval', process.env.O8_TEST_DISPATCH_HELPER,
  ], {
    cwd: process.env.O8_TEST_SOURCE_ROOT,
    env: { ...process.env, O8_TEST_THREAD_ID: turnThreadId, O8_TEST_TURN_ID: turnId },
    encoding: 'utf8', timeout: 30000,
  });
  writeFileSync(process.env.O8_TEST_DISPATCH_DEBUG_FILE, JSON.stringify(result));
  if (result.status !== 0) {
    console.error(((result.stderr || '') + '\\n' + (result.stdout || '')).slice(-3000));
    process.exit(result.status || 1);
  }
}
if (prompt.includes('returned review')) {
  const packetId = prompt.match(/packet ([^)]+)\\)/)?.[1];
  const result = spawnSync(process.execPath, [
    '--import=./scripts/register-server-only-stub.mjs', '--import=tsx',
    '--input-type=module', '--eval', process.env.O8_TEST_REVIEW_HELPER,
  ], {
    cwd: process.env.O8_TEST_SOURCE_ROOT,
    env: { ...process.env, O8_TEST_PACKET_ID: packetId },
    encoding: 'utf8', timeout: 20000,
  });
  if (result.status !== 0) { console.error(result.stderr || result.stdout); process.exit(result.status || 1); }
}
if (prompt.includes('[fixture:hang]')) await new Promise((resolve) => setTimeout(resolve, 5000));
else if (prompt.includes('[fixture:slow-left-2541]') || prompt.includes('returned review')) await new Promise((resolve) => setTimeout(resolve, 350));
if (prompt.includes('[fixture:event-error]')) {
  console.log(JSON.stringify({ type: 'error', message: 'fixture orchestrator event failed' }));
  process.exit(0);
}
const report = prompt.match(/o8 lead report ([^ ]+) --turn ([^ ]+) --repo ([^ ]+) --thread-id ([^ ]+)/);
if (report && !prompt.includes('[fixture:no-outcome]')) {
  const kind = prompt.includes('[fixture:dispatch-worker]')
    ? 'waiting_workers'
    : prompt.includes('returned review') ? 'needs_approval' : 'completed';
  const reported = spawnSync(process.execPath, [
    process.env.O8_TEST_SOURCE_ROOT + '/cli/dist/o8.mjs',
    'lead', 'report', report[1], '--turn', report[2], '--repo', JSON.parse(report[3]),
    '--thread-id', report[4], '--kind', kind, '--summary', 'fixture structured outcome',
    '--evidence', kind === 'completed' ? '["fixture provider receipt"]' : '[]',
  ], { env: process.env, encoding: 'utf8' });
  if (reported.status !== 0) { console.error(reported.stderr || reported.stdout); process.exit(reported.status || 1); }
}
console.log(JSON.stringify({ type: 'item.completed', item: { id: 'reply', type: 'agent_message', text: 'offline lead reply' } }));
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }));
`;
