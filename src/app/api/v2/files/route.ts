/**
 * POST /api/v2/files — Write/edit files in the workspace
 * GET /api/v2/files?path=... — Read a file
 *
 * Used by LLM Chat "Apply to File" feature.
 */

export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { relative, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { getDefaultLlmRepoRoot, resolveRegisteredRepoScope } from '@/lib/llm/repo-scope';

async function resolveRoot(workspace?: string | null) {
  if (!workspace) return getDefaultLlmRepoRoot();

  const requestedPath = workspace.startsWith('~')
    ? workspace.replace('~', homedir())
    : workspace;

  const { repoRoot } = await resolveRegisteredRepoScope(requestedPath);
  return repoRoot;
}

function safePath(root: string, path: string): string | null {
  const resolved = resolve(root, path);
  const rel = relative(root, resolved);
  if (rel.startsWith('..') || rel.startsWith('/')) return null;
  return resolved;
}

export async function GET(request: NextRequest) {
  const path = request.nextUrl.searchParams.get('path');
  if (!path) {
    return NextResponse.json({ error: 'path required' }, { status: 400 });
  }

  const root = await resolveRoot(request.nextUrl.searchParams.get('workspace'));
  if (!root) {
    return NextResponse.json({ error: 'Workspace is not registered' }, { status: 400 });
  }

  const resolved = safePath(root, path);
  if (!resolved) {
    return NextResponse.json({ error: 'Path outside repository' }, { status: 400 });
  }

  if (!existsSync(resolved)) {
    return NextResponse.json({ error: 'File not found', exists: false }, { status: 404 });
  }

  try {
    const content = readFileSync(resolved, 'utf-8');
    return NextResponse.json({ content, path, exists: true });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { path, content, workspace } = body as { path: string; content: string; workspace?: string };

    if (!path || content === undefined) {
      return NextResponse.json({ error: 'path and content required' }, { status: 400 });
    }

    const root = await resolveRoot(workspace);
    if (!root) {
      return NextResponse.json({ error: 'Workspace is not registered' }, { status: 400 });
    }
    const resolved = safePath(root, path);
    if (!resolved) {
      return NextResponse.json({ error: 'Path outside repository' }, { status: 400 });
    }

    // Read existing content for diff
    let oldContent: string | null = null;
    if (existsSync(resolved)) {
      oldContent = readFileSync(resolved, 'utf-8');
    }

    // Ensure directory exists
    const dir = dirname(resolved);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    writeFileSync(resolved, content, 'utf-8');

    return NextResponse.json({
      success: true,
      path,
      isNew: oldContent === null,
      oldContent,
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
