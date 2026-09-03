import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { resolveCliDataDir } from '../config.js';

const RECEIPT_RETENTION = 50;

export interface ManagedRunReceiptMetadata {
  schema: 'o8/cli/run-receipt/v1';
  id: string;
  session: string;
  command: string;
  cwd: string;
  startedAt: string;
  mode: 'stream' | 'detach';
}

export interface LastManagedRunReceipt extends ManagedRunReceiptMetadata {
  exitStatus: string | null;
  logPath: string;
}

export function managedRunReceiptPaths(id: string, dataDir = resolveCliDataDir()) {
  const directory = join(dataDir, 'logs', 'run');
  return {
    directory,
    logFile: join(directory, `${id}.log`),
    exitFile: join(directory, `${id}.exit`),
    metadataFile: join(directory, `${id}.json`),
  };
}

function isManagedRunReceiptMetadata(value: unknown): value is ManagedRunReceiptMetadata {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return candidate.schema === 'o8/cli/run-receipt/v1'
    && typeof candidate.id === 'string'
    && /^[a-f0-9]{8}$/.test(candidate.id)
    && candidate.session === `cortex-run-${candidate.id}`
    && typeof candidate.command === 'string'
    && typeof candidate.cwd === 'string'
    && typeof candidate.startedAt === 'string'
    && (candidate.mode === 'stream' || candidate.mode === 'detach');
}

function readReceiptMetadata(directory: string): ManagedRunReceiptMetadata[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .flatMap((name) => {
      try {
        const parsed = JSON.parse(readFileSync(join(directory, name), 'utf8')) as unknown;
        return isManagedRunReceiptMetadata(parsed) ? [parsed] : [];
      } catch {
        return [];
      }
    })
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt)
      || right.id.localeCompare(left.id));
}

function pruneRunReceipts(directory: string): void {
  for (const receipt of readReceiptMetadata(directory).slice(RECEIPT_RETENTION)) {
    const exitFile = join(directory, `${receipt.id}.exit`);
    if (!existsSync(exitFile)) continue;
    for (const path of [
      join(directory, `${receipt.id}.log`),
      exitFile,
      join(directory, `${receipt.id}.json`),
    ]) {
      try { rmSync(path, { force: true }); } catch {}
    }
  }
}

export function initializeManagedRunReceipt(
  metadata: ManagedRunReceiptMetadata,
  dataDir = resolveCliDataDir(),
) {
  const paths = managedRunReceiptPaths(metadata.id, dataDir);
  try {
    mkdirSync(paths.directory, { recursive: true, mode: 0o700 });
    rmSync(paths.exitFile, { force: true });
    writeFileSync(paths.logFile, '', { mode: 0o600 });
    writeFileSync(paths.metadataFile, `${JSON.stringify(metadata)}\n`, { mode: 0o600 });
  } catch (error) {
    for (const path of [paths.logFile, paths.exitFile, paths.metadataFile]) {
      try { rmSync(path, { force: true }); } catch {}
    }
    throw error;
  }
  pruneRunReceipts(paths.directory);
  return paths;
}

export function readLastManagedRunReceipt(
  dataDir = resolveCliDataDir(),
): LastManagedRunReceipt | null {
  const directory = join(dataDir, 'logs', 'run');
  const latest = readReceiptMetadata(directory)[0];
  if (!latest) return null;
  const { logFile, exitFile } = managedRunReceiptPaths(latest.id, dataDir);
  let exitStatus: string | null = null;
  try {
    const value = readFileSync(exitFile, 'utf8').trim();
    if (value) exitStatus = value;
  } catch { /* a live run has no exit receipt yet */ }
  return { ...latest, exitStatus, logPath: logFile };
}

export function exitCodeFromStatus(status: string): number | null {
  if (/^\d+$/.test(status)) return Number.parseInt(status, 10);
  const signal = status.match(/^signal:(HUP|INT|QUIT|KILL|TERM)$/)?.[1];
  if (!signal) return null;
  const number = { HUP: 1, INT: 2, QUIT: 3, KILL: 9, TERM: 15 }[signal];
  return number === undefined ? null : 128 + number;
}
