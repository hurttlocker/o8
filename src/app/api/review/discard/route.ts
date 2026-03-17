import { NextResponse } from 'next/server';
import { execSync } from 'child_process';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  let body: { path?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const filePath = body.path?.trim();
  if (!filePath) {
    return NextResponse.json({ error: 'File path is required' }, { status: 400 });
  }

  // Prevent path traversal
  if (filePath.includes('..') || filePath.startsWith('/')) {
    return NextResponse.json({ error: 'Invalid file path' }, { status: 400 });
  }

  try {
    // Check if file is untracked (needs rm) vs modified (needs checkout)
    const statusOutput = execSync(`git status --porcelain -- ${JSON.stringify(filePath)}`, {
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();

    if (!statusOutput) {
      return NextResponse.json({ error: 'File has no changes to discard' }, { status: 400 });
    }

    const statusCode = statusOutput.substring(0, 2).trim();

    if (statusCode === '??' || statusCode === 'A') {
      // Untracked or newly added — remove from index and working tree
      execSync(`git clean -f -- ${JSON.stringify(filePath)}`, {
        encoding: 'utf-8',
        timeout: 5000,
      });
    } else {
      // Modified/deleted — restore from HEAD
      execSync(`git checkout HEAD -- ${JSON.stringify(filePath)}`, {
        encoding: 'utf-8',
        timeout: 5000,
      });
    }

    return NextResponse.json({ ok: true, discarded: filePath });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to discard changes';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
