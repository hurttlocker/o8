import fs from 'node:fs';
import path from 'node:path';
import { historiesFor } from './ui.mjs';
import { writeJson } from './common.mjs';

// Provider output is a bounded fixture. These completed records never claim a
// live process and never invoke a provider. The real owned-log parser, HTTP
// history endpoint, WS bridge and WebKit renderer consume the persisted logs.
export function nativeFixture(seeded) {
  const histories = historiesFor(seeded.keys);
  const now = new Date().toISOString();
  const records = seeded.keys.map((key, i) => {
    const sessionDir = path.join(seeded.dataDir, 'owned-codex', `speed-fixture-${i}`);
    fs.mkdirSync(path.join(sessionDir, 'runs'), { recursive: true, mode: 0o700 });
    const stdoutPath = path.join(sessionDir, 'runs/fixture.stdout.jsonl');
    const stderrPath = path.join(sessionDir, 'runs/fixture.stderr.log');
    fs.writeFileSync(stderrPath, '', { mode: 0o600 });
    const record = { surfaceId: key, sessionDir, cwd: seeded.repoDir, repoPath: seeded.repoDir,
      branch: 'main', title: `Speed session ${i}`, createdAt: now, updatedAt: now,
      latestPrompt: 'Synthetic speed fixture', latestSummary: 'Synthetic speed fixture', model: 'gpt-6.1-sol', effort: 'medium', runtimeConfig: {},
      threadId: `speed-fixture-${i}`, reviewDisposition: 'watching',
      recentRuns: [{ id: `speed-run-${i}`, mode: 'launch', prompt: 'Synthetic transcript fixture', startedAt: now, finishedAt: now,
        pid: 0, spawnState: 'reconciled_clear', stdoutPath, stderrPath, outcome: 'finished' }] };
    writeJson(path.join(sessionDir, 'session.json'), record);
    return { record, stdoutPath };
  });
  let tick = 0;
  const advance = () => {
    tick++;
    for (const [i, entry] of records.entries()) {
      const lines = histories[i].map((message, index) => ({ type: 'item.completed', timestamp: now,
        item: { id: `speed-msg-${index}`, type: 'agent_message', text: message.text + (index === histories[i].length - 1 ? `\nNative streaming sample ${tick}.` : '') } }));
      const temporary = entry.stdoutPath + '.speed-tmp';
      fs.writeFileSync(temporary, [JSON.stringify({ type: 'thread.started', thread_id: entry.record.threadId }), ...lines.map(row => JSON.stringify(row)), JSON.stringify({ type: 'turn.completed' })].join('\n') + '\n', { mode: 0o600 });
      fs.renameSync(temporary, entry.stdoutPath);
      // A stream is activity. Without this heartbeat the real orphan sweep
      // correctly retires our completed fixture after its idle grace period.
      entry.record.updatedAt = new Date().toISOString();
      const metadata = path.join(entry.record.sessionDir, 'session.json');
      writeJson(metadata + '.speed-tmp', entry.record);
      fs.renameSync(metadata + '.speed-tmp', metadata);
    }
  };
  advance();
  return { advance, get tick() { return tick; } };
}
export async function refreshNativeHistory(wsPort, token, keys, includeGlobal = false) {
  const response = await fetch(`http://127.0.0.1:${wsPort}/internal/realtime`, { method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'refresh', targets: includeGlobal ? ['global', 'sessionHistory'] : ['sessionHistory'], sessionKeys: keys, fresh: true }), signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`Owned native fixture refresh failed: ${response.status}`);
  await response.arrayBuffer();
}
