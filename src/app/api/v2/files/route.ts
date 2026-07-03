/**
 * POST /api/v2/files — Write/edit files in the workspace
 * GET /api/v2/files?path=... — Read a file
 *
 * Used by LLM Chat "Apply to File" feature.
 */

export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { getDefaultLlmRepoRoot, resolveRegisteredRepoScope } from '@/lib/llm/repo-scope';
import {
  ABSOLUTE_PATH_NOT_ALLOWLISTED,
  resolveAllowedOperatorConfigPath,
  resolveRepoRelativeFilePath,
} from '@/lib/files/operator-config-docs';

async function resolveRoot(workspace?: string | null) {
  if (!workspace) return getDefaultLlmRepoRoot();

  const requestedPath = workspace.startsWith('~')
    ? workspace.replace('~', homedir())
    : workspace;

  const { repoRoot } = await resolveRegisteredRepoScope(requestedPath);
  return repoRoot;
}

async function resolveFileTarget(filePath: string, workspace?: string | null) {
  if (isAbsolute(filePath)) {
    const resolved = resolveAllowedOperatorConfigPath(filePath);
    if (!resolved) {
      return {
        error: 'Absolute path is not allowlisted',
        code: ABSOLUTE_PATH_NOT_ALLOWLISTED,
        status: 400,
      } as const;
    }
    return { resolved } as const;
  }

  const root = await resolveRoot(workspace);
  if (!root) {
    return {
      error: 'Workspace is not registered',
      code: 'workspace_not_registered',
      status: 400,
    } as const;
  }

  const resolved = resolveRepoRelativeFilePath(root, filePath);
  if (!resolved) {
    return {
      error: 'Path outside repository',
      code: 'path_outside_repository',
      status: 400,
    } as const;
  }

  return { resolved } as const;
}

export async function GET(request: NextRequest) {
  const path = request.nextUrl.searchParams.get('path');
  if (!path) {
    return NextResponse.json({ error: 'path required' }, { status: 400 });
  }

  const target = await resolveFileTarget(path, request.nextUrl.searchParams.get('workspace'));
  if ('error' in target) {
    return NextResponse.json({ error: target.error, code: target.code }, { status: target.status });
  }

  if (!existsSync(target.resolved)) {
    return NextResponse.json({ error: 'File not found', exists: false }, { status: 404 });
  }

  try {
    const content = readFileSync(target.resolved, 'utf-8');
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

    const target = await resolveFileTarget(path, workspace);
    if ('error' in target) {
      return NextResponse.json({ error: target.error, code: target.code }, { status: target.status });
    }

    // Read existing content for diff
    let oldContent: string | null = null;
    if (existsSync(target.resolved)) {
      oldContent = readFileSync(target.resolved, 'utf-8');
    }

    // Ensure directory exists
    const dir = dirname(target.resolved);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    writeFileSync(target.resolved, content, 'utf-8');

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
