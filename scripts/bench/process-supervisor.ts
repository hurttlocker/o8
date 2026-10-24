import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { OwnedSessionRecord } from '../../src/lib/runtimes/shared/owned-session/types';

// Run in a disposable Node server host at the same credential/admission spawn
// entry used by owned Codex. Only the provider executable is a fixture.
async function main() {
  const binary = process.env.O8D_TEST_BINARY;
  if (process.platform !== 'linux' || !binary) throw new Error('Requires Linux and O8D_TEST_BINARY');
  const root = mkdtempSync(join(tmpdir(), 'o8-supervisor-bench-'));
  const socket = join(root, 'control.sock');
  const credential = 'fixture-supervisor-benchmark-authentication';
  Object.assign(process.env, { NODE_ENV: 'test', O8_DATA_DIR: root, CORTEX_IDE_DATA_DIR: root,
    O8D_SUPERVISOR_SOCKET: socket, O8_API_PORT: '0' });
  writeFileSync(join(root, 'ws-token'), credential, { mode: 0o600 });
  const daemon = spawn(binary, ['--experimental-supervisor', '--socket', socket, '--state-dir', root], {
    stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, O8D_SUPERVISOR_TOKEN: credential },
  });
  const ready = await Promise.race([once(daemon.stdout!, 'data').then(() => true), once(daemon, 'close').then(() => false)]);
  if (!ready) throw new Error('Supervisor startup failed');
  const { spawnCredentialCheckedChild, spawnCredentialCheckedSupervised } = await import('../../src/lib/runtimes/shared/owned-session/credential-spawn');
  const { credentialPolicyFingerprint } = await import('../../src/lib/providers/credential-policy');
  const { ownedSupervisorClient } = await import('../../src/lib/runtime/o8d-supervisor');
  const { closeDb } = await import('../../src/lib/db');
  let sequence = 0;
  async function sample(supervised: boolean, bytes: number) {
    const id = `bench-${++sequence}`;
    const stdoutPath = join(root, `${id}.out`);
    const stderrPath = join(root, `${id}.err`);
    const stdoutFd = openSync(stdoutPath, 'a', 0o600);
    const stderrFd = openSync(stderrPath, 'a', 0o600);
    const now = new Date().toISOString();
    const session: OwnedSessionRecord = { surfaceId: 'codex-owned:benchmark', sessionDir: root, cwd: root, repoPath: root,
      title: 'Fixture', createdAt: now, updatedAt: now, latestPrompt: '', latestSummary: '', recentRuns: [] };
    const input = { session, runtimeId: 'codex', policy: credentialPolicyFingerprint('codex'), runId: id,
      binary: process.execPath, args: ['-e', `process.stdout.write(Buffer.alloc(${bytes}, 120));`],
      env: { PATH: process.env.PATH ?? '', O8_OWNED_RUN_MARKER: id }, stdoutFd, stderrFd,
      materializationIdentity: null, stdoutPath, stderrPath };
    let firstOutputMs = 0;
    let exited = false;
    const utilization = performance.eventLoopUtilization();
    const start = performance.now();
    try {
      let reference: { id: string; owner: string; epoch: string; cursor: number } | undefined;
      if (supervised) {
        const receipt = await spawnCredentialCheckedSupervised(input);
        reference = { id, owner: session.surfaceId, epoch: receipt.epoch, cursor: 0 };
      } else {
        const child = spawnCredentialCheckedChild(input);
        child.once('error', () => { exited = true; });
        child.once('close', () => { exited = true; });
      }
      while (true) {
        if (!firstOutputMs && statSync(stdoutPath).size > 0) firstOutputMs = performance.now() - start;
        if (reference) {
          const state = await ownedSupervisorClient().attach(reference);
          reference.cursor = state.cursor;
          exited = state.state === 'exited';
        }
        if (exited) break;
        if (performance.now() - start > 10_000) throw new Error('Fixture worker timed out');
        await new Promise(resolve => setTimeout(resolve, 1));
      }
      // Both real consumers parse the durable artifact; supervisor reconciliation
      // additionally receives bounded replay JSON and its terminal receipt.
      if (readFileSync(stdoutPath).length !== bytes || !firstOutputMs) throw new Error('Fixture output incomplete');
      return { firstOutputMs, eventLoopMs: performance.eventLoopUtilization(utilization).active };
    } finally {
      closeSync(stdoutFd);
      closeSync(stderrFd);
    }
  }
  const distribution = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    return { p50: Number(sorted[Math.floor(sorted.length * 0.5)].toFixed(3)),
      p95: Number(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)].toFixed(3)) };
  };
  try {
    const rows = [];
    for (const bytes of [1, 1024 * 1024]) {
      const samples = { child: [] as Array<Awaited<ReturnType<typeof sample>>>, supervisor: [] as Array<Awaited<ReturnType<typeof sample>>> };
      for (let index = 0; index < 35; index++) {
        // Paired, alternating order; discard five warmups for each workload.
        for (const enabled of index % 2 ? [true, false] : [false, true]) {
          const result = await sample(enabled, bytes);
          if (index >= 5) samples[enabled ? 'supervisor' : 'child'].push(result);
        }
      }
      for (const [path, values] of Object.entries(samples)) rows.push({ path, bytes, samples: values.length,
        firstOutputMs: distribution(values.map(value => value.firstOutputMs)),
        eventLoopMs: distribution(values.map(value => value.eventLoopMs)) });
    }
    console.log(JSON.stringify({ node: process.versions.node, warmups: 5, rows }, null, 2));
  } finally {
    closeDb();
    const closed = once(daemon, 'close');
    daemon.kill('SIGTERM');
    await closed;
    rmSync(root, { recursive: true, force: true });
  }
}
void main().catch(error => {
  const code = error instanceof Error ? error.message.replace(/\/(?:home|Users)\/[^/\s]+/g, '<user-root>') : 'unknown error';
  console.error(`Process supervisor benchmark failed: ${code}`);
  process.exitCode = 1;
});
