export const dynamic = 'force-dynamic';

import { NextRequest } from 'next/server';
import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { extname } from 'node:path';
import { getDefaultLlmRepoRoot, resolveRegisteredRepoScope } from '@/lib/llm/repo-scope';
import { safeJoinReal } from '@/lib/fs/safe-path';

const MAX_PREVIEW_BYTES = 50 * 1024 * 1024;

const MIME_BY_EXTENSION: Record<string, string> = {
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
};

async function resolveRoot(workspace?: string | null) {
  if (!workspace) return getDefaultLlmRepoRoot();

  const requestedPath = workspace.startsWith('~')
    ? workspace.replace('~', homedir())
    : workspace;

  const { repoRoot } = await resolveRegisteredRepoScope(requestedPath);
  return repoRoot;
}

export async function GET(request: NextRequest) {
  const path = request.nextUrl.searchParams.get('path');
  if (!path) {
    return new Response('path required', { status: 400 });
  }

  const root = await resolveRoot(request.nextUrl.searchParams.get('workspace'));
  if (!root) {
    return new Response('Workspace is not registered', { status: 400 });
  }

  const resolved = safeJoinReal(root, path);
  if (!resolved) {
    return new Response('Path outside repository', { status: 400 });
  }

  if (!existsSync(resolved)) {
    return new Response('File not found', { status: 404 });
  }

  const mimeType = MIME_BY_EXTENSION[extname(path).toLowerCase()];
  if (!mimeType) {
    return new Response('Preview type not supported', { status: 415 });
  }

  const fileStats = await stat(resolved);
  if (!fileStats.isFile()) {
    return new Response('File not found', { status: 404 });
  }
  if (fileStats.size > MAX_PREVIEW_BYTES) {
    return new Response('File too large for preview', { status: 413 });
  }

  const buffer = await readFile(resolved);
  const filename = path.split('/').pop()?.replace(/"/g, '') || 'asset';

  return new Response(buffer, {
    headers: {
      'Cache-Control': 'private, max-age=60',
      'Content-Disposition': `inline; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      'Content-Length': String(buffer.byteLength),
      'Content-Type': mimeType,
    },
  });
}
