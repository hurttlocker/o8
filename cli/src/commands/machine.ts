/** Local SSH targets for explicit, fail-closed terminal CLI routing. No credentials are stored. */
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CliError, EXIT } from '../api.js';
import { resolveCliDataDir, resolveConfig } from '../config.js';
import { printJson, type OutputMode } from '../output.js';

interface MachineProfile {
  id: string;
  label: string;
  target: string;
  port: number;
  remoteCli: string;
  sshConfig: string | null;
  enabled: boolean;
}

interface MachineCatalog {
  schema: 'o8/cli/machines/v1';
  machines: MachineProfile[];
}

const CATALOG_SCHEMA = 'o8/cli/machines/v1';
const MAX_OUTPUT = 4 * 1024 * 1024;

function catalogPath(): string {
  return join(resolveCliDataDir(), 'ssh-machines.json');
}

function readCatalog(): MachineCatalog {
  const path = catalogPath();
  if (!existsSync(path)) return { schema: CATALOG_SCHEMA, machines: [] };
  try {
    if (!lstatSync(path).isFile()) throw new Error('not a regular file');
    const catalog: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!catalog || typeof catalog !== 'object' || !('schema' in catalog)
      || catalog.schema !== CATALOG_SCHEMA || !('machines' in catalog)
      || !Array.isArray(catalog.machines) || !catalog.machines.every(isMachine)) {
      throw new Error('invalid catalog');
    }
    const keys = (catalog.machines as MachineProfile[]).flatMap((machine) => [machine.id, machine.label]);
    if (new Set(keys).size !== keys.length) throw new Error('duplicate machine identifiers');
    return catalog as MachineCatalog;
  } catch {
    throw new CliError('machine_catalog_invalid', 'Saved SSH machine catalog is unreadable or invalid.', EXIT.CONFLICT);
  }
}

function isMachine(value: unknown): value is MachineProfile {
  if (!value || typeof value !== 'object') return false;
  const profile = value as Partial<MachineProfile>;
  return typeof profile.id === 'string' && /^[0-9a-f-]{36}$/.test(profile.id)
    && typeof profile.label === 'string' && profile.label.length > 0 && profile.label.length <= 64
    && typeof profile.target === 'string' && /^(?:[A-Za-z0-9_.-]+@)?[A-Za-z0-9_.-]+$/.test(profile.target)
    && typeof profile.remoteCli === 'string'
    && (profile.remoteCli === 'o8' || (profile.remoteCli.startsWith('/') && !/[\r\n\0]/.test(profile.remoteCli)))
    && (profile.sshConfig === null || (typeof profile.sshConfig === 'string'
      && profile.sshConfig.startsWith('/') && !/[\r\n\0]/.test(profile.sshConfig)))
    && Number.isSafeInteger(profile.port) && Number(profile.port) >= 1
    && Number(profile.port) <= 65_535 && typeof profile.enabled === 'boolean';
}

function saveCatalog(catalog: MachineCatalog): void {
  const dir = resolveCliDataDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = catalogPath();
  if (existsSync(path) && !lstatSync(path).isFile()) {
    throw new CliError('machine_catalog_invalid', 'Saved SSH machine catalog is not a regular file.', EXIT.CONFLICT);
  }
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(catalog, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  renameSync(temporary, path);
}

async function withCatalogLock<T>(fn: () => Promise<T>): Promise<T> {
  const dir = resolveCliDataDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lock = join(dir, 'ssh-machines.lock');
  const deadline = Date.now() + 20_000;
  let fd: number;
  while (true) {
    try {
      fd = openSync(lock, 'wx', 0o600);
      writeFileSync(fd, String(process.pid));
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) {
        throw new CliError('machine_catalog_busy', 'Saved SSH machine catalog is locked. Check for a live owner before removing ssh-machines.lock.', EXIT.CONFLICT);
      }
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
  }
  try { return await fn(); }
  finally { closeSync(fd); rmSync(lock, { force: true }); }
}

function requireOperator(): void {
  const cfg = resolveConfig();
  let savedToken = '';
  try { savedToken = readFileSync(join(cfg.dataDir || resolveCliDataDir(), 'ws-token'), 'utf8').trim(); } catch {}
  const presented = Buffer.from(cfg.token ?? '');
  const expected = Buffer.from(savedToken);
  if (!cfg.token || !savedToken || presented.length !== expected.length
    || !timingSafeEqual(presented, expected)
    || cfg.source.token === 'worker' || cfg.source.token === 'spectator') {
    throw new CliError('operator_required', 'Saved SSH machines require the local operator credential.', EXIT.UNAUTHORIZED);
  }
}

function exactProfile(catalog: MachineCatalog, key: string): MachineProfile {
  const matches = catalog.machines.filter((profile) => profile.id === key || profile.label === key);
  if (matches.length !== 1) {
    throw new CliError('machine_not_found', `Saved SSH machine ${key} was not found.`, EXIT.NOT_FOUND);
  }
  return matches[0];
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function sshArgs(profile: MachineProfile, command: string[], interactive = false): string[] {
  return [
    interactive ? '-tt' : '-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
    '-o', 'ConnectTimeout=8', '-o', 'NumberOfPasswordPrompts=0',
    ...(profile.sshConfig ? ['-F', profile.sshConfig] : []),
    '-p', String(profile.port), '--', profile.target,
    command.map(shellQuote).join(' '),
  ];
}

function remoteCommand(profile: MachineProfile, sub: string, rest: string[], mode: OutputMode): string[] {
  return [profile.remoteCli, 'terminal', sub, ...rest,
    ...(sub === 'control' && mode.human ? ['--filter-probe-replies'] : []),
    ...(mode.human ? ['--human'] : [])];
}

async function sshRun(profile: MachineProfile, command: string[], stream = false, timeoutMs = 15_000, interactive = false): Promise<{ code: number; output: string; error: string }> {
  return new Promise((resolve, reject) => {
    // Let OpenSSH own the local PTY for human control. It propagates the
    // terminal size and SIGWINCH to the remote PTY; piping it through Node
    // would freeze remote full-screen programs at the CLI's fallback size.
    const child = spawn('ssh', sshArgs(profile, command, interactive), {
      stdio: interactive ? ['inherit', 'inherit', 'pipe'] : ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    let error = '';
    let settled = false;
    let timedOut = false;
    let overLimit = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      if (stream && !interactive && child.stdin) process.stdin.unpipe(child.stdin);
      if (timedOut) {
        reject(new CliError('machine_timeout', `SSH machine ${profile.label} did not respond in time.`, EXIT.CONNECTION_REFUSED));
      } else if (overLimit) {
        reject(new CliError('remote_output_too_large', 'Remote terminal response exceeded 4 MiB.', EXIT.CONFLICT));
      } else if (code === 255 || code === -1) {
        reject(new CliError('machine_unreachable', `SSH machine ${profile.label} is unavailable: ${error.trim().slice(0, 400) || 'connection failed'}`, EXIT.CONNECTION_REFUSED));
      } else {
        resolve({ code, output, error });
      }
    };
    const stop = () => { child.kill('SIGTERM'); finish(stream ? EXIT.OK : EXIT.CONNECTION_REFUSED); };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    child.on('error', () => finish(-1));
    child.on('close', (code) => finish(code ?? -1));
    child.stdin?.on('error', () => {}); // The remote process may close before local stdin reaches EOF.
    child.stderr.on('data', (chunk: Buffer) => {
      error += chunk.toString();
      if (error.length > 4_096) error = error.slice(0, 4_096);
    });
    child.stdout?.on('data', (chunk: Buffer) => {
      if (stream) process.stdout.write(chunk);
      else {
        output += chunk.toString();
        if (output.length > MAX_OUTPUT) { overLimit = true; child.kill('SIGTERM'); }
      }
    });
    if (stream) {
      if (!interactive && child.stdin) process.stdin.pipe(child.stdin);
    } else child.stdin?.end();
    if (!stream) timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, timeoutMs);
  });
}

function assertTerminalInventory(output: string): void {
  try {
    const payload: unknown = JSON.parse(output);
    if (payload && typeof payload === 'object' && 'schema' in payload
      && payload.schema === 'o8/cli/terminal.list/v1' && 'sessions' in payload
      && Array.isArray(payload.sessions)) return;
  } catch {}
  throw new CliError('machine_not_ready', 'Remote o8 did not return a terminal inventory.', EXIT.CONFLICT);
}

function validateTarget(target: string): void {
  if (!/^(?:[A-Za-z0-9_.-]+@)?[A-Za-z0-9_.-]+$/.test(target) || target.startsWith('-')) {
    throw new CliError('invalid_args', 'SSH target must be a host or user@host without spaces or options.', EXIT.INVALID_ARGS);
  }
}

function parseAdd(rest: string[]): Omit<MachineProfile, 'id' | 'enabled'> {
  const target = rest[0];
  let label = '';
  let port = 22;
  let remoteCli = 'o8';
  let sshConfig: string | null = null;
  if (!target) throw new CliError('invalid_args', 'Use `machine add <ssh-target> --label <name> [--port n] [--remote-cli path]`.', EXIT.INVALID_ARGS);
  validateTarget(target);
  for (let i = 1; i < rest.length; i += 2) {
    const flag = rest[i];
    const value = rest[i + 1];
    if (!value || !['--label', '--port', '--remote-cli', '--ssh-config'].includes(flag)) {
      throw new CliError('invalid_args', 'Unknown or incomplete machine add option.', EXIT.INVALID_ARGS);
    }
    if (flag === '--label') label = value.trim();
    else if (flag === '--port') port = Number(value);
    else if (flag === '--remote-cli') remoteCli = value;
    else sshConfig = value;
  }
  if (!label || label.length > 64 || /[\r\n\0]/.test(label)
    || !Number.isSafeInteger(port) || port < 1 || port > 65_535
    || !(remoteCli === 'o8' || (remoteCli.startsWith('/') && !/[\r\n\0]/.test(remoteCli)))) {
    throw new CliError('invalid_args', 'Provide a valid label, SSH port, and remote o8 CLI path.', EXIT.INVALID_ARGS);
  }
  if (sshConfig && (!sshConfig.startsWith('/') || !existsSync(sshConfig) || !lstatSync(sshConfig).isFile())) {
    throw new CliError('invalid_args', '--ssh-config must name an existing absolute SSH config file.', EXIT.INVALID_ARGS);
  }
  return { label, target, port, remoteCli, sshConfig };
}

export async function runMachine(mode: OutputMode, sub: string | undefined, rest: string[]): Promise<number> {
  requireOperator();
  if (sub !== 'list' && sub !== 'check') {
    return withCatalogLock(() => runMachineUnlocked(mode, sub, rest));
  }
  return runMachineUnlocked(mode, sub, rest);
}

async function runMachineUnlocked(mode: OutputMode, sub: string | undefined, rest: string[]): Promise<number> {
  const catalog = readCatalog();
  if (sub === 'list') {
    if (rest.length) throw new CliError('invalid_args', 'machine list takes no arguments.', EXIT.INVALID_ARGS);
    if (mode.human) process.stdout.write(catalog.machines.map((machine) => `${machine.label}\t${machine.target}\t${machine.enabled ? 'enabled' : 'disabled'}\n`).join(''));
    else printJson(catalog);
    return EXIT.OK;
  }
  if (sub === 'add') {
    const details = parseAdd(rest);
    if (catalog.machines.some((machine) => machine.label === details.label || machine.id === details.label)) {
      throw new CliError('machine_exists', `Machine label ${details.label} already exists.`, EXIT.CONFLICT);
    }
    const profile: MachineProfile = { id: randomUUID(), ...details, enabled: true };
    const checked = await sshRun(profile, remoteCommand(profile, 'list', [], { ...mode, human: false }));
    if (checked.code !== 0) throw new CliError('machine_not_ready', `Remote o8 terminal host is not ready (${checked.code}).`, EXIT.CONFLICT);
    assertTerminalInventory(checked.output);
    catalog.machines.push(profile);
    saveCatalog(catalog);
    if (mode.human) process.stdout.write(`Saved ${profile.label} (${profile.id}).\n`);
    else printJson({ schema: 'o8/cli/machine.add/v1', machine: profile });
    return EXIT.OK;
  }
  if (!['check', 'rename', 'disable', 'enable', 'remove'].includes(sub ?? '') || !rest[0]) {
    throw new CliError('invalid_args', 'Use `o8 machine add|list|check|rename|disable|enable|remove`.', EXIT.INVALID_ARGS);
  }
  const profile = exactProfile(catalog, rest[0]);
  if (sub === 'check') {
    if (rest.length !== 1) throw new CliError('invalid_args', 'machine check takes one ID or label.', EXIT.INVALID_ARGS);
    if (!profile.enabled) throw new CliError('machine_disabled', 'That SSH machine is disabled.', EXIT.CONFLICT);
    const result = await sshRun(profile, remoteCommand(profile, 'list', [], { ...mode, human: false }));
    if (result.code !== 0) throw new CliError('machine_not_ready', `Remote o8 terminal host returned ${result.code}.`, EXIT.CONFLICT);
    assertTerminalInventory(result.output);
    if (mode.human) process.stdout.write(`${profile.label} is reachable.\n`);
    else printJson({ schema: 'o8/cli/machine.check/v1', machineId: profile.id, reachable: true });
    return EXIT.OK;
  }
  if (sub === 'rename') {
    const nextLabel = rest[2]?.trim();
    if (rest.length !== 3 || rest[1] !== '--label' || !nextLabel || nextLabel.length > 64
      || /[\r\n\0]/.test(nextLabel)) {
      throw new CliError('invalid_args', 'Use `machine rename <id> --label <name>`.', EXIT.INVALID_ARGS);
    }
    if (catalog.machines.some((other) => other !== profile && (other.label === nextLabel || other.id === nextLabel))) {
      throw new CliError('machine_exists', 'That machine label already exists.', EXIT.CONFLICT);
    }
    profile.label = nextLabel;
  } else {
    if (rest.length !== 1) throw new CliError('invalid_args', `machine ${sub} takes one ID or label.`, EXIT.INVALID_ARGS);
    if (sub === 'disable') profile.enabled = false;
    if (sub === 'enable') profile.enabled = true;
    if (sub === 'remove') catalog.machines = catalog.machines.filter((other) => other !== profile);
  }
  saveCatalog(catalog);
  if (mode.human) process.stdout.write(`${sub}: ${profile.label}\n`);
  else printJson({ schema: `o8/cli/machine.${sub}/v1`, machine: profile });
  return EXIT.OK;
}

export async function runRemoteTerminal(mode: OutputMode, sub: string, rest: string[], machineKey: string): Promise<number> {
  requireOperator();
  const profile = exactProfile(readCatalog(), machineKey);
  if (!profile.enabled) throw new CliError('machine_disabled', 'That SSH machine is disabled.', EXIT.CONFLICT);
  const stream = sub === 'observe' || sub === 'control';
  const interactive = sub === 'control' && mode.human;
  const requestedTimeout = sub === 'wait' && rest.includes('--timeout')
    ? Number(rest[rest.indexOf('--timeout') + 1]) : 30_000;
  const timeoutMs = sub === 'wait' && Number.isSafeInteger(requestedTimeout)
    && requestedTimeout >= 1 && requestedTimeout <= 600_000 ? requestedTimeout + 10_000 : 15_000;
  const result = await sshRun(profile, remoteCommand(profile, sub, rest, stream ? mode : { ...mode, human: false }), stream, timeoutMs, interactive);
  if (result.code !== 0) {
    if (sub === 'wait' && result.code === EXIT.CONFLICT) {
      try {
        const remoteError = JSON.parse(result.error) as { error?: { code?: string; message?: string; hint?: string } };
        if (remoteError.error?.code === 'wait_timeout') {
          throw new CliError('wait_timeout', remoteError.error.message ?? 'Remote terminal output wait timed out.',
            EXIT.CONFLICT, remoteError.error.hint);
        }
      } catch (error) {
        if (error instanceof CliError) throw error;
      }
    }
    throw new CliError('remote_terminal_error', `Remote terminal command failed on ${profile.label} (${result.code}).`,
      result.code >= 1 && result.code <= 6 ? result.code as typeof EXIT.INVALID_ARGS : EXIT.CONFLICT);
  }
  if (!stream) {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(result.output) as Record<string, unknown>;
      if (payload.schema !== `o8/cli/terminal.${sub}/v1`) throw new Error('wrong schema');
      if (sub === 'list' && !Array.isArray(payload.sessions)) throw new Error('missing sessions');
      if (sub === 'show' && typeof payload.text !== 'string') throw new Error('missing snapshot');
      if (sub === 'wait' && typeof payload.line !== 'string') throw new Error('missing match');
    } catch {
      throw new CliError('invalid_remote_response', `Remote o8 on ${profile.label} returned an invalid terminal response.`, EXIT.CONFLICT);
    }
    if (mode.human) {
      if (sub === 'show') process.stdout.write(payload.text as string);
      else if (sub === 'wait') process.stdout.write(`${payload.line as string}\n`);
      else process.stdout.write((payload.sessions as Array<{ id: string }>).map((session) => session.id).join('\n') + '\n');
    } else printJson({ ...payload, machine: { id: profile.id, label: profile.label } });
  }
  return EXIT.OK;
}
