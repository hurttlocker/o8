export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { readFile, stat } from 'node:fs/promises';
import { extname } from 'node:path';
import { existsSync } from 'node:fs';
import { confineToRoots } from '@/lib/fs/safe-path';

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

  // Security: normalize (collapsing any `..`) and confine to an allowed root.
  // A plain startsWith on the un-normalized path let `~/../../etc/x` escape.
  const resolved = confineToRoots(filePath, ALLOWED_ROOTS);
  if (!resolved) {
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
