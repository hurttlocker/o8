import { NextResponse, type NextRequest } from 'next/server';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Inline image assets for o8.md. Stored repo-relative at <repoPath>/o8-assets/
// so they travel WITH the repo (dispatched agents see them) and are served back
// through the existing path-jailed /api/panel/file-asset reader. The markdown in
// o8.md stays a tiny ref — ![alt](o8-assets/foo.png "WxH"), never base64 — so the
// 256KB o8.md cap is never at risk and the orchestrator's per-dispatch read of
// o8.md stays lean. Companion writer to that reader; same loopback posture as the
// sibling /api/repo-spec GET/PUT/POST.

const ASSET_MAX_BYTES = 10 * 1024 * 1024; // 10 MB per image
const ASSETS_DIR = 'o8-assets';

const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/svg+xml': 'svg',
};

function repoDir(repoPath: string): string | null {
  if (!repoPath || typeof repoPath !== 'string' || !existsSync(repoPath)) return null;
  try {
    if (!statSync(repoPath).isDirectory()) return null;
  } catch {
    return null;
  }
  return repoPath;
}

function slugifyStem(name: string): string {
  const stem = name.replace(/\.[^.]+$/, '');
  const slug = stem.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  return slug || 'image';
}

export async function POST(request: NextRequest) {
  const repoPath = repoDir(request.nextUrl.searchParams.get('repoPath') ?? '');
  if (!repoPath) {
    return NextResponse.json({ ok: false, error: 'repoPath invalid' }, { status: 400 });
  }

  const mime = (request.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  const ext = EXT_BY_MIME[mime];
  if (!ext) {
    return NextResponse.json({ ok: false, error: `unsupported image type: ${mime || '(none)'}` }, { status: 415 });
  }

  const buf = Buffer.from(await request.arrayBuffer());
  if (buf.byteLength === 0) {
    return NextResponse.json({ ok: false, error: 'empty body' }, { status: 400 });
  }
  if (buf.byteLength > ASSET_MAX_BYTES) {
    return NextResponse.json({ ok: false, error: `image exceeds ${ASSET_MAX_BYTES} bytes` }, { status: 413 });
  }

  // Hash for uniqueness; slug is human-readable context. Re-dropping the exact
  // same file (same name + bytes) is idempotent — the write below is skipped.
  const hash = createHash('sha256').update(buf).digest('hex').slice(0, 10);
  let rawName = '';
  try {
    rawName = decodeURIComponent(request.headers.get('x-filename') ?? '');
  } catch {
    rawName = '';
  }
  const fileName = `${slugifyStem(rawName)}-${hash}.${ext}`;

  const assetsDir = join(repoPath, ASSETS_DIR);
  const target = join(assetsDir, fileName);
  // Defensive path-jail: fileName is slug+hash+ext (no separators), but verify
  // the resolved write still lands under <repoPath>/o8-assets anyway.
  if (!resolve(target).startsWith(resolve(assetsDir) + sep)) {
    return NextResponse.json({ ok: false, error: 'path escapes asset dir' }, { status: 400 });
  }

  try {
    mkdirSync(assetsDir, { recursive: true });
    if (!existsSync(target)) writeFileSync(target, buf);
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'write failed' },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true, relPath: `${ASSETS_DIR}/${fileName}`, name: fileName, bytes: buf.byteLength });
}
