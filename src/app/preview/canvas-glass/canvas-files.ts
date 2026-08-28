'use client';

export interface CanvasFileEntry {
  name: string;
  path: string;
  kind: 'file' | 'directory';
  ignored?: boolean;
}

interface CanvasFilesResponse {
  entries?: CanvasFileEntry[];
  root?: string | null;
  error?: string;
}

export function resolveCanvasFilePath(repoPath: string, filePath: string): string {
  if (filePath.startsWith('/')) return filePath;
  const root = repoPath.replace(/\/+$/, '');
  const relative = filePath.replace(/^\.\//, '').replace(/^\/+/, '');
  return `${root}/${relative}`;
}

async function readEntries(url: string, fetchImpl: typeof fetch): Promise<CanvasFileEntry[]> {
  const response = await fetchImpl(url);
  const payload = await response.json() as CanvasFilesResponse;
  if (!response.ok) throw new Error(payload.error || 'Unable to list repository files');
  return Array.isArray(payload.entries) ? payload.entries : [];
}

export function listCanvasDirectory(
  repoPath: string,
  directory: string,
  fetchImpl: typeof fetch = fetch,
): Promise<CanvasFileEntry[]> {
  const params = new URLSearchParams({ workspace: repoPath, directory });
  return readEntries(`/api/panel/files?${params.toString()}`, fetchImpl);
}

export function listCanvasFiles(
  repoPath: string,
  fetchImpl: typeof fetch = fetch,
): Promise<CanvasFileEntry[]> {
  const params = new URLSearchParams({ workspace: repoPath, recursive: 'files' });
  return readEntries(`/api/panel/files?${params.toString()}`, fetchImpl);
}
