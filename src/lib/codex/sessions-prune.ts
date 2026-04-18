import { access, copyFile, mkdir, open, readdir, rename, rm, stat, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const DEFAULT_SESSIONS_ROOT = path.join(CODEX_HOME, 'sessions');
const DEFAULT_ARCHIVE_ROOT = path.join(CODEX_HOME, 'sessions-archive');
const DEFAULT_MAX_AGE_DAYS = 14;
const SESSION_CWD_SCAN_BYTES = 32 * 1024;
const WALK_CONCURRENCY = 16;

export type CodexSessionPruneMode = 'archive' | 'delete';

export type CodexSessionPruneOptions = {
  archiveRoot?: string;
  maxAgeDays?: number;
  mode?: CodexSessionPruneMode;
  now?: number;
  sessionsRoot?: string;
};

export type CodexSessionPruneResult = {
  archiveRoot: string | null;
  candidates: number;
  deleted: number;
  durationMs: number;
  maxAgeDays: number;
  missingCwd: number;
  mode: CodexSessionPruneMode;
  moved: number;
  olderThanDays: number;
  scanned: number;
  sessionsRoot: string;
  skipped: number;
};

type SessionPruneCandidate = {
  filePath: string;
  missingCwd: boolean;
  olderThanDays: boolean;
};

function normalizeMaxAgeDays(value?: number) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_MAX_AGE_DAYS;
  }

  return Math.max(1, Math.floor(value));
}

async function pathExists(targetPath: string) {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function walkSessionJsonlFiles(rootPath: string) {
  if (!(await pathExists(rootPath))) {
    return [] as string[];
  }

  const results: string[] = [];
  const pending = [rootPath];

  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) {
      continue;
    }

    const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(entryPath);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        results.push(entryPath);
      }
    }
  }

  return results;
}

async function readSessionCwd(filePath: string) {
  const handle = await open(filePath, 'r').catch(() => null);
  if (!handle) {
    return null;
  }

  try {
    const buffer = Buffer.alloc(SESSION_CWD_SCAN_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead <= 0) {
      return null;
    }

    const prefix = buffer.toString('utf8', 0, bytesRead);
    const match = prefix.match(/"cwd":"((?:\\\\|\\.|[^"])*)"/);
    if (!match?.[1]) {
      return null;
    }

    return JSON.parse(`"${match[1]}"`) as string;
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function mapWithConcurrency<T, TResult>(
  items: T[],
  limit: number,
  mapper: (item: T) => Promise<TResult>,
) {
  if (items.length === 0) {
    return [] as TResult[];
  }

  const results = new Array<TResult>(items.length);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));

  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= items.length) {
        return;
      }

      results[currentIndex] = await mapper(items[currentIndex]);
    }
  }));

  return results;
}

async function classifyCandidate(
  filePath: string,
  cutoffMs: number,
  cwdExistsCache: Map<string, boolean>,
) {
  const fileStat = await stat(filePath);
  const olderThanDays = fileStat.mtimeMs <= cutoffMs;
  const cwd = await readSessionCwd(filePath);

  let missingCwd = false;
  if (cwd) {
    const cached = cwdExistsCache.get(cwd);
    if (typeof cached === 'boolean') {
      missingCwd = !cached;
    } else {
      const exists = await pathExists(cwd);
      cwdExistsCache.set(cwd, exists);
      missingCwd = !exists;
    }
  }

  if (!olderThanDays && !missingCwd) {
    return null;
  }

  return {
    filePath,
    missingCwd,
    olderThanDays,
  } satisfies SessionPruneCandidate;
}

function buildArchiveDestination(filePath: string, sessionsRoot: string, archiveRoot: string) {
  const relativePath = path.relative(sessionsRoot, filePath);
  if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw new Error('Codex session path escaped the sessions root.');
  }

  return path.join(archiveRoot, relativePath);
}

async function findAvailableArchivePath(destination: string) {
  if (!(await pathExists(destination))) {
    return destination;
  }

  const extension = path.extname(destination);
  const baseName = extension ? destination.slice(0, -extension.length) : destination;

  for (let suffix = 1; suffix < 10_000; suffix += 1) {
    const candidate = `${baseName}-${suffix}${extension}`;
    if (!(await pathExists(candidate))) {
      return candidate;
    }
  }

  throw new Error('Unable to reserve archive path for codex session prune.');
}

async function moveFile(sourcePath: string, destinationPath: string) {
  try {
    await rename(sourcePath, destinationPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code ?? '';
    if (code !== 'EXDEV') {
      throw error;
    }

    await copyFile(sourcePath, destinationPath);
    await unlink(sourcePath);
  }
}

export async function pruneCodexSessions(options: CodexSessionPruneOptions = {}): Promise<CodexSessionPruneResult> {
  const startedAt = Date.now();
  const sessionsRoot = options.sessionsRoot ?? DEFAULT_SESSIONS_ROOT;
  const archiveRoot = options.archiveRoot ?? DEFAULT_ARCHIVE_ROOT;
  const mode = options.mode ?? 'archive';
  const maxAgeDays = normalizeMaxAgeDays(options.maxAgeDays);
  const now = typeof options.now === 'number' && Number.isFinite(options.now) ? options.now : Date.now();
  const cutoffMs = now - (maxAgeDays * 24 * 60 * 60 * 1000);
  const files = await walkSessionJsonlFiles(sessionsRoot);
  const cwdExistsCache = new Map<string, boolean>();

  const candidates = (await mapWithConcurrency(files, WALK_CONCURRENCY, async (filePath) =>
    classifyCandidate(filePath, cutoffMs, cwdExistsCache).catch(() => null),
  )).filter((candidate): candidate is SessionPruneCandidate => Boolean(candidate));

  let moved = 0;
  let deleted = 0;
  let skipped = 0;

  if (mode === 'archive' && candidates.length > 0) {
    await mkdir(archiveRoot, { recursive: true });
  }

  for (const candidate of candidates) {
    try {
      if (mode === 'delete') {
        await rm(candidate.filePath, { force: true });
        deleted += 1;
        continue;
      }

      const baseDestination = buildArchiveDestination(candidate.filePath, sessionsRoot, archiveRoot);
      const destination = await findAvailableArchivePath(baseDestination);
      await mkdir(path.dirname(destination), { recursive: true });
      await moveFile(candidate.filePath, destination);
      moved += 1;
    } catch {
      skipped += 1;
    }
  }

  return {
    archiveRoot: mode === 'archive' ? archiveRoot : null,
    candidates: candidates.length,
    deleted,
    durationMs: Date.now() - startedAt,
    maxAgeDays,
    missingCwd: candidates.filter((candidate) => candidate.missingCwd).length,
    mode,
    moved,
    olderThanDays: candidates.filter((candidate) => candidate.olderThanDays).length,
    scanned: files.length,
    sessionsRoot,
    skipped,
  };
}
