import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { piWriteHelperPath } from '@/lib/pi/sdk/scripts';

export class AcpPreparationHeld extends Error {}

/** The bundled native supervisor tracks descendants and ends them when its parent disappears. */
export async function runRegistryInstaller(command: string, args: string[], options: {
  cwd: string; env: NodeJS.ProcessEnv; timeoutMs?: number; supervisor?: string;
}): Promise<void> {
  if (process.platform === 'win32') throw new Error('Use local setup for this agent on Windows.');
  const supervisor = options.supervisor ?? piWriteHelperPath();
  const child = spawn(supervisor, ['supervise', String(process.pid), command, ...args], {
    cwd: options.cwd, env: options.env, detached: true, stdio: ['ignore', 'pipe', 'pipe', 'pipe'] });
  let ended = false;
  const exited = new Promise<{ code: number | null; error?: boolean }>(resolve => {
    child.once('exit', code => { ended = true; resolve({ code }); });
    child.once('error', () => { ended = true; resolve({ code: null, error: true }); });
  });
  let receipt = ''; let outputBytes = 0; let stopped = false;
  let release!: () => void;
  const stop = new Promise<void>(resolve => { release = resolve; });
  const requestStop = () => { stopped = true; release(); };
  for (const stream of [child.stdout, child.stderr]) stream?.on('data', (chunk: Buffer) => { outputBytes += chunk.length; if (outputBytes > 256 * 1024) requestStop(); });
  const proof = child.stdio[3] as NodeJS.ReadableStream | null;
  const proofRead = new Promise<void>(resolve => {
    if (!proof) return resolve();
    proof.on('data', (chunk: Buffer) => { if (receipt.length < 4096) receipt += chunk.toString('utf8'); });
    proof.once('end', resolve); proof.once('error', resolve);
  });
  const timer = setTimeout(requestStop, options.timeoutMs ?? 120_000);
  try {
    const result = await Promise.race([exited, stop.then(async () => {
      if (!ended && child.pid) { try { process.kill(child.pid, 'SIGTERM'); } catch { /* Exit can race Stop. */ } }
      const result = await Promise.race([exited, sleep(10_000).then(() => null)]);
      if (!result) {
        if (child.pid) for (const pid of [-child.pid, child.pid]) { try { process.kill(pid, 'SIGKILL'); } catch { /* Retain state unless native proof confirms teardown. */ } }
        throw new AcpPreparationHeld('Package preparation shutdown is unconfirmed. Restart o8 before retrying.');
      }
      return result;
    })]);
    if (result.error) throw new Error('The package supervisor could not start.');
    await Promise.race([proofRead, sleep(1_000)]);
    let confirmed = false;
    try { confirmed = JSON.parse(receipt.trim().split('\n').at(-1) ?? '').confirmed === true; } catch { /* Missing proof holds the owned stage. */ }
    if (!confirmed) throw new AcpPreparationHeld('Package preparation shutdown is unconfirmed. Restart o8 before retrying.');
    if (stopped || result.code !== 0) throw new Error('The package could not be prepared. Check Node.js and your network, then retry.');
  } finally { clearTimeout(timer); child.stdout?.destroy(); child.stderr?.destroy(); }
}
