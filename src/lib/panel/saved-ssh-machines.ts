import { execFile } from 'node:child_process';
import { readFileSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { getDataDir } from '@/lib/data-dir-migration';

const execFileAsync = promisify(execFile);

export interface SavedSshMachine {
  id: string;
  label: string;
  target: string;
  port: number;
  remoteCli: string;
  sshConfig: string | null;
  enabled: boolean;
}

export interface RemoteTerminalSession {
  id: string;
  cols?: number;
  rows?: number;
}

export class SavedMachineError extends Error {
  constructor(public readonly code: string, message: string, public readonly status: number) {
    super(message);
  }
}

function validMachine(value: unknown): value is SavedSshMachine {
  if (!value || typeof value !== 'object') return false;
  const machine = value as Partial<SavedSshMachine>;
  return typeof machine.id === 'string' && /^[0-9a-f-]{36}$/.test(machine.id)
    && typeof machine.label === 'string' && machine.label.length > 0 && machine.label.length <= 64
    && typeof machine.target === 'string' && /^(?:[A-Za-z0-9_.-]+@)?[A-Za-z0-9_.-]+$/.test(machine.target)
    && !machine.target.startsWith('-')
    && Number.isSafeInteger(machine.port) && Number(machine.port) >= 1 && Number(machine.port) <= 65_535
    && typeof machine.remoteCli === 'string'
    && (machine.remoteCli === 'o8' || (machine.remoteCli.startsWith('/') && !/[\r\n\0]/.test(machine.remoteCli)))
    && (machine.sshConfig === null || (typeof machine.sshConfig === 'string'
      && machine.sshConfig.startsWith('/') && !/[\r\n\0]/.test(machine.sshConfig)))
    && typeof machine.enabled === 'boolean';
}

export function listSavedSshMachines(dataDir = getDataDir()): SavedSshMachine[] {
  const path = join(dataDir, 'ssh-machines.json');
  let source: string;
  try {
    if (!lstatSync(path).isFile()) throw new Error('not a regular file');
    source = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new SavedMachineError('machine_catalog_invalid', 'Saved machines are unreadable.', 409);
  }
  try {
    const catalog = JSON.parse(source) as { schema?: unknown; machines?: unknown };
    if (catalog.schema !== 'o8/cli/machines/v1' || !Array.isArray(catalog.machines)
      || !catalog.machines.every(validMachine)) throw new Error('invalid catalog');
    const keys = catalog.machines.flatMap((machine: SavedSshMachine) => [machine.id, machine.label]);
    if (new Set(keys).size !== keys.length) throw new Error('duplicate machine identifiers');
    return catalog.machines;
  } catch {
    throw new SavedMachineError('machine_catalog_invalid', 'Saved machines are unreadable or invalid.', 409);
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function remoteControlCommand(machineId: string, sessionId: string, cwd = process.cwd()): string {
  const sourceCli = join(cwd, 'cli', 'dist', 'o8.mjs');
  const bundledCli = join(cwd, 'bin', 'o8');
  let launcher: string;
  try {
    if (lstatSync(sourceCli).isFile()) launcher = `${shellQuote(process.execPath)} ${shellQuote(sourceCli)}`;
    else throw new Error('missing source CLI');
  } catch {
    try {
      if (!lstatSync(bundledCli).isFile()) throw new Error('missing bundled CLI');
      launcher = shellQuote(bundledCli);
    } catch {
      throw new SavedMachineError('cli_unavailable', 'Build or install the current o8 CLI to open a remote terminal.', 409);
    }
  }
  return `exec ${launcher} --human terminal control ${shellQuote(sessionId)} --machine ${shellQuote(machineId)}`;
}

export async function listRemoteTerminalSessions(machine: SavedSshMachine): Promise<RemoteTerminalSession[]> {
  if (!machine.enabled) throw new SavedMachineError('machine_disabled', 'This machine is disabled.', 409);
  const remoteCommand = [machine.remoteCli, 'terminal', 'list'].map(shellQuote).join(' ');
  const args = [
    '-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
    '-o', 'ConnectTimeout=8', '-o', 'NumberOfPasswordPrompts=0',
    ...(machine.sshConfig ? ['-F', machine.sshConfig] : []),
    '-p', String(machine.port), '--', machine.target, remoteCommand,
  ];
  let output: string;
  try {
    ({ stdout: output } = await execFileAsync('ssh', args, {
      timeout: 15_000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8',
    }));
  } catch (error) {
    const stderr = String((error as { stderr?: unknown }).stderr ?? '').trim().slice(0, 400);
    throw new SavedMachineError('machine_unreachable', stderr || 'Could not reach this machine. Check SSH access and its host key.', 502);
  }
  try {
    const payload = JSON.parse(output) as { schema?: unknown; sessions?: unknown };
    if (payload.schema !== 'o8/cli/terminal.list/v1' || !Array.isArray(payload.sessions)
      || !payload.sessions.every((session) => session && typeof session === 'object'
        && typeof session.id === 'string' && session.id.length > 0 && session.id.length <= 256)) {
      throw new Error('invalid sessions');
    }
    return payload.sessions as RemoteTerminalSession[];
  } catch {
    throw new SavedMachineError('machine_not_ready', 'Remote o8 did not return a terminal inventory.', 409);
  }
}
