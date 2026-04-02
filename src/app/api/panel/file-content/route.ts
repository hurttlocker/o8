export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import os from 'node:os';
import { existsSync } from 'node:fs';

const DEFAULT_ROOT = process.env.CORTEX_IDE_REVIEW_REPO_ROOT || process.cwd();

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const filePath = searchParams.get('path');
    const workspaceParam = searchParams.get('workspace');

    if (!filePath) {
      return NextResponse.json({ content: null, error: 'path param required' }, { status: 400 });
    }

    const home = process.env.HOME || os.homedir();
    let root = DEFAULT_ROOT;
    if (workspaceParam) {
      root = workspaceParam.startsWith('~') ? workspaceParam.replace('~', home) : workspaceParam;
    }

    const fullPath = join(root, filePath);

    // Basic path traversal protection
    if (!fullPath.startsWith(root)) {
      return NextResponse.json({ content: null, error: 'Path traversal not allowed' }, { status: 403 });
    }

    if (!existsSync(fullPath)) {
      return NextResponse.json({ content: null, error: 'File not found' }, { status: 404 });
    }

    const content = await readFile(fullPath, 'utf-8');
    // Truncate large files
    if (content.length > 100000) {
      return NextResponse.json({
        content: content.slice(0, 100000) + '\n\n... (truncated at 100KB)',
        path: filePath,
        truncated: true,
      });
    }
    return NextResponse.json({ content, path: filePath });
  } catch (error) {
    console.error('[panel/file-content] Could not read file', error);
    return NextResponse.json({ content: null, error: 'Could not read file' }, { status: 500 });
  }
}
