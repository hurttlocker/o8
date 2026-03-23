export const dynamic = 'force-dynamic';

/**
 * GET /api/v2/context/files?q=<search> — autocomplete file paths
 * POST /api/v2/context/files — read file contents for context injection
 */

import { NextRequest, NextResponse } from 'next/server';
import { execSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const REPO_ROOT = process.env.CORTEX_IDE_REVIEW_REPO_ROOT || process.cwd();
const MAX_FILE_SIZE = 100_000; // 100KB max per file
const MAX_FILES = 5; // max files per request

// GET — autocomplete file paths
export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams.get('q') || '';
  if (q.length < 1) {
    return NextResponse.json({ files: [] });
  }

  try {
    // Use git ls-files for fast, gitignore-aware search
    const raw = execSync(
      `git ls-files | grep -i "${q.replace(/"/g, '')}" | head -20`,
      { cwd: REPO_ROOT, encoding: 'utf-8', timeout: 3000 },
    ).trim();

    const files = raw ? raw.split('\n').map(f => ({
      path: f,
      name: f.split('/').pop() || f,
    })) : [];

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

  const paths: string[] = body.paths.slice(0, MAX_FILES);
  const results: { path: string; content: string; truncated: boolean; error?: string }[] = [];

  for (const filePath of paths) {
    // Security: prevent path traversal
    const resolved = join(REPO_ROOT, filePath);
    const rel = relative(REPO_ROOT, resolved);
    if (rel.startsWith('..') || rel.startsWith('/')) {
      results.push({ path: filePath, content: '', truncated: false, error: 'Path outside repo' });
      continue;
    }

    try {
      const stat = statSync(resolved);
      if (stat.size > MAX_FILE_SIZE) {
        const partial = readFileSync(resolved, 'utf-8').slice(0, MAX_FILE_SIZE);
        results.push({ path: filePath, content: partial, truncated: true });
      } else {
        const content = readFileSync(resolved, 'utf-8');
        results.push({ path: filePath, content, truncated: false });
      }
    } catch {
      results.push({ path: filePath, content: '', truncated: false, error: 'File not found' });
    }
  }

  return NextResponse.json({ files: results });
}
