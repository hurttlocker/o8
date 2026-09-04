/**
 * `o8 status` — top-level snapshot: running packets, active lanes, recent
 * merges, pending approvals.
 *
 * Strict no-new-endpoints: pulls from /api/lanes (active=true + active=false)
 * and /api/panel/approvals. Recent merges are completed lanes ordered by
 * updatedAt desc.
 */

import { apiFetch } from '../api.js';
import { resolveConfig } from '../config.js';
import {
  color,
  printHumanHeading,
  printJson,
  type OutputMode,
} from '../output.js';

interface Lane {
  id: string;
  label: string;
  status: string;
  runtime: string;
  branch: string;
  baseBranch: string;
  repoPath: string;
  worktreePath: string | null;
  packetId: string | null;
  updatedAt: string;
  lastEventAt: string | null;
  lastEventLabel: string | null;
  lastTranscriptAt?: string | null;
  transcriptFault?: { code?: string; stalledForMs?: number | null } | null;
}

interface Approval {
  id: string;
  status: string;
  kind?: string;
  summary?: string;
  packetId?: string | null;
  laneId?: string | null;
  createdAt?: string;
}

interface MissionStatusPacket {
  id: string;
  title?: string;
  status?: string;
  blockedReason?: string | null;
  storageAdmission?: {
    state?: string;
    reason?: string;
    recordedAt?: number;
    estimateBytes?: number;
    physicalAvailableBytes?: number | null;
    requiredReserveBytes?: number | null;
  } | null;
}

interface MissionStatusResponse {
  ok: boolean;
  result?: { packets?: MissionStatusPacket[] };
}

interface ShippedDarkFlagStatus {
  tomlKey: string;
  landedRelease: string | null;
  darkForReleases: number | null;
  /** Absent on older servers; an unclassified flag stays a promotion candidate. */
  lifecycle?: 'promotion-candidate' | 'deliberate-default-off' | 'promoted';
  lifecycleRationale?: string | null;
  needsAttention?: boolean;
}

interface PanelStatusResponse {
  shippedDarkAudit?: {
    status?: string;
    checkedAt?: string;
    currentRelease?: string | null;
    thresholdReleases?: number;
    checkedFlagCount?: number;
    attentionFlagCount?: number;
    flags?: ShippedDarkFlagStatus[];
  };
}

/** How a dark flag reads to the operator: warning, deliberate, or still young. */
function dispositionLabel(flag: ShippedDarkFlagStatus, isWarning: boolean): string {
  if (isWarning) return 'awaiting promotion review';
  if (flag.lifecycle === 'deliberate-default-off') {
    return `by design${flag.lifecycleRationale ? `: ${flag.lifecycleRationale}` : ''}`;
  }
  if (flag.lifecycle === 'promoted') return 'promoted';
  return 'awaiting promotion review (under threshold)';
}

const RUNNING_STATUSES = new Set([
  'running',
  'launching',
  'reviewing',
  'awaiting_input',
  'merging',
]);

export async function runStatus(mode: OutputMode): Promise<number> {
  const cfg = resolveConfig();

  const [activeRes, allRes, approvalsRes, missionRes, panelStatusRes] = await Promise.all([
    apiFetch<{ lanes: Lane[] }>(cfg, '/api/lanes', { query: { active: 'true' } }),
    apiFetch<{ lanes: Lane[] }>(cfg, '/api/lanes', { query: { active: 'false' } }),
    apiFetch<{ approvals: Approval[] }>(cfg, '/api/panel/approvals', { query: { status: 'pending' } }),
    apiFetch<MissionStatusResponse>(cfg, '/api/orchestrator/status', { allowNotFound: true }),
    apiFetch<PanelStatusResponse>(cfg, '/api/panel/status', { allowNotFound: true }),
  ]);

  const activeLanes = activeRes.data?.lanes ?? [];
  const allLanes = allRes.data?.lanes ?? [];
  const approvals = approvalsRes.data?.approvals ?? [];
  const storageHolds = (missionRes.data?.result?.packets ?? [])
    .filter((packet) => packet.storageAdmission?.state === 'held')
    .map((packet) => ({
      packetId: packet.id,
      title: packet.title ?? '',
      status: packet.status ?? 'queued',
      reason: packet.blockedReason ?? packet.storageAdmission?.reason ?? 'Storage admission held dispatch.',
      recordedAt: packet.storageAdmission?.recordedAt ?? null,
      estimateBytes: packet.storageAdmission?.estimateBytes ?? null,
      physicalAvailableBytes: packet.storageAdmission?.physicalAvailableBytes ?? null,
      requiredReserveBytes: packet.storageAdmission?.requiredReserveBytes ?? null,
    }));
  const shippedDarkAudit = panelStatusRes.data?.shippedDarkAudit ?? null;
  // Deliberate default-off flags stay in `shippedDarkAudit` for the operator to
  // read; only unreviewed promotion candidates age into a warning.
  const shippedDarkFlags = shippedDarkAudit?.flags ?? [];
  const shippedDarkWarnings = shippedDarkFlags
    .filter((flag) => (
      // The v2 server already decided this; only older payloads need the
      // lifecycle + age recomputation below.
      typeof flag.needsAttention === 'boolean'
        ? flag.needsAttention
        : (flag.lifecycle ?? 'promotion-candidate') === 'promotion-candidate'
          && typeof flag.darkForReleases === 'number'
          && typeof shippedDarkAudit?.thresholdReleases === 'number'
          && flag.darkForReleases >= shippedDarkAudit.thresholdReleases
    ));
  const shippedDarkByDesign = shippedDarkFlags
    .filter((flag) => flag.lifecycle === 'deliberate-default-off');

  const running = activeLanes.filter((l) => RUNNING_STATUSES.has(l.status));
  // Review packets remain active but are not always included in an upstream
  // running summary. Read the full lane set so a packet that needs an operator
  // decision cannot disappear behind a zero-count status snapshot.
  const awaitingReview = allLanes.filter((l) => l.status === 'reviewing');
  const recentMerges = allLanes
    .filter((l) => l.status === 'completed')
    .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
    .slice(0, 10);

  // Bound the lane arrays so a worktree storm can't flood an agent piping
  // `o8 status` JSON in. counts.* still report the true totals.
  const LANE_CAP = 50;
  const payload = {
    schema: 'o8/cli/status/v1',
    counts: {
      runningPackets: running.length,
      awaitingReview: awaitingReview.length,
      activeLanes: activeLanes.length,
      recentMerges: recentMerges.length,
      pendingApprovals: approvals.length,
      storageHolds: storageHolds.length,
      shippedDarkWarnings: shippedDarkWarnings.length,
    },
    activeLanesTruncated: activeLanes.length > LANE_CAP,
    awaitingReviewTruncated: awaitingReview.length > LANE_CAP,
    runningPackets: running.slice(0, LANE_CAP).map(summarizeLane),
    awaitingReview: awaitingReview.slice(0, LANE_CAP).map(summarizeLane),
    activeLanes: activeLanes.slice(0, LANE_CAP).map(summarizeLane),
    recentMerges: recentMerges.map(summarizeLane),
    pendingApprovals: approvals.map((a) => ({
      id: a.id,
      status: a.status,
      kind: a.kind ?? null,
      summary: a.summary ?? null,
      packetId: a.packetId ?? null,
      laneId: a.laneId ?? null,
      createdAt: a.createdAt ?? null,
    })),
    storageHolds,
    shippedDarkAudit,
    shippedDarkWarnings,
    shippedDarkByDesign,
  };

  if (mode.human) {
    printHumanHeading(`o8 status (${cfg.apiBase})`);
    process.stdout.write(
        `  running ${color(String(running.length), 'green')}` +
        `   review ${color(String(awaitingReview.length), 'yellow')}` +
        `   active ${activeLanes.length}` +
        `   merges ${recentMerges.length}` +
        `   approvals ${color(String(approvals.length), 'yellow')}` +
        `   storage holds ${color(String(storageHolds.length), 'yellow')}` +
        `   dark flags ${color(String(shippedDarkWarnings.length), 'yellow')}\n`,
    );
    if (running.length > 0) {
      printHumanHeading('running');
      for (const l of running) process.stdout.write(formatLaneLine(l));
    }
    if (awaitingReview.length > 0) {
      printHumanHeading('awaiting review');
      for (const l of awaitingReview) process.stdout.write(formatLaneLine(l));
    }
    if (recentMerges.length > 0) {
      printHumanHeading('recent merges');
      for (const l of recentMerges) process.stdout.write(formatLaneLine(l));
    }
    if (approvals.length > 0) {
      printHumanHeading('pending approvals');
      for (const a of approvals) {
        process.stdout.write(
          `  ${a.id.padEnd(28)} ${a.kind ?? '?'}  ${a.summary ?? ''}\n`,
        );
      }
    }
    if (storageHolds.length > 0) {
      printHumanHeading('storage holds');
      for (const hold of storageHolds) {
        process.stdout.write(`  ${hold.status.padEnd(15)} ${hold.packetId.padEnd(28)} ${hold.reason}\n`);
      }
    }
    if (shippedDarkFlags.length > 0) {
      printHumanHeading('shipped but dark');
      for (const flag of shippedDarkFlags) {
        const age = flag.darkForReleases === 1 ? '1 release' : `${flag.darkForReleases} releases`;
        process.stdout.write(
          `  ${flag.tomlKey.padEnd(42)} ${age}  landed ${flag.landedRelease ?? 'unknown'}  ${dispositionLabel(flag, shippedDarkWarnings.includes(flag))}\n`,
        );
      }
    }
  } else {
    printJson(payload);
  }

  return 0;
}

function summarizeLane(l: Lane) {
  return {
    id: l.id,
    packetId: l.packetId,
    status: l.status,
    runtime: l.runtime,
    label: l.label,
    branch: l.branch,
    baseBranch: l.baseBranch,
    repoPath: l.repoPath,
    worktreePath: l.worktreePath,
    updatedAt: l.updatedAt,
    lastEventAt: l.lastEventAt,
    lastEventLabel: l.lastEventLabel,
    lastTranscriptAt: l.lastTranscriptAt ?? null,
    transcriptFault: l.transcriptFault ?? null,
  };
}

function formatLaneLine(l: Lane): string {
  const status = l.status.padEnd(15);
  const id = (l.packetId ?? l.id).padEnd(28);
  const fault = l.transcriptFault?.code === 'transcript_stalled' ? '  [transcript stalled]' : '';
  return `  ${status} ${id} ${l.label}${fault}\n`;
}
