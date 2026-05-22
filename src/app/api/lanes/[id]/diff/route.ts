import { NextResponse, type NextRequest } from 'next/server';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { requirePanelAuth } from '@/lib/panel/auth';
import { findLaneByPacket, getLane } from '@/lib/lane/registry';

const execFileAsync = promisify(execFile);
const COMMAND_MAX_BUFFER = 32 * 1024 * 1024;
const DEFAULT_MAX_BYTES = 64 * 1024;
const MAX_ALLOWED_BYTES = 512 * 1024;

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Read-only diff of a packet's worktree against where it diverged from base —
 * exactly what the lane changed (committed + uncommitted). Byte-bounded so the
 * orchestrator can review without raw shell and without flooding its context.
 * `id` accepts a lane id OR a packet id.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const denied = requirePanelAuth(req);
  if (denied) return denied;

  const { id } = await params;
  const lane = getLane(id) ?? findLaneByPacket(id);
  if (!lane) {
    return NextResponse.json({ ok: false, note: 'No lane found for that id/packet.' }, { status: 404 });
  }

  const cwd = lane.worktreePath ?? lane.repoPath;
  if (!cwd) {
    return NextResponse.json({ ok: false, note: 'Lane has no worktree or repo path.' }, { status: 409 });
  }

  const url = new URL(req.url);
  const requestedMax = parseInt(url.searchParams.get('maxBytes') ?? '', 10);
  const maxBytes = Number.isFinite(requestedMax) && requestedMax > 0
    ? Math.min(requestedMax, MAX_ALLOWED_BYTES)
    : DEFAULT_MAX_BYTES;
  const base = (lane.baseBranch || 'main').trim();

  try {
    // Diff against the merge-base so base advancing doesn't pollute the output
    // with commits the lane didn't make.
    let against = base;
    try {
      const { stdout } = await execFileAsync('git', ['merge-base', base, 'HEAD'], { cwd, maxBuffer: COMMAND_MAX_BUFFER });
      against = stdout.trim() || base;
    } catch {
      // base unresolvable in this worktree — fall back to the base ref name.
    }

    const [stat, full] = await Promise.all([
      execFileAsync('git', ['diff', '--stat', against], { cwd, maxBuffer: COMMAND_MAX_BUFFER })
        .then((r) => r.stdout).catch(() => ''),
      execFileAsync('git', ['diff', against], { cwd, maxBuffer: COMMAND_MAX_BUFFER })
        .then((r) => r.stdout).catch(() => ''),
    ]);

    const sizeBytes = Buffer.byteLength(full, 'utf8');
    const truncated = sizeBytes > maxBytes;
    const diff = truncated
      ? `${Buffer.from(full, 'utf8').subarray(0, maxBytes).toString('utf8')}\n\n…[diff truncated at ${maxBytes} bytes of ${sizeBytes} — raise maxBytes or read the file directly]`
      : full;

    return NextResponse.json({
      ok: true,
      laneId: lane.id,
      packetId: lane.packetId ?? null,
      base,
      branch: lane.branch,
      worktreePath: lane.worktreePath ?? null,
      stat: stat.trim(),
      diff,
      sizeBytes,
      truncated,
      maxBytes,
    }, { headers: { 'Cache-Control': 'no-store, max-age=0' } });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to compute diff.';
    return NextResponse.json({ ok: false, note: message }, { status: 500 });
  }
}
