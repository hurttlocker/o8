import { NextResponse, type NextRequest } from 'next/server';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { requirePanelAuth } from '@/lib/panel/auth';
import { resolveRequestPrincipalContext, workerPacketRefusal } from '@/lib/auth/principal';
import { findLatestLaneByPacket, getLane } from '@/lib/lane/registry';
import { readHeadSha } from '@/lib/lane/head-sha-lock';
import { resolvePacketDiffBase } from '@/lib/diff/base-resolution';
import {
  branchUnresolvedPayload,
  LaneBranchUnresolvedError,
  resolveLaneReviewTarget,
} from '@/lib/lane/review-target';

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
  const lane = getLane(id) ?? findLatestLaneByPacket(id);
  if (!lane) {
    return NextResponse.json({ ok: false, note: 'No lane found for that id/packet.' }, { status: 404 });
  }
  const ownershipRefusal = workerPacketRefusal(resolveRequestPrincipalContext(req), lane.packetId);
  if (ownershipRefusal) {
    return NextResponse.json({ ok: false, error: ownershipRefusal }, { status: 403 });
  }

  let cwd: string;
  try {
    cwd = resolveLaneReviewTarget(lane).cwd;
  } catch (error) {
    if (error instanceof LaneBranchUnresolvedError) {
      return NextResponse.json(branchUnresolvedPayload(error), { status: 409 });
    }
    throw error;
  }

  const url = new URL(req.url);
  const requestedMax = parseInt(url.searchParams.get('maxBytes') ?? '', 10);
  const maxBytes = Number.isFinite(requestedMax) && requestedMax > 0
    ? Math.min(requestedMax, MAX_ALLOWED_BYTES)
    : DEFAULT_MAX_BYTES;
  const base = (lane.baseBranch || 'main').trim();

  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const headSha = await readHeadSha(cwd);
      const diffBase = await resolvePacketDiffBase(cwd, base, headSha);
      const against = diffBase.mergeBase ?? diffBase.comparisonRef;

      const [stat, full] = await Promise.all([
        execFileAsync('git', ['diff', '--stat', against], { cwd, maxBuffer: COMMAND_MAX_BUFFER })
          .then((r) => r.stdout).catch(() => ''),
        execFileAsync('git', ['diff', against], { cwd, maxBuffer: COMMAND_MAX_BUFFER })
          .then((r) => r.stdout).catch(() => ''),
      ]);

      const currentHeadSha = await readHeadSha(cwd);
      if (currentHeadSha !== headSha) {
        continue;
      }

      const sizeBytes = Buffer.byteLength(full, 'utf8');
      const truncated = sizeBytes > maxBytes;
      const diff = truncated
        ? `${Buffer.from(full, 'utf8').subarray(0, maxBytes).toString('utf8')}\n\n…[diff truncated at ${maxBytes} bytes of ${sizeBytes} — raise maxBytes or read the file directly]`
        : full;

      return NextResponse.json({
        ok: true,
        laneId: lane.id,
        packetId: lane.packetId ?? null,
        headSha,
        base,
        diffBase,
        branch: lane.branch,
        worktreePath: cwd,
        stat: stat.trim(),
        diff,
        sizeBytes,
        truncated,
        maxBytes,
      }, { headers: { 'Cache-Control': 'no-store, max-age=0' } });
    }

    return NextResponse.json({
      ok: false,
      note: 'Worktree HEAD moved while computing diff. Retry o8_packet_diff before reviewing.',
    }, { status: 409 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to compute diff.';
    return NextResponse.json({ ok: false, note: message }, { status: 500 });
  }
}
