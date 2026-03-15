export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_ROOT = process.env.CORTEX_IDE_REVIEW_REPO_ROOT || '/Users/marquisehurtt/clawd/repos/cortex-ide';
const IGNORE = new Set(['.git', 'node_modules', '.next', '.turbo', 'target', 'dist', '.DS_Store']);
const MAX_DEPTH = 3;

interface FileNode {
  name: string;
  path: string;
  type: 'file' | 'dir';
  children?: FileNode[];
}

async function buildTree(dir: string, relPath: string, depth: number): Promise<FileNode[]> {
  if (depth > MAX_DEPTH) return [];

  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const nodes: FileNode[] = [];

    // Sort: dirs first, then files, alphabetical
    const sorted = entries
      .filter(e => !IGNORE.has(e.name) && !e.name.startsWith('.'))
      .sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

    for (const entry of sorted) {
      const entryPath = path.join(relPath, entry.name);

      if (entry.isDirectory()) {
        const children = await buildTree(path.join(dir, entry.name), entryPath, depth + 1);
        nodes.push({ name: entry.name, path: entryPath, type: 'dir', children });
      } else {
        nodes.push({ name: entry.name, path: entryPath, type: 'file' });
      }
    }

    return nodes;
  } catch {
    return [];
  }
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const workspaceParam = searchParams.get('workspace');

  let root = DEFAULT_ROOT;
  if (workspaceParam) {
    const home = process.env.HOME || '/Users/marquisehurtt';
    root = workspaceParam.startsWith('~') ? workspaceParam.replace('~', home) : workspaceParam;
  }

  const tree = await buildTree(root, '', 0);
  return NextResponse.json({ tree, root });
}
