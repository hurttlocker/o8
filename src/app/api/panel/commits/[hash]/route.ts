export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';

const REPO_ROOT = process.env.CORTEX_IDE_REPO || process.env.CORTEX_IDE_REVIEW_REPO_ROOT || process.cwd();

function resolveRoot(workspace?: string | null) {
  if (!workspace) return REPO_ROOT;
  return workspace.startsWith('~')
    ? workspace.replace('~', homedir())
    : workspace;
}

type CommitStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'unknown';

function mapStatus(code: string | undefined): CommitStatus {
  const prefix = code?.charAt(0) ?? '';
  switch (prefix) {
    case 'A':
      return 'added';
    case 'D':
      return 'deleted';
    case 'R':
      return 'renamed';
    case 'M':
      return 'modified';
    default:
      return 'unknown';
  }
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ hash: string }> },
) {
  const { hash } = await params;
  const { searchParams } = new URL(request.url);
  const root = resolveRoot(searchParams.get('workspace'));

  if (!/^[a-f0-9]{7,40}$/i.test(hash)) {
    return NextResponse.json({ error: 'Invalid commit hash' }, { status: 400 });
  }

  try {
    const meta = execFileSync(
      'git',
      ['log', '-1', '--format=%H%n%s%n%an%n%ae%n%aI%n%b', hash],
      { cwd: root, encoding: 'utf-8', timeout: 5000 },
    ).trim();

    const [fullHash, subject, authorName, authorEmail, dateISO, ...bodyLines] = meta.split('\n');
    const body = bodyLines.join('\n').trim();

    const stat = execFileSync(
      'git',
      ['diff-tree', '--no-commit-id', '--stat', hash],
      { cwd: root, encoding: 'utf-8', timeout: 5000 },
    ).trim();

    const numstat = execFileSync(
      'git',
      ['diff-tree', '--no-commit-id', '--numstat', '-r', hash],
      { cwd: root, encoding: 'utf-8', timeout: 5000 },
    ).trim();

    const statusOutput = execFileSync(
      'git',
      ['diff-tree', '--no-commit-id', '--name-status', '-r', '-M', hash],
      { cwd: root, encoding: 'utf-8', timeout: 5000 },
    ).trim();

    const statusByPath = new Map<string, CommitStatus>();
    statusOutput.split('\n').filter(Boolean).forEach((line) => {
      const parts = line.split('\t');
      if (parts.length < 2) return;
      const status = mapStatus(parts[0]);
      const filePath = parts[parts.length - 1];
      statusByPath.set(filePath, status);
    });

    const files = numstat.split('\n').filter(Boolean).map((line) => {
      const [add, del, ...pathParts] = line.split('\t');
      const filePath = pathParts[pathParts.length - 1] ?? pathParts.join('\t');
      return {
        path: filePath,
        additions: add === '-' ? null : parseInt(add, 10),
        deletions: del === '-' ? null : parseInt(del, 10),
        status: statusByPath.get(filePath) ?? 'unknown',
      };
    });

    let diff = '';
    try {
      diff = execFileSync(
        'git',
        ['diff-tree', '-p', '--no-commit-id', hash],
        { cwd: root, encoding: 'utf-8', timeout: 10000, maxBuffer: 1024 * 1024 },
      );
      if (diff.length > 50000) {
        diff = `${diff.slice(0, 50000)}\n\n... (truncated at 50KB)`;
      }
    } catch {
      diff = '(diff too large or unavailable)';
    }

    const totalAdditions = files.reduce((sum, file) => sum + (file.additions ?? 0), 0);
    const totalDeletions = files.reduce((sum, file) => sum + (file.deletions ?? 0), 0);

    return NextResponse.json({
      commit: {
        hash: fullHash,
        shortHash: fullHash?.slice(0, 7),
        subject,
        body,
        author: authorName,
        email: authorEmail,
        date: dateISO,
        files,
        totalAdditions,
        totalDeletions,
        stat,
        diff,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
