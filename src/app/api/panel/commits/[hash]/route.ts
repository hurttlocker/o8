export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { execSync } from 'child_process';

const REPO_ROOT = process.env.CORTEX_IDE_REPO || process.cwd();

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ hash: string }> },
) {
  const { hash } = await params;

  // Validate hash (only hex chars, 7-40 length)
  if (!/^[a-f0-9]{7,40}$/i.test(hash)) {
    return NextResponse.json({ error: 'Invalid commit hash' }, { status: 400 });
  }

  try {
    // Get commit metadata
    const meta = execSync(
      `git log -1 --format='%H%n%s%n%an%n%ae%n%aI%n%b' ${hash}`,
      { cwd: REPO_ROOT, encoding: 'utf-8', timeout: 5000 },
    ).trim();

    const [fullHash, subject, authorName, authorEmail, dateISO, ...bodyLines] = meta.split('\n');
    const body = bodyLines.join('\n').trim();

    // Get stat summary
    const stat = execSync(
      `git diff-tree --no-commit-id --stat ${hash}`,
      { cwd: REPO_ROOT, encoding: 'utf-8', timeout: 5000 },
    ).trim();

    // Get changed files with additions/deletions
    const numstat = execSync(
      `git diff-tree --no-commit-id --numstat -r ${hash}`,
      { cwd: REPO_ROOT, encoding: 'utf-8', timeout: 5000 },
    ).trim();

    const files = numstat.split('\n').filter(Boolean).map((line) => {
      const [add, del, ...pathParts] = line.split('\t');
      const filePath = pathParts.join('\t'); // handle renames with tab
      return {
        path: filePath,
        additions: add === '-' ? null : parseInt(add, 10),
        deletions: del === '-' ? null : parseInt(del, 10),
      };
    });

    // Get the full diff (truncate to 50KB to avoid massive payloads)
    let diff = '';
    try {
      diff = execSync(
        `git diff-tree -p --no-commit-id ${hash}`,
        { cwd: REPO_ROOT, encoding: 'utf-8', timeout: 10000, maxBuffer: 1024 * 1024 },
      );
      if (diff.length > 50000) {
        diff = diff.slice(0, 50000) + '\n\n... (truncated at 50KB)';
      }
    } catch {
      diff = '(diff too large or unavailable)';
    }

    const totalAdditions = files.reduce((sum, f) => sum + (f.additions ?? 0), 0);
    const totalDeletions = files.reduce((sum, f) => sum + (f.deletions ?? 0), 0);

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
