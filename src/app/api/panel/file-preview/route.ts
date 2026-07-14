export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { readFile, stat } from 'node:fs/promises';
import { extname } from 'node:path';
import { existsSync } from 'node:fs';
import { expandHome, safeJoinReal } from '@/lib/fs/safe-path';
import { getDefaultLlmRepoRoot, resolveRegisteredRepoScope } from '@/lib/llm/repo-scope';

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico', '.bmp']);
const MIME_MAP: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
};

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const filePath = searchParams.get('path');
  const workspaceParam = searchParams.get('workspace');

  if (!filePath) {
    return NextResponse.json({ error: 'path param required' }, { status: 400 });
  }

  let root: string | null = getDefaultLlmRepoRoot();
  if (workspaceParam) {
    const scope = await resolveRegisteredRepoScope(expandHome(workspaceParam));
    root = scope.repoRoot;
  }
  if (!root) {
    return NextResponse.json({ error: 'Workspace is not a registered repository' }, { status: 400 });
  }

  const fullPath = safeJoinReal(root, filePath);
  if (!fullPath) {
    return NextResponse.json({ error: 'Path traversal not allowed' }, { status: 403 });
  }

  if (!existsSync(fullPath)) {
    return NextResponse.json({ error: 'File not found' }, { status: 404 });
  }

  const ext = extname(filePath).toLowerCase();
  if (!IMAGE_EXTENSIONS.has(ext)) {
    return NextResponse.json({ error: 'Not an image file' }, { status: 400 });
  }

  try {
    const fileStats = await stat(fullPath);
    // Limit to 10MB
    if (fileStats.size > 10 * 1024 * 1024) {
      return NextResponse.json({ error: 'File too large (>10MB)' }, { status: 400 });
    }

    const buffer = await readFile(fullPath);
    const mimeType = MIME_MAP[ext] || 'application/octet-stream';

    // For SVGs, return as text
    if (ext === '.svg') {
      return NextResponse.json({
        type: 'svg',
        content: buffer.toString('utf-8'),
        mimeType,
        size: fileStats.size,
        path: filePath,
      });
    }

    // For raster images, return as base64 data URL
    const base64 = buffer.toString('base64');
    return NextResponse.json({
      type: 'image',
      dataUrl: `data:${mimeType};base64,${base64}`,
      mimeType,
      size: fileStats.size,
      path: filePath,
    });
  } catch {
    return NextResponse.json({ error: 'Could not read file' }, { status: 500 });
  }
}
