import 'server-only';

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { parseWorkspaceManifest, WorkspaceManifestValidationError } from './schema';
import { WORKSPACE_MANIFEST_FILENAME, type WorkspaceManifest } from './types';

export interface WorkspaceManifestSource {
  manifest: WorkspaceManifest;
  source: Buffer;
}

export function workspaceManifestPath(repoPath: string): string {
  return path.join(path.resolve(repoPath), WORKSPACE_MANIFEST_FILENAME);
}

export async function loadWorkspaceManifestSource(
  repoPath: string,
): Promise<WorkspaceManifestSource | null> {
  const manifestPath = workspaceManifestPath(repoPath);
  let source: Buffer;
  try {
    source = await readFile(manifestPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new WorkspaceManifestValidationError(
      '$',
      `could not read the file: ${error instanceof Error ? error.message : String(error)}.`,
      { cause: error },
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(source.toString('utf8'));
  } catch (error) {
    throw new WorkspaceManifestValidationError(
      '$',
      `invalid JSON: ${error instanceof Error ? error.message : String(error)}.`,
      { cause: error },
    );
  }
  return { manifest: parseWorkspaceManifest(parsed), source };
}

export async function loadWorkspaceManifest(repoPath: string): Promise<WorkspaceManifest | null> {
  return (await loadWorkspaceManifestSource(repoPath))?.manifest ?? null;
}
