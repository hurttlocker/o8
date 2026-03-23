export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { readFile, stat } from 'node:fs/promises';
import { extname } from 'node:path';
import { existsSync } from 'node:fs';

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

const ALLOWED_ROOTS = [
  process.env.HOME || require('os').homedir(),
  '/tmp',
];

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const filePath = searchParams.get('path');

  if (!filePath) {
    return NextResponse.json({ error: 'path param required' }, { status: 400 });
  }

  // Resolve ~ to HOME
  const home = process.env.HOME || require('os').homedir();
  const resolved = filePath.startsWith('~') ? filePath.replace('~', home) : filePath;

  // Security: must be under allowed roots
  const allowed = ALLOWED_ROOTS.some(root => resolved.startsWith(root));
  if (!allowed) {
    return NextResponse.json({ error: 'Path not allowed' }, { status: 403 });
  }

  if (!existsSync(resolved)) {
    return NextResponse.json({ error: 'File not found' }, { status: 404 });
  }

  const ext = extname(resolved).toLowerCase();
  const mimeType = MIME_MAP[ext];
  if (!mimeType) {
    return NextResponse.json({ error: 'Not an image file' }, { status: 400 });
  }

  try {
    const fileStats = await stat(resolved);
    if (fileStats.size > 20 * 1024 * 1024) {
      return NextResponse.json({ error: 'File too large' }, { status: 400 });
    }

    const buffer = await readFile(resolved);
    return new NextResponse(buffer, {
      headers: {
        'Content-Type': mimeType,
        'Cache-Control': 'public, max-age=3600',
        'Content-Length': fileStats.size.toString(),
      },
    });
  } catch {
    return NextResponse.json({ error: 'Could not read file' }, { status: 500 });
  }
}
