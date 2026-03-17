import { NextResponse } from 'next/server';
import { execSync } from 'child_process';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  let body: { message?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const message = body.message?.trim();
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
    }).trim();

    if (!status) {
      return NextResponse.json({ error: 'No changes to commit' }, { status: 400 });
    }

    // Stage all changes
    execSync('git add -A', { encoding: 'utf-8', timeout: 10000 });

    // Commit with the provided message (use --message flag with array form to avoid injection)
    execSync(`git commit -m ${JSON.stringify(message)}`, {
      encoding: 'utf-8',
      timeout: 15000,
    });

    // Get the commit hash
    const hash = execSync('git rev-parse --short HEAD', {
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();

    return NextResponse.json({ ok: true, hash, message });
  } catch (err) {
    const errMessage = err instanceof Error ? err.message : 'Failed to commit';
    return NextResponse.json({ error: errMessage }, { status: 500 });
  }
}
