import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { strict as assert } from 'node:assert';
import type { MobileHistoryResponse } from '@/lib/mobile/types';
import { webTree } from './web-tree';

async function main() {
  const binary = process.env.O8_NEXT_BINARY;
  if (!binary) throw new Error('Set O8_NEXT_BINARY to the release binary built from this checkout');
  const directory = mkdtempSync(join(tmpdir(), 'o8-next-verify-'));
  const requests = join(directory, 'requests.json');
  const server = spawn(process.execPath, ['--import', './scripts/register-server-only-stub.mjs', '--import', 'tsx', 'scripts/next/dev-server.ts'], {
    stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TZ: 'UTC', CORTEX_IDE_DB_PATH: join(directory, 'must-not-open.db'), O8_NEXT_REQUEST_LOG: requests, WS_TOKEN: 'fixture-inherited-token-must-not-reuse' },
  });
  let errors = '';
  server.stderr.on('data', chunk => { errors += String(chunk); });
  const timeout = setTimeout(() => { server.kill('SIGTERM'); }, 90_000);
  const lines = createInterface({ input: server.stdout });
  try {
    const origin = await new Promise<string>((resolveOrigin, reject) => {
      lines.on('line', line => { try { const value = JSON.parse(line) as { origin?: string }; if (value.origin) resolveOrigin(value.origin); } catch {} });
      server.once('exit', () => reject(new Error(`Disposable route host exited: ${errors.slice(-1000)}`)));
    });
    const wsInfo = await (await fetch(`${origin}/api/panel/ws-info`)).json() as { wsPort: number; wsToken: string };
    assert.notEqual(wsInfo.wsToken, 'fixture-inherited-token-must-not-reuse', 'fixture host must replace inherited credentials');
    assert.match(wsInfo.wsToken, /^[a-f0-9]{64}$/);
    assert.equal(wsInfo.wsPort, Number(new URL(origin).port));
    for (const args of [
      ['--server', origin, '--offscreen'],
      ['--enable-next', '--server', 'http://192.0.2.1:31000', '--offscreen'],
      ['--enable-next', '--server', `${origin}/wrong`, '--offscreen'],
    ]) {
      assert.equal(spawnSync(binary, args, { encoding: 'utf8', timeout: 8000 }).status, 1);
    }
    const invalid = join(directory, 'invalid.json'); writeFileSync(invalid, '{');
    assert.equal(spawnSync(binary, ['--render-tree', invalid], { encoding: 'utf8', timeout: 8000 }).status, 1);
    // Every native network request goes to this freshly bound owned server.
    const list = await (await fetch(`${origin}/api/mobile/orchestrator/threads?limit=500`)).json() as { threads: Array<{ id: string; messageCount: number }> };
    assert.equal(list.threads.length, 3);
    for (const session of list.threads) {
      const name = session.id.replace('thoughts-', '');
      const response = await fetch(`${origin}/api/mobile/history?sessionKey=${encodeURIComponent(`llm-chat:${session.id}`)}&limit=100`);
      assert.equal(response.status, 200);
      const history = await response.json() as MobileHistoryResponse;
      const recorded = resolve(`native/o8-next/fixtures/${name}.history.json`);
      const treePath = resolve(`native/o8-next/fixtures/${name}.tree.json`);
      const actualPath = join(directory, 'response.json');
      writeFileSync(actualPath, JSON.stringify(history));
      const expected = webTree(history.transcript);
      if (process.argv.includes('--record')) {
        writeFileSync(recorded, `${JSON.stringify(history, null, 2)}\n`);
        writeFileSync(treePath, `${JSON.stringify(expected, null, 2)}\n`);
      } else {
        assert.deepEqual(history, JSON.parse(readFileSync(recorded, 'utf8')));
        assert.deepEqual(expected, JSON.parse(readFileSync(treePath, 'utf8')));
      }
      const native = JSON.parse(execFileSync(binary, ['--render-tree', actualPath], { encoding: 'utf8', timeout: 8000 }));
      assert.deepEqual(native, expected, `${name}: native tree must match production web tree`);
      console.log('[o8-next]', `${name}: ${history.transcript.length} API messages, ${expected.length} parity rows`);
    }
    // Actual CLI dispatcher -> actual native executable, without showing a window.
    const result = join(directory, 'frame.json');
    const cli = ['cli/dist/o8.mjs', 'next', '--enable-next', '--binary', binary, '--server', origin, '--offscreen', '--benchmark', result];
    execFileSync(process.execPath, cli, { encoding: 'utf8', timeout: 9000 });
    const frame = JSON.parse(readFileSync(result, 'utf8'));
    assert.equal(frame.sessions, 3); assert.equal(frame.offscreen, true);
    assert.equal(frame.keyToFrameMs.length, 20); assert.equal(frame.scrollFrameMs.length, 50);
    assert.ok(frame.rows > 0); assert.ok(frame.paintedRows > 0);
    console.log('[o8-next]', 'CLI -> native -> disposable HTTP routes -> GPUI paint: passed');
    if (process.env.O8_NEXT_STREAM_RESULTS) {
      const replay = JSON.parse(readFileSync('native/o8-next/fixtures/stream.replay.json', 'utf8')) as { lastSeq: number };
      const expected = JSON.parse(readFileSync('native/o8-next/fixtures/stream.tree.json', 'utf8'));
      for (let run = 1; run <= 3; run++) {
        const output = join(directory, `stream-${run}.json`);
        const args = ['--enable-next', '--server', origin, '--offscreen', '--stream-benchmark', output, '--stream-through', String(replay.lastSeq)];
        if (run === 1) execFileSync(process.execPath, ['cli/dist/o8.mjs', 'next', '--binary', binary, ...args], { encoding: 'utf8', timeout: 9000 });
        else execFileSync(binary, args, { encoding: 'utf8', timeout: 9000 });
        const bytes = readFileSync(output, 'utf8'); const receipt = JSON.parse(bytes);
        assert.equal(receipt.lastSeq, replay.lastSeq); assert.equal(receipt.offscreen, true);
        assert.equal(receipt.keyToFrameWhileStreamingMs.length, 20);
        assert.ok(receipt.streamFrameMs.length >= 40);
        assert.equal(receipt.unchangedRowRelayouts, 0);
        assert.equal(receipt.streamTailPaintAcknowledged, true);
        assert.deepEqual(receipt.finalTree, expected, 'live network replay must reach actual web-provider final tree');
        writeFileSync(resolve(process.env.O8_NEXT_STREAM_RESULTS, `run-${run}.json`), bytes);
        console.log('[o8-next]', `stream ${run}: final web/native parity, ${receipt.streamFrameMs.length} scenes, zero unchanged-row layouts`);
      }
    }
    if (process.env.O8_NEXT_RESULTS) {
      for (let run = 1; run <= 3; run++) {
        const output = join(directory, `run-${run}.json`);
        execFileSync(binary, ['--enable-next', '--server', origin, '--offscreen', '--benchmark', output], { encoding: 'utf8', timeout: 9000 });
        const bytes = readFileSync(output, 'utf8');
        const receipt = JSON.parse(bytes);
        assert.equal(receipt.keyToFrameMs.length, 20);
        assert.equal(receipt.scrollFrameMs.length, 50);
        assert.ok(receipt.paintedRows > 0);
        writeFileSync(resolve(process.env.O8_NEXT_RESULTS, `run-${run}.json`), bytes);
      }
    }
  } finally {
    clearTimeout(timeout); lines.close();
    if (server.exitCode === null && server.signalCode === null) { const exited = once(server, 'exit'); server.kill('SIGTERM'); await exited; }
    assert.equal(existsSync(join(directory, 'must-not-open.db')), false, 'inherited database override must never be opened');
    const calls = JSON.parse(readFileSync(requests, 'utf8')) as string[];
    assert.ok(calls.length > 0);
    assert.ok(calls.every(call => ['GET /api/mobile/orchestrator/threads', 'GET /api/mobile/history', 'GET /api/panel/ws-info', 'WS /ws', 'WS realtime-subscribe', 'WS ping'].includes(call)));
    console.log('[o8-next]', `${calls.length} requests; only existing GET/WebSocket contracts used`);
    rmSync(directory, { recursive: true, force: true });
  }

}
void main().catch(error => { console.error('[o8-next]', error); process.exitCode = 1; });
