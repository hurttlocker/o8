import { execFile } from 'node:child_process';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { listRepos } from '@/lib/repos/registry';
import type { SearchResult } from '@/lib/search/types';

const HOME = process.env.HOME || os.homedir();
const execFileAsync = promisify(execFile);

interface FileSearchRoot {
  localPath: string;
  repoName: string | null;
}

function safeRoot(workspace: string): string {
  return workspace.startsWith('~') ? workspace.replace('~', HOME) : workspace;
}

function sanitizeFilenameNeedle(query: string): string {
  return query
    .replace(/[\\/'"`*?\[\]{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function searchFilesInRoot(query: string, root: FileSearchRoot): Promise<SearchResult[]> {
  const needle = sanitizeFilenameNeedle(query);
  if (!needle) return [];

  try {
    const { stdout } = await execFileAsync(
      'find',
      [
        '.', '-maxdepth', '5',
        '(',
        '-path', '*/.git',
        '-o', '-path', '*/node_modules',
        '-o', '-path', '*/.next',
        '-o', '-path', '*/target',
        '-o', '-path', '*/dist',
        '-o', '-path', '*/out',
        '-o', '-path', '*/build',
        '-o', '-path', '*/.cortex-worktrees',
        '-o', '-path', '*/.agents',
        '-o', '-path', '*/.codex',
        '-o', '-path', '*/.claude/worktrees',
        ')', '-prune', '-o',
        '-type', 'f',
        '(', '-iname', `*${needle}*`, '-o', '-ipath', `*${needle}*`, ')',
        '-print',
      ],
      {
        cwd: root.localPath,
        encoding: 'utf-8',
        timeout: 2_500,
        maxBuffer: 1024 * 1024,
      },
    );

    return stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map<SearchResult>((line, index) => {
        const cleaned = line.startsWith('./') ? line.slice(2) : line;
        const filename = cleaned.split('/').pop() ?? cleaned;
        const lowered = needle.toLowerCase();
        const pathParts = cleaned.split('/');
        const exact = filename.toLowerCase() === lowered ? 60 : 0;
        const starts = filename.toLowerCase().startsWith(lowered) ? 25 : 0;
        const directoryMatch = dirname(cleaned).toLowerCase().includes(lowered) ? 30 : 0;
        const exactDirectoryMatch = pathParts
          .slice(0, -1)
          .some((part) => part.toLowerCase() === lowered) ? 20 : 0;
        const detail = root.repoName ? `${root.repoName} · ${cleaned}` : cleaned;
        return {
          kind: 'file',
          id: `file:${root.localPath}:${cleaned}`,
          title: filename,
          detail,
          target: { filePath: root.repoName ? join(root.localPath, cleaned) : cleaned },
          score: 50 + exact + starts + directoryMatch + exactDirectoryMatch
            - (pathParts.length / 10) - (index / 10_000),
        };
      })
      .sort((left, right) => right.score - left.score)
      .slice(0, 10);
  } catch {
    return [];
  }
}

export async function searchFiles(query: string, workspace: string | null): Promise<SearchResult[]> {
  const roots: FileSearchRoot[] = workspace
    ? [{ localPath: safeRoot(workspace), repoName: null }]
    : (await listRepos().catch(() => [])).slice(0, 3).map((repo) => ({
        localPath: repo.localPath,
        repoName: repo.name,
      }));
  if (roots.length === 0) return [];

  const matches = await Promise.all(roots.map((root) => searchFilesInRoot(query, root)));
  return matches.flat().sort((left, right) => right.score - left.score).slice(0, 10);
}
