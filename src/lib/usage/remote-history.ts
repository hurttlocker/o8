import 'server-only';
import { spawn } from 'node:child_process';
import type { SavedSshMachine } from '@/lib/panel/saved-ssh-machines';
import { readHistoryPricing } from './history-pricing';
import { REMOTE_USAGE_PROBE } from './remote-probe.generated';
import { savedMachineSshArgs } from './remote-node-command';
import { validateRemoteHistory } from './remote-history-validation';

/** Only aggregate usage metadata crosses SSH; saved targets and strict host key checks own the transport. */
export async function readRemoteUsageHistory(machine: SavedSshMachine, input: { days: 1 | 7 | 30 | 90; timeZone: string; fresh?: boolean }) {
  if (!machine.enabled) throw new Error('Machine is disabled.');
  const pricing = await readHistoryPricing(input.fresh);
  const parameters = JSON.stringify({ days: input.days, timeZone: input.timeZone, rates: [...pricing.table], pricing: pricing.meta });
  const program = REMOTE_USAGE_PROBE + '\no8UsageProbe.collectRemoteUsage(' + parameters + ')'
    + '.then(value => process.stdout.write(JSON.stringify(value))).catch(() => { process.stderr.write("Usage stores could not be read."); process.exitCode = 1; });\n';
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn('ssh', savedMachineSshArgs(machine), { stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks: Buffer[] = []; let bytes = 0; let settled = false;
    const finish = (error?: Error) => {
      if (settled) return; settled = true; clearTimeout(timer);
      if (error) { child.kill('SIGTERM'); reject(error); } else resolve(Buffer.concat(chunks).toString('utf8'));
    };
    const timer = setTimeout(() => finish(new Error('Machine usage timed out.')), 180_000);
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length; if (bytes > 8 * 1024 * 1024) finish(new Error('Machine usage response was too large.'));
      else chunks.push(chunk);
    });
    // Do not expose remote paths, shell output or credentials as HTTP errors.
    child.stderr.on('data', () => {});
    child.stdin.on('error', () => finish(new Error('Could not send the usage collector.')));
    child.on('error', () => finish(new Error('Could not reach this machine.')));
    child.on('close', code => finish(code === 0 ? undefined : new Error('Could not read usage on this machine. Check SSH access and Node 22.')));
    child.stdin.end(program);
  });
  return validateRemoteHistory(JSON.parse(output), input, pricing.meta);
}
