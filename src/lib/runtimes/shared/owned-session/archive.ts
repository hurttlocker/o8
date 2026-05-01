import path from 'node:path';
import { mkdir, rename } from 'node:fs/promises';

import { metadataPath, nowIso, pathExists, readJsonFile, writeJsonFile } from './helpers';
import type { OwnedSessionRecord } from './types';

export interface ArchiveOwnedSessionResult {
  archived: boolean;
  archivePath?: string;
  note: string;
}

export function archiveRootForOwnedSessionRoot(root: string) {
  return `${root.replace(/\/+$/, '')}-archive`;
}

export function sessionDirNameFromSurfaceId(surfaceId: string, surfacePrefix: string) {
  const trimmed = surfaceId.trim();
  if (trimmed.startsWith(surfacePrefix)) {
    return trimmed.slice(surfacePrefix.length);
  }
  const colonIndex = trimmed.indexOf(':');
  return colonIndex === -1 ? trimmed : trimmed.slice(colonIndex + 1);
}

export async function archivedSessionPathForSurfaceId(
  root: string,
  surfaceId: string,
  surfacePrefix: string,
) {
  const sessionDirName = sessionDirNameFromSurfaceId(surfaceId, surfacePrefix);
  if (!sessionDirName) return null;
  const archivePath = path.join(archiveRootForOwnedSessionRoot(root), sessionDirName);
  return (await pathExists(archivePath)) ? archivePath : null;
}

export async function archiveOwnedSessionDir(
  root: string,
  session: OwnedSessionRecord,
): Promise<ArchiveOwnedSessionResult> {
  const archiveRoot = archiveRootForOwnedSessionRoot(root);
  const archivePath = path.join(archiveRoot, path.basename(session.sessionDir));

  if (!(await pathExists(session.sessionDir))) {
    if (await pathExists(archivePath)) {
      return { archived: true, archivePath, note: 'Session already archived.' };
    }
    return { archived: false, note: 'Session directory was not found.' };
  }

  if (await pathExists(archivePath)) {
    return {
      archived: false,
      archivePath,
      note: `Archive path already exists: ${archivePath}`,
    };
  }

  await mkdir(archiveRoot, { recursive: true });
  await rename(session.sessionDir, archivePath);

  try {
    const archiveMetadataPath = metadataPath(archivePath);
    const archivedSession = await readJsonFile<OwnedSessionRecord>(archiveMetadataPath);
    await writeJsonFile(archiveMetadataPath, {
      ...archivedSession,
      sessionDir: archivePath,
      updatedAt: nowIso(),
    });
  } catch (error) {
    console.warn(
      `[owned-store] Archived ${session.surfaceId} but failed to update archived metadata:`,
      error instanceof Error ? error.message : error,
    );
  }

  return { archived: true, archivePath, note: `Session archived at ${archivePath}.` };
}
