export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { execSync } from 'child_process';
import { readdir } from 'node:fs/promises';
import path from 'node:path';

// No process.cwd() fallback on purpose — the server runs from wherever Node
// was started (dev repo, Tauri bundled dir, etc) and that has nothing to do
// with the user's workspace. Callers must pass ?workspace=<absolute path>.
// The CORTEX_IDE_REVIEW_REPO_ROOT env stays as an explicit dev/CI override.
const DEFAULT_ROOT = process.env.CORTEX_IDE_REVIEW_REPO_ROOT || null;
const IGNORE = new Set(['node_modules', '.next', '.turbo', 'target', 'dist', '.DS_Store', '.pnpm-store', '.cache']);

// Response cache — file tree doesn't change every second
const filesCache = new Map<string, { data: unknown; ts: number }>();
const FILES_CACHE_TTL_MS = 15_000;
const MAX_DEPTH = 3;
// Dotfiles/dirs to show (everything else starting with . is hidden)
const SHOW_DOT = new Set([
  '.github', '.vscode', '.claude', '.cursor', '.cortexrules', '.cursorrules', '.clinerules',
  '.env', '.env.local', '.env.example', '.env.development', '.env.production', '.env.test',
  '.gitignore', '.gitattributes', '.npmrc', '.nvmrc', '.node-version',
  '.eslintrc', '.eslintrc.js', '.eslintrc.json', '.prettierrc', '.prettierrc.js',
  '.editorconfig', '.dockerignore', '.tool-versions', 'CLAUDE.md', 'AGENTS.md',
]);

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
      .filter(e => !IGNORE.has(e.name) && (!e.name.startsWith('.') || SHOW_DOT.has(e.name)))
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

function getChangedFiles(root: string): Set<string> {
  try {
    const output = execSync('git status --porcelain', {
      windowsHide: true,
      cwd: root,
      encoding: 'utf-8',
      timeout: 5000,
    });
    const changed = new Set<string>();
    for (const line of output.split('\n')) {
      // Format: "XY path" or "XY path -> renamed"
      const filePath = line.slice(3).split(' -> ')[0]?.trim();
      if (filePath) changed.add(filePath);
    }
    return changed;
  } catch {
    return new Set();
  }
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const workspaceParam = searchParams.get('workspace');

  let root: string | null = DEFAULT_ROOT;
  if (workspaceParam) {
    const home = process.env.HOME || require('os').homedir();
    root = workspaceParam.startsWith('~') ? workspaceParam.replace('~', home) : workspaceParam;
  }

  // No workspace → return an empty tree instead of silently leaking
  // whatever repo the server process happens to be sitting in.
  if (!root) {
    return NextResponse.json({ tree: [], root: null, changedFiles: [] });
  }

  // Return cached if fresh
  const cached = filesCache.get(root);
  if (cached && (Date.now() - cached.ts) < FILES_CACHE_TTL_MS) {
    return NextResponse.json(cached.data);
  }

  const tree = await buildTree(root, '', 0);
  const changedFiles = Array.from(getChangedFiles(root));
  const result = { tree, root, changedFiles };
  filesCache.set(root, { data: result, ts: Date.now() });
  return NextResponse.json(result);
}
