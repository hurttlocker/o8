import { randomBytes } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { Socket } from 'node:net';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { withServeOperation, withServeStateMutation } from './serve-processes.js';
import { CliError, EXIT } from '../api.js';
import { resolveCliDataDir } from '../config.js';
import { printHumanKv, printJson, type OutputMode } from '../output.js';

function refused(message: string): never {
  throw new CliError('serve_token_renewal_refused', message, EXIT.CONFLICT);
}

async function assertPortStopped(path: string): Promise<void> {
  if (!existsSync(path)) return;
  const port = Number(readFileSync(path, 'utf8').trim());
  if (!Number.isInteger(port) || port < 1 || port > 65_535) refused('Profile has an invalid runtime port record.');
  const stopped = await new Promise<boolean>((done) => {
    const socket = new Socket();
    const finish = (value: boolean) => { socket.destroy(); done(value); };
    socket.setTimeout(500);
    socket.once('connect', () => finish(false));
    socket.once('timeout', () => finish(false));
    socket.once('error', (error: NodeJS.ErrnoException) => finish(error.code === 'ECONNREFUSED'));
    socket.connect(port, '127.0.0.1');
  });
  if (!stopped) refused('A profile runtime port is reachable or its absence cannot be verified.');
}

/** Local renewal only: active runtimes cache the token and must first be stopped. */
export async function renewServeToken(mode: OutputMode): Promise<number> {
  if (process.env.O8_WORKER_TOKEN?.trim()) refused('A worker cannot renew the profile credential.');
  if (!process.env.O8_DATA_DIR?.trim() && !process.env.CORTEX_IDE_DATA_DIR?.trim()) {
    refused('Select a stopped private profile with O8_DATA_DIR.');
  }
  const dataDir = realpathSync(resolveCliDataDir());
  for (const name of ['.o8', '.cortex-ide']) {
    const path = join(homedir(), name);
    if (dataDir === (existsSync(path) ? realpathSync(path) : resolve(path))) {
      refused('The default desktop profile cannot be renewed by this headless command.');
    }
  }
  const tokenPath = join(dataDir, 'ws-token');
  if (!existsSync(join(dataDir, 'serve-instance-id')) || !existsSync(tokenPath) || !lstatSync(tokenPath).isFile()) {
    refused('An existing headless profile with a regular token file is required.');
  }
  return withServeOperation(dataDir, async () => {
    const pidPath = join(dataDir, 'serve.pid');
    const statePath = join(dataDir, 'serve-state.json');
    withServeStateMutation(statePath, () => {
      if (existsSync(statePath)) refused('Retained runtime state requires ownership reconciliation before renewal.');
      try { writeFileSync(pidPath, String(process.pid), { flag: 'wx', mode: 0o600 }); } catch {
        refused('The profile has an owner or cannot be exclusively locked.');
      }
    });
    const temporary = join(dataDir, `.ws-token-renew-${process.pid}-${randomBytes(8).toString('hex')}`);
    try {
      if (existsSync(statePath)) refused('Runtime state appeared during renewal.');
      await assertPortStopped(join(dataDir, 'api-port'));
      await assertPortStopped(join(dataDir, 'ws-port'));
      withServeStateMutation(statePath, () => {
        if (existsSync(statePath) || readFileSync(pidPath, 'utf8') !== String(process.pid)) {
          refused('Profile ownership changed during renewal.');
        }
        writeFileSync(temporary, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 });
        renameSync(temporary, tokenPath);
      });
      if (mode.human) printHumanKv([['renewed', 'true']]);
      else printJson({ schema: 'o8/cli/serve-token-renewal/v1', renewed: true });
      return EXIT.OK;
    } finally {
      rmSync(temporary, { force: true });
      withServeStateMutation(statePath, () => {
        if (existsSync(pidPath) && readFileSync(pidPath, 'utf8') === String(process.pid)) rmSync(pidPath);
      });
    }
  });
}
