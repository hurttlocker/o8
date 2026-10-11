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
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
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
    const size = Number(opened.stat.size);
    const range = request.headers.get('range');
    let start = 0; let end = size - 1;
    if (range) {
      const match = range.match(/^bytes=(\d*)-(\d*)$/);
      if (!match || !match[1] && !match[2] || size === 0) return new Response('Invalid byte range', { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
      start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
      end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= size || !match[1] && Number(match[2]) === 0) return new Response('Invalid byte range', { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
    }
    let buffer = range ? Buffer.alloc(end - start + 1) : await opened.handle.readFile();
    if (range) {
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await opened.handle.read(buffer, offset, buffer.length - offset, start + offset);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      if (!offset) return new Response('File changed during preview', { status: 409 });
      buffer = buffer.subarray(0, offset);
      end = start + offset - 1;
    }
    const filename = path.split('/').pop()?.replace(/"/g, '') || 'asset';
    const headers: Record<string, string> = {
      'Cache-Control': 'private, max-age=60',
      'Content-Disposition': `inline; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      'Content-Length': String(buffer.byteLength),
      'Content-Type': mimeType,
      'X-Content-Type-Options': 'nosniff',
      'Accept-Ranges': 'bytes',
      ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
    };
    if (mimeType === 'image/svg+xml') {
      headers['Content-Security-Policy'] = "sandbox; default-src 'none'; style-src 'unsafe-inline'";
    }
    return new Response(buffer, { status: range ? 206 : 200, headers });
  } catch {
    return new Response('File not found or path refused', { status: 404 });
  } finally {
    await opened?.handle.close().catch(() => {});
  }
}
