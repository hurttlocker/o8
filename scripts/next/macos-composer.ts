/** Three release-only macOS runs. Owns every server, repository and data file. */
import { strict as assert } from 'node:assert';
import { createHash, randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import type { SpawnSyncReturns } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

async function main() {
  assert.equal(process.platform, 'darwin', 'macOS measurements only');
  const binary = process.env.O8_NEXT_BINARY;
  assert.ok(binary, 'Set O8_NEXT_BINARY to this checkout\'s release binary');
  const results = resolve('native/o8-next/evidence/macos-composer');
  mkdirSync(results, { recursive: true });
  for (let run = 1; run <= 3; run++) {
    const scratch = mkdtempSync(join(tmpdir(), 'o8-next-macos-measure-'));
    const requests = join(scratch, 'requests.json');
    const sentinel = join(scratch, 'must-not-open.db');
    const token = randomBytes(32).toString('hex');
    const server = spawn(process.execPath, ['--import', './scripts/register-server-only-stub.mjs', '--import', 'tsx',
      'scripts/next/dev-server.ts', '--composer'], {
      stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, O8_NEXT_API_TOKEN: token,
        CORTEX_IDE_DB_PATH: sentinel, O8_NEXT_REQUEST_LOG: requests, TZ: 'UTC' },
    });
    let errors = '';
    server.stderr.on('data', chunk => { errors += String(chunk); });
    const lines = createInterface({ input: server.stdout });
    const timeout = setTimeout(() => server.kill('SIGTERM'), 30_000);
    let completed = false;
    try {
      const origin = await new Promise<string>((resolveOrigin, reject) => {
        lines.on('line', line => {
          try {
            const value = JSON.parse(line) as { origin?: string };
            if (value.origin) resolveOrigin(value.origin);
          } catch { /* Production handler diagnostics are not origin records. */ }
        });
        server.once('exit', () => reject(new Error(`Fixture host exited: ${errors.slice(-1000)}`)));
        server.once('error', reject);
      });
      assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/);
      const output = join(results, `run-${run}.json`);
      for (const flags of [[], ['--offscreen', '--unattended-on-screen']]) {
        const rejected: SpawnSyncReturns<string> = spawnSync(binary, ['--enable-next', '--server', origin, '--composer-benchmark', output, ...flags], {
          encoding: 'utf8', timeout: 3000,
        });
        assert.equal(rejected.status, 1, 'unsafe or mixed benchmark modes must fail before opening a window');
        assert.match(rejected.stderr, /require --offscreen|alone with --offscreen/);
      }
      const child: SpawnSyncReturns<string> = spawnSync(binary, ['--enable-next', '--server', origin, '--offscreen', '--composer-benchmark', output], {
        encoding: 'utf8', timeout: 9000, env: { ...process.env, O8_NEXT_API_TOKEN: token },
      });
      assert.equal(child.status, 0, `${child.error?.message ?? ''}\n${child.stderr}`);
      const receipt = JSON.parse(readFileSync(output, 'utf8'));
      assert.equal(receipt.platform, 'macos');
      assert.equal(receipt.release, true);
      assert.equal(receipt.offscreen, true);
      assert.equal(receipt.windowRemainedInactive, true);
      assert.equal(receipt.keyToFrameMs.length, 20);
      assert.equal(receipt.sidebarSwitchToFirstFrameMs.length, 10);
      assert.equal(receipt.inputAcknowledged, 20);
      assert.equal(receipt.unchangedRowRelayouts, 0);
      for (const key of ['composerPaintAcknowledged', 'persistedEchoPaintAcknowledged', 'sessionContentPaintAcknowledged']) {
        assert.equal(receipt[key], true);
      }
      receipt.binarySha256 = createHash('sha256').update(readFileSync(binary)).digest('hex');
      writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`);
      console.log(`[o8-next] macOS release run ${run}: composer, session content and persisted echo painted`);
      completed = true;
    } finally {
      clearTimeout(timeout);
      lines.close();
      if (server.exitCode === null && server.signalCode === null) {
        const exited = once(server, 'exit');
        server.kill('SIGTERM');
        await exited;
      }
      assert.equal(existsSync(sentinel), false, 'inherited database path must stay untouched');
      if (completed) {
        const calls = JSON.parse(readFileSync(requests, 'utf8')) as string[];
        assert.ok(calls.includes('POST /api/orchestrator/composer-queue'));
        assert.ok(calls.every(call => ['GET /api/mobile/orchestrator/threads', 'GET /api/mobile/history',
          'GET /api/panel/ws-info', 'WS /ws', 'WS realtime-subscribe', 'WS ping', 'GET /api/v2/chat-history',
          'GET /api/orchestrator/state', 'GET /api/orchestrator/composer-queue', 'POST /api/orchestrator/composer-queue'].includes(call)));
      }
      rmSync(scratch, { recursive: true, force: true });
    }
  }
}
void main().catch(error => { console.error('[o8-next]', error); process.exitCode = 1; });
