export const dynamic = 'force-dynamic';

/**
 * GET /api/v2/context/files?q=<search> — autocomplete file paths
 * POST /api/v2/context/files — read file contents for context injection
 */

import { NextRequest, NextResponse } from 'next/server';
import { execFileSync } from 'node:child_process';
import { resolveRepoScopeFromHeaders } from '@/lib/llm/repo-scope';
import { openWorkspaceFile } from '@/lib/fs/workspace-file';

const MAX_FILE_SIZE = 100_000; // 100KB max per file
const MAX_FILES = 5; // max files per request

// GET — autocomplete file paths
export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams.get('q') || '';
  if (q.length < 1) {
    return NextResponse.json({ files: [] });
  }

  const { repoRoot } = await resolveRepoScopeFromHeaders(request.headers);
  if (!repoRoot) {
    return NextResponse.json({ files: [] });
  }

  try {
    // git ls-files for a fast, gitignore-aware listing — run via execFileSync
    // (NO shell) and do the case-insensitive match + cap in JS. The query is
    // never interpolated into a command, so there is no shell to inject into.
    // (The old `git ls-files | grep -i "${q}" | head -20` form was an RCE sink:
    // only `"` was stripped, so $(), backticks, ; and | all survived.) `-z`
    // keeps paths with spaces/newlines intact.
    const out = execFileSync('git', ['ls-files', '-z'], {
      cwd: repoRoot,
      encoding: 'utf-8',
      timeout: 3000,
      maxBuffer: 16 * 1024 * 1024,
    });

    const needle = q.toLowerCase();
    const files = out
      .split('\0')
      .filter((f) => f && f.toLowerCase().includes(needle))
      .slice(0, 20)
      .map((f) => ({ path: f, name: f.split('/').pop() || f }));

    return NextResponse.json({ files });
  } catch {
    return NextResponse.json({ files: [] });
  }
}

// POST — read file contents
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  if (!body?.paths || !Array.isArray(body.paths)) {
    return NextResponse.json({ error: 'paths array required' }, { status: 400 });
  }

  const { repoRoot } = await resolveRepoScopeFromHeaders(request.headers);
  if (!repoRoot) {
    return NextResponse.json({ error: 'No repository is scoped to this chat' }, { status: 400 });
  }

  const paths: string[] = body.paths.slice(0, MAX_FILES);
  const results: { path: string; content: string; truncated: boolean; error?: string }[] = [];

  for (const filePath of paths) {
    let opened: Awaited<ReturnType<typeof openWorkspaceFile>> | null = null;
    try {
      opened = await openWorkspaceFile(repoRoot, filePath, 'read');
      if (opened.stat.size > MAX_FILE_SIZE) {
        const buffer = Buffer.alloc(MAX_FILE_SIZE);
        const { bytesRead } = await opened.handle.read(buffer, 0, buffer.byteLength, 0);
        results.push({ path: filePath, content: buffer.subarray(0, bytesRead).toString('utf-8'), truncated: true });
      } else {
        const content = (await opened.handle.readFile()).toString('utf-8');
        results.push({ path: filePath, content, truncated: false });
      }
    } catch {
      results.push({ path: filePath, content: '', truncated: false, error: 'File not found' });
    } finally {
      await opened?.handle.close().catch(() => {});
    }
  }

  return NextResponse.json({ files: results });
}
