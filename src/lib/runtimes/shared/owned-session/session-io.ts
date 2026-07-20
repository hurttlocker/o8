import { readdir } from 'node:fs/promises';
import path from 'node:path';

import {
  archiveOwnedSessionDir,
  archivedSessionPathForSurfaceId,
} from './archive';
import {
  RUNS_DIR,
  ensureDir,
  metadataPath,
  nowIso,
  pathExists,
  readJsonFile,
  writeJsonFile,
} from './helpers';
import type {
  OwnedArchiveResponse,
  OwnedSessionRecord,
} from './types';

export interface OwnedSessionIo {
  ensureRoot(): Promise<string>;
  listSessionDirs(): Promise<string[]>;
  loadSession(sessionDir: string): Promise<OwnedSessionRecord>;
  saveSession(session: OwnedSessionRecord): Promise<void>;
  findSession(surfaceId: string): Promise<OwnedSessionRecord | null>;
  findArchivedSession(surfaceId: string): Promise<OwnedSessionRecord | null>;
  archiveSession(surfaceId: string): Promise<OwnedArchiveResponse>;
}

export function createOwnedSessionIo({
  root,
  surfacePrefix,
  invalidateFleetCache,
}: {
  root: string;
  surfacePrefix: string;
  invalidateFleetCache: () => void;
}): OwnedSessionIo {
  async function ensureRoot() {
    await ensureDir(root);
    return root;
  }

  async function listSessionDirs() {
    const resolvedRoot = await ensureRoot();
    const entries = await readdir(resolvedRoot, { withFileTypes: true }).catch(() => []);
    return entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(resolvedRoot, entry.name));
  }

  async function loadSession(sessionDir: string) {
    return readJsonFile<OwnedSessionRecord>(metadataPath(sessionDir));
  }

  async function saveSession(session: OwnedSessionRecord) {
    session.updatedAt = nowIso();
    await writeJsonFile(metadataPath(session.sessionDir), session);
  }

  async function findSession(surfaceId: string) {
    for (const sessionDir of await listSessionDirs()) {
      const filePath = metadataPath(sessionDir);
      if (!(await pathExists(filePath))) continue;
      const session = await loadSession(sessionDir);
      if (session.surfaceId === surfaceId) {
        return session;
      }
    }
    return null;
  }

  async function findArchivedSession(surfaceId: string): Promise<OwnedSessionRecord | null> {
    const archivePath = await archivedSessionPathForSurfaceId(root, surfaceId, surfacePrefix);
    if (!archivePath) return null;
    if (!(await pathExists(metadataPath(archivePath)))) return null;
    const session = await loadSession(archivePath);
    const rebaseRun = <T extends { stdoutPath: string; stderrPath: string }>(run: T): T => ({
      ...run,
      stdoutPath: path.join(archivePath, RUNS_DIR, path.basename(run.stdoutPath)),
      stderrPath: path.join(archivePath, RUNS_DIR, path.basename(run.stderrPath)),
    });
    return {
      ...session,
      sessionDir: archivePath,
      recentRuns: session.recentRuns.map(rebaseRun),
      activeRun: session.activeRun ? rebaseRun(session.activeRun) : session.activeRun,
    };
  }

  async function archiveSession(surfaceId: string): Promise<OwnedArchiveResponse> {
    const session = await findSession(surfaceId);
    if (!session) {
      const archivePath = await archivedSessionPathForSurfaceId(root, surfaceId, surfacePrefix);
      if (archivePath) {
        invalidateFleetCache();
        return { archived: true, archivePath, note: 'Session already archived.' };
      }
      return { archived: false, note: 'Session was not found.' };
    }

    const result = await archiveOwnedSessionDir(root, session);
    if (result.archived) {
      invalidateFleetCache();
    }
    return result;
  }

  return {
    ensureRoot,
    listSessionDirs,
    loadSession,
    saveSession,
    findSession,
    findArchivedSession,
    archiveSession,
  };
}
