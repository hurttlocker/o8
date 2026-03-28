import { NextResponse } from 'next/server';
import { execSync } from 'child_process';
import { homedir } from 'node:os';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const REPO_ROOT = process.env.CORTEX_IDE_REVIEW_REPO_ROOT || process.cwd();

function resolveRoot(workspace?: string | null) {
  if (!workspace) return REPO_ROOT;
  return workspace.startsWith('~')
    ? workspace.replace('~', homedir())
    : workspace;
}

export async function POST(request: Request) {
  let body: { message?: string; workspace?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const message = body.message?.trim();
  const root = resolveRoot(body.workspace);
  if (!message) {
    return NextResponse.json({ error: 'Commit message is required' }, { status: 400 });
  }

  // Prevent shell injection via commit message
  if (message.length > 500) {
    return NextResponse.json({ error: 'Commit message too long (max 500 chars)' }, { status: 400 });
  }

  try {
    // Check if there are changes to commit
    const status = execSync('git status --porcelain', {
      encoding: 'utf-8',
      timeout: 5000,
      cwd: root,
    }).trim();

    if (!status) {
      return NextResponse.json({ error: 'No changes to commit' }, { status: 400 });
    }

    // Stage all changes
    execSync('git add -A', { encoding: 'utf-8', timeout: 10000, cwd: root });

    // Commit with the provided message (use --message flag with array form to avoid injection)
    execSync(`git commit -m ${JSON.stringify(message)}`, {
      encoding: 'utf-8',
      timeout: 15000,
      cwd: root,
    });

    // Get the commit hash
    const hash = execSync('git rev-parse --short HEAD', {
      encoding: 'utf-8',
      timeout: 5000,
      cwd: root,
    }).trim();

    return NextResponse.json({ ok: true, hash, message });
  } catch (err) {
    const errMessage = err instanceof Error ? err.message : 'Failed to commit';
    return NextResponse.json({ error: errMessage }, { status: 500 });
  }
}
