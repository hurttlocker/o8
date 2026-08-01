export const dynamic = 'force-dynamic';

import { NextRequest } from 'next/server';
import { homedir } from 'node:os';
import { extname } from 'node:path';
import { getDefaultLlmRepoRoot, resolveRegisteredRepoScope } from '@/lib/llm/repo-scope';
import { openWorkspaceFile } from '@/lib/fs/workspace-file';

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

  const mimeType = MIME_BY_EXTENSION[extname(path).toLowerCase()];
  if (!mimeType) {
    return new Response('Preview type not supported', { status: 415 });
  }

  let opened: Awaited<ReturnType<typeof openWorkspaceFile>> | null = null;
  try {
    opened = await openWorkspaceFile(root, path, 'read');
    if (opened.stat.size > MAX_PREVIEW_BYTES) {
      return new Response('File too large for preview', { status: 413 });
    }
    const buffer = await opened.handle.readFile();
    const filename = path.split('/').pop()?.replace(/"/g, '') || 'asset';
    const headers: Record<string, string> = {
      'Cache-Control': 'private, max-age=60',
      'Content-Disposition': `inline; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      'Content-Length': String(buffer.byteLength),
      'Content-Type': mimeType,
      'X-Content-Type-Options': 'nosniff',
    };
    if (mimeType === 'image/svg+xml') {
      headers['Content-Security-Policy'] = "sandbox; default-src 'none'; style-src 'unsafe-inline'";
    }
    return new Response(buffer, { headers });
  } catch {
    return new Response('File not found or path refused', { status: 404 });
  } finally {
    await opened?.handle.close().catch(() => {});
  }
}
