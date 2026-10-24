import { childEnvironment } from '@/lib/providers/spawn-environment';
import { spawn, type ChildProcess } from '@/lib/providers/child-process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';
import { providerSpawnEnvironment } from '@/lib/providers/spawn-environment';
import { credentialPolicyFingerprint } from '@/lib/providers/credential-policy';
import { OPENCLAW_PROFILE } from './openclaw-profile';
/** The lazily-spawned o8-profile openclaw gateway — reused across turns. */
let gatewayProc: ChildProcess | null = null;
let gatewayPolicy: string | null = null;

/** Resolve true when a TCP client can connect to `port` on loopback. */
function canConnect(port: number): Promise<boolean> {
  return new Promise((resolveConnect) => {
    const socket = createConnection({ port, host: '127.0.0.1' });
    const finish = (ok: boolean) => { socket.destroy(); resolveConnect(ok); };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(1_000, () => finish(false));
  });
}

/** Poll until the gateway accepts connections, or throw after `timeoutMs`. */
async function waitForGatewayReady(proc: ChildProcess, port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (gatewayProc !== proc) {
      throw new Error('openclaw gateway exited or failed to spawn before becoming ready');
    }
    if (await canConnect(port)) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`openclaw gateway did not come up on port ${port} within ${timeoutMs}ms`);
}

/**
 * Ensure the o8-profile openclaw gateway is running on `port`.
 *
 * `openclaw agent` (without `--local`) connects to a gateway — it does NOT
 * auto-start one. So o8 lazy-spawns the gateway on first openclaw use and
 * reuses it across turns. If something is already listening on `port` (a prior
 * o8 run's gateway), that is reused as-is. The gateway runs the operator's real
 * codex-harness agents — the embedded `--local` harness cannot.
 */
export async function ensureOpenclawGateway(port: number, openclawBin: string): Promise<void> {
  const policy = credentialPolicyFingerprint('openclaw');
  const policyFile = join(getDataDir(), 'openclaw-gateway-policy');
  const previous = existsSync(policyFile) ? readFileSync(policyFile, 'utf8') : '';
  if (gatewayPolicy !== policy && gatewayProc && !gatewayProc.killed) {
    const stale = gatewayProc; stale.kill('SIGTERM');
    await new Promise<void>(resolve => { const timer = setTimeout(resolve, 2_000); stale.once('close', () => { clearTimeout(timer); resolve(); }); });
  }
  if (gatewayProc && gatewayProc.exitCode === null && !gatewayProc.killed) {
    return; // Our gateway child is alive.
  }
  if (await canConnect(port)) {
    if (previous !== policy) throw new Error('OpenClaw gateway credentials changed. Stop the existing o8-profile gateway before retrying.');
    return;
  }

  console.log(`[openclaw-gateway] Starting o8-profile gateway on port ${port}`);
  const proc = spawn(
    openclawBin,
    ['--profile', OPENCLAW_PROFILE, 'gateway', 'run', '--port', String(port)],
    { windowsHide: true,
      env: providerSpawnEnvironment(childEnvironment({ runtimeId: 'openclaw', env: { FORCE_COLOR: '0', NO_COLOR: '1' } }), { runtimeId: 'openclaw' }),
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  gatewayProc = proc; gatewayPolicy = policy;
  proc.stdout?.on('data', (chunk: Buffer) => {
    const line = chunk.toString('utf-8').trimEnd();
    if (line) console.log(`[openclaw-gateway] ${line}`);
  });
  proc.stderr?.on('data', (chunk: Buffer) => {
    const line = chunk.toString('utf-8').trimEnd();
    if (line) console.log(`[openclaw-gateway] ${line}`);
  });
  proc.on('error', (err) => {
    console.error(`[openclaw-gateway] spawn error: ${err.message}`);
    if (gatewayProc === proc) gatewayProc = null;
  });
  proc.on('exit', (code) => {
    console.log(`[openclaw-gateway] exited (code ${code})`);
    if (gatewayProc === proc) gatewayProc = null;
  });

  await waitForGatewayReady(proc, port, 20_000);
  mkdirSync(getDataDir(), { recursive: true, mode: 0o700 });
  if (credentialPolicyFingerprint('openclaw') !== policy) {
    proc.kill('SIGTERM');
    throw new Error('OpenClaw credentials changed during gateway startup. Retry with the current billing mode.');
  }
  writeFileSync(policyFile, policy, { mode: 0o600 });
  console.log(`[openclaw-gateway] ready on port ${port}`);
}
