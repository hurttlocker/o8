export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { execFile, execSync, spawn } from 'child_process';
import type { Dirent } from 'node:fs';
import { readdir, realpath } from 'node:fs/promises';
import path from 'node:path';

// No process.cwd() fallback on purpose — the server runs from wherever Node
// was started (dev repo, Tauri bundled dir, etc) and that has nothing to do
// with the user's workspace. Callers must pass ?workspace=<absolute path>.
// The CORTEX_IDE_REVIEW_REPO_ROOT env stays as an explicit dev/CI override.
const DEFAULT_ROOT = process.env.CORTEX_IDE_REVIEW_REPO_ROOT || null;
const IGNORE = new Set(['.git', 'node_modules', '.next', '.turbo', 'target', 'dist', '.DS_Store', '.pnpm-store', '.cache']);

// Response cache — file tree doesn't change every second
const filesCache = new Map<string, { data: unknown; ts: number }>();
const FILES_CACHE_TTL_MS = 15_000;
const MAX_DEPTH = 3;
const MAX_FLAT_FILES = 20_000;
const MAX_SEARCH_RESULTS = 500;
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

interface DirectoryEntry {
  name: string;
  path: string;
  kind: 'file' | 'directory';
  ignored?: boolean;
}

function isVisible(name: string, isDirectory: boolean): boolean {
  return !name.startsWith('.') || SHOW_DOT.has(name) || (isDirectory && IGNORE.has(name));
}

function sortEntries<T extends { name: string; isDirectory: () => boolean }>(entries: T[]): T[] {
  return entries.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

function resolveDirectory(root: string, directory: string): string | null {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, directory || '.');
  const relative = path.relative(resolvedRoot, target);
  if (relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))) return target;
  return null;
}

async function listDirectory(root: string, directory: string): Promise<DirectoryEntry[]> {
  const target = resolveDirectory(root, directory);
  if (!target) throw new Error('directory_outside_workspace');
  const [realRoot, realTarget] = await Promise.all([realpath(root), realpath(target)]);
  if (!resolveDirectory(realRoot, path.relative(realRoot, realTarget))) throw new Error('directory_outside_workspace');
  const entries = sortEntries(await readdir(target, { withFileTypes: true }));
  const visible = entries.flatMap((entry) => {
    // Git internals stay out of the explorer. Other dotfiles and ignored
    // folders remain discoverable; their names are dimmed, not removed.
    if ((!entry.isDirectory() && !entry.isFile()) || entry.name === '.git') return [];
    const entryPath = path.join(directory, entry.name);
    const ignored = IGNORE.has(entry.name);
    return [{
      name: entry.name,
      path: entryPath,
      kind: entry.isDirectory() ? 'directory' as const : 'file' as const,
      ...(ignored ? { ignored: true } : {}),
    }];
  });
  const ignored = await ignoredPaths(root, visible.map(entry => entry.path));
  return visible.map(entry => ignored.has(entry.path) ? { ...entry, ignored: true } : entry);
}

/** NUL-delimited stdin avoids shell interpretation and argument-size limits. */
function ignoredPaths(root: string, paths: string[]): Promise<Set<string>> {
  if (!paths.length) return Promise.resolve(new Set());
  return new Promise(resolve => {
    const child = spawn('git', ['check-ignore', '--no-index', '-z', '--stdin'], { cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    let output = '';
    const timer = setTimeout(() => { child.kill(); }, 2000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      output += chunk;
      if (output.length > 4_000_000) child.kill();
    });
    child.stdin.on('error', () => { /* A non-Git workspace may exit before consuming stdin. */ });
    child.once('error', () => { clearTimeout(timer); resolve(new Set()); });
    child.once('close', code => { clearTimeout(timer); resolve(code === 0 ? new Set(output.split('\0').filter(Boolean)) : new Set()); });
    child.stdin.end(`${paths.join('\0')}\0`);
  });
}

/** Git supplies a fast project-wide index without descending into dependency trees. */
async function searchFiles(root: string, query: string) {
  let paths: string[];
  try {
    paths = await new Promise<string[]>((resolve, reject) => {
      execFile('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, windowsHide: true, timeout: 2000, maxBuffer: 4_000_000 }, (error, stdout) => {
        if (error) reject(error);
        else resolve([...new Set(stdout.split('\0').filter(Boolean))]);
      });
    });
  } catch {
    paths = (await listFiles(root)).map(entry => entry.path);
  }
  const terms = query.toLowerCase().trim().split(/\s+/);
  const matches = paths.filter(file => terms.every(term => file.toLowerCase().includes(term)));
  return { entries: matches.slice(0, MAX_SEARCH_RESULTS).map(file => ({ name: path.basename(file), path: file, kind: 'file' as const })), truncated: matches.length > MAX_SEARCH_RESULTS };
}

async function listFiles(root: string): Promise<DirectoryEntry[]> {
  const files: DirectoryEntry[] = [];
  const pending = [''];
  while (pending.length > 0 && files.length < MAX_FLAT_FILES) {
    const directory = pending.shift() ?? '';
    const target = resolveDirectory(root, directory);
    if (!target) continue;
    let entries: Dirent[];
    try {
      entries = sortEntries(await readdir(target, { withFileTypes: true }));
    } catch {
      continue;
    }
    for (const entry of entries) {
      if ((!entry.isDirectory() && !entry.isFile()) || !isVisible(entry.name, entry.isDirectory())) continue;
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORE.has(entry.name)) pending.push(entryPath);
      } else {
        files.push({ name: entry.name, path: entryPath, kind: 'file' });
        if (files.length >= MAX_FLAT_FILES) break;
      }
    }
  }
  return files;
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

  if (searchParams.has('search')) {
    const query = (searchParams.get('search') ?? '').trim().slice(0, 256);
    try {
      return NextResponse.json(query ? await searchFiles(root, query) : { entries: [], truncated: false });
    } catch {
      return NextResponse.json({ error: 'File search failed', code: 'file_search_failed' }, { status: 500 });
    }
  }

  if (searchParams.has('directory')) {
    const directory = searchParams.get('directory') ?? '';
    try {
      return NextResponse.json({ entries: await listDirectory(root, directory), directory, root });
    } catch (error) {
      const outside = error instanceof Error && error.message === 'directory_outside_workspace';
      return NextResponse.json({
        error: outside ? 'Directory outside workspace' : 'Directory listing failed',
        code: outside ? 'directory_outside_workspace' : 'directory_listing_failed',
      }, { status: outside ? 400 : 500 });
    }
  }

  if (searchParams.get('recursive') === 'files') {
    try {
      const entries = await listFiles(root);
      return NextResponse.json({ entries, root, truncated: entries.length >= MAX_FLAT_FILES });
    } catch {
      return NextResponse.json({ error: 'File listing failed', code: 'file_listing_failed' }, { status: 500 });
    }
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
