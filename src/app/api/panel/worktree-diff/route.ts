export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { execFileSync } from 'child_process';
import os from 'os';

/**
 * Working-tree diff for a repo — "what have I changed" as one payload,
 * shaped like the lane diff route so the canvas diff card renders either
 * source unchanged: { ok, branch, stat, diff, truncated }.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const workspaceParam = searchParams.get('workspace') ?? searchParams.get('repoPath');
  const maxBytes = Math.min(512 * 1024, Math.max(16 * 1024, Number(searchParams.get('maxBytes')) || 131_072));
  if (!workspaceParam) {
    return NextResponse.json({ ok: false, error: 'workspace param required' }, { status: 400 });
  }
  const root = workspaceParam.startsWith('~') ? workspaceParam.replace('~', os.homedir()) : workspaceParam;
  try {
    const stat = execFileSync('git', ['diff', '--no-color', '--stat', 'HEAD'], {
      cwd: root, encoding: 'utf-8', timeout: 8000, maxBuffer: 1024 * 1024,
    });
    let diff = execFileSync('git', ['diff', '--no-color', 'HEAD'], {
      cwd: root, encoding: 'utf-8', timeout: 8000, maxBuffer: 4 * 1024 * 1024,
    });
    let branch = '';
    try {
      branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root, encoding: 'utf-8', timeout: 3000 }).trim();
    } catch {
      // detached/fresh repo — branch stays blank
    }
    const truncated = Buffer.byteLength(diff, 'utf-8') > maxBytes;
    if (truncated) diff = diff.slice(0, maxBytes);
    return NextResponse.json({ ok: true, branch, stat: stat.trim(), diff, truncated });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : 'git diff failed' });
  }
}
