import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { CliError, EXIT, apiFetch } from '../api.js';
import { parseSettlementBinding } from '../../../src/lib/runtimes/managed-runs/settlement-contract.js';
export { settlementBindingDigest } from '../../../src/lib/runtimes/managed-runs/settlement-contract.js';
import type { resolveConfig } from '../config.js';

/** Host-only reservation input; never forward the file path into a worker. */
export function loadRunSettlementBinding() {
  const file = process.env.O8_MANAGED_RUN_SETTLEMENT_BINDING;
  if (!file) return null;
  if (process.env.O8_WORKER_TOKEN) throw new CliError('operator_settlement_required', 'Settlement reservations require an operator.', EXIT.CONFLICT);
  try {
    if (statSync(file).size > 8192) throw new Error('oversize');
    const binding = parseSettlementBinding(JSON.parse(readFileSync(file, 'utf8')));
    if (!binding) throw new Error('invalid');
    return { binding, id: createHash('sha256').update(JSON.stringify([binding.executionKey, binding.generation])).digest('hex').slice(0, 32) };
  } catch {
    throw new CliError('invalid_settlement_binding', 'The host settlement binding is missing or invalid.', EXIT.INVALID_ARGS);
  }
}

export async function registerRunWithReplay(config: ReturnType<typeof resolveConfig>, body: unknown, retry = false) {
  // A lost response must not launch a second command or erase its first receipt.
  for (let attempt = 0; ; attempt += 1) {
    try { return await apiFetch<{ ok?: boolean; run?: { id: string; status: string; settlement?: {
      bindingDigest: string; stopRequestId: string | null; wrapperFinished: boolean; receipt: { state: string } | null;
    } } }>(config, '/api/panel/managed-runs', { method: 'POST', body }); }
    catch (error) {
      if (!retry || attempt === 1 || (error instanceof CliError
        && error.exit !== EXIT.CONNECTION_REFUSED && error.exit !== EXIT.SERVER_TIMEOUT)) throw error;
    }
  }
}

export function extractRunCommand(): { detach: boolean; list: boolean; last: boolean; command: string[] } {
  const leading = new Set(['--detach', '--list', '--last', '--human', '--json', '--verbose', '-v', '--help', '-h']);
  const argv = process.argv.slice(2);
  const runIdx = argv.indexOf('run');
  const after = runIdx >= 0 ? argv.slice(runIdx + 1) : [];
  const dashIdx = after.indexOf('--');
  let flags: string[];
  let command: string[];
  if (dashIdx >= 0) { flags = after.slice(0, dashIdx); command = after.slice(dashIdx + 1); }
  else {
    flags = [];
    let i = 0;
    while (i < after.length && after[i].startsWith('-') && leading.has(after[i])) { flags.push(after[i]); i += 1; }
    command = after.slice(i);
  }
  return { detach: flags.includes('--detach'), list: flags.includes('--list'), last: flags.includes('--last'), command };
}
