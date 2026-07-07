/**
 * Orchestrator status events — the structured payload behind OrchestratorStatusCard.
 *
 * These describe orchestrator lifecycle moments the operator should see in the
 * chat: a mission completing, a packet merging, a lane self-healing (or failing
 * to). The card renders a one-line summary; the detail modal renders the full
 * story (so "the user knows what happened").
 *
 * Two producers feed this:
 *  - `detectOrchestratorStatusEvent(text)` — reads a system message's text and
 *    recognizes the new human line AND legacy all-caps tokens, so old threads
 *    upgrade in place (no migration).
 *  - `deriveLaneStatusEvent(...)` — turns an `o8:lane-lifecycle` realtime event
 *    into a merge / heal status event, client-side (see useOrchestratorStatusFeed).
 */

/** Lightweight per-packet identity carried on a mission-complete event, so the
 *  detail modal can lazily fetch each packet's ledger summary (kept small —
 *  the heavy session_outcomes lookup + AI prose happen server-side on click). */
export interface MissionStatusPacket {
  id: string;
  title: string;
  referenceLabel?: string;
}

export interface PacketDiffEvidence {
  additions?: number | null;
  deletions?: number | null;
  fileCount?: number | null;
}

export interface PacketFocusTarget {
  packetId?: string | null;
  laneId?: string | null;
  sessionKey?: string | null;
}

export type OrchestratorStatusEventData =
  | {
      kind: 'mission-complete';
      mergedCount: number;
      archivedCount?: number;
      summary?: string;
      repoPath?: string | null;
      packets?: MissionStatusPacket[];
    }
  | {
      kind: 'merge';
      packetTitle: string;
      branch?: string | null;
      runtime?: string | null;
      repoLabel?: string | null;
      diff?: PacketDiffEvidence | null;
      focus?: PacketFocusTarget | null;
    }
  | { kind: 'heal'; outcome: 'recovered' | 'needs-human'; packetTitle?: string | null; previousStatus?: string | null };

export type OrchestratorStatusDetection = OrchestratorStatusEventData | { kind: 'suppress' };

export type StatusEventTone = 'success' | 'attention';

// Lane statuses that mean "this transition is a recovery, not normal flow".
// A lane reaching `reviewing` from one of these was healed; reaching it from
// `running` is just the agent finishing its turn.
const FAILURE_STATES = new Set([
  'failed',
  'recovering',
  'awaiting_orchestrator',
  'awaiting_human',
  'base-moved',
  'stalled',
]);

// ---- Detection from system-message text (legacy + new mission-complete) ----

export function detectOrchestratorStatusEvent(text: string): OrchestratorStatusDetection | null {
  const trimmed = (text || '').trim();
  if (!trimmed) return null;
  // Legacy "(NEW THREAD · READY)" — redundant with the mission-complete card.
  if (/^\(\s*NEW THREAD\b/i.test(trimmed)) return { kind: 'suppress' };
  // Legacy "(MISSION COMPLETE · 2 MERGES · ARCHIVED)"
  if (/^\(\s*MISSION COMPLETE\b/i.test(trimmed)) {
    const match = trimmed.match(/(\d+)\s*MERGE/i);
    return { kind: 'mission-complete', mergedCount: match ? parseInt(match[1], 10) : 0 };
  }
  // New "Mission complete — 2 packets merged and archived. …"
  if (/^Mission complete\b/i.test(trimmed)) {
    const match = trimmed.match(/(\d+)\s*packets?/i);
    return { kind: 'mission-complete', mergedCount: match ? parseInt(match[1], 10) : 0 };
  }
  if (/^Mission archived\b/i.test(trimmed)) {
    return { kind: 'mission-complete', mergedCount: 0 };
  }
  return null;
}

// ---- Derivation from an o8:lane-lifecycle realtime event ----

export interface LaneLifecyclePayload {
  laneId?: string;
  packetId?: string | null;
  sessionKey?: string | null;
  // The WS `lane-lifecycle` payload (buildLaneLifecyclePayload) carries the
  // lane status as `status`; some legacy/realtime envelopes use `laneStatus`.
  // Read both — `laneStatusOf()` coalesces them. A bare `laneStatus`-only read
  // is always undefined against the live WS event (the bug that suppressed
  // every lane-lifecycle card).
  status?: string;
  laneStatus?: string;
  previousStatus?: string | null;
  branch?: string | null;
  runtime?: string | null;
}

/** The lane status off a lifecycle payload, tolerant of both field names. */
export function laneStatusOf(data: LaneLifecyclePayload): string {
  return data.laneStatus ?? data.status ?? '';
}

export function deriveLaneStatusEvent(
  data: LaneLifecyclePayload,
  resolvePacket: (data: LaneLifecyclePayload) => {
    title: string | null;
    repoLabel?: string | null;
    diff?: PacketDiffEvidence | null;
    focus?: PacketFocusTarget | null;
  } | null,
): OrchestratorStatusEventData | null {
  const status = laneStatusOf(data);
  const previous = data.previousStatus ?? '';
  const packet = resolvePacket(data);

  // A packet merged: its lane settled to `completed`.
  if (status === 'completed') {
    return {
      kind: 'merge',
      packetTitle: packet?.title ?? 'A packet',
      branch: data.branch ?? null,
      runtime: data.runtime ?? null,
      repoLabel: packet?.repoLabel ?? null,
      diff: packet?.diff ?? null,
      focus: packet?.focus ?? {
        packetId: data.packetId ?? null,
        laneId: data.laneId ?? null,
        sessionKey: data.sessionKey ?? null,
      },
    };
  }
  // Self-heal recovered: lane returned to `reviewing` from a failure state.
  if (status === 'reviewing' && FAILURE_STATES.has(previous)) {
    return {
      kind: 'heal',
      outcome: 'recovered',
      packetTitle: packet?.title ?? null,
      previousStatus: previous,
    };
  }
  // Self-heal gave up: lane parked at awaiting-human from a failure state.
  if ((status === 'awaiting_input' || status === 'awaiting_human') && FAILURE_STATES.has(previous)) {
    return {
      kind: 'heal',
      outcome: 'needs-human',
      packetTitle: packet?.title ?? null,
      previousStatus: previous,
    };
  }
  return null;
}

// A stable dedupe key so a given transition cards exactly once per session.
export function statusEventDedupeKey(data: LaneLifecyclePayload, event: OrchestratorStatusEventData): string {
  const anchor = data.packetId ?? data.laneId ?? data.sessionKey ?? 'lane';
  return `${anchor}:${event.kind}:${laneStatusOf(data)}`;
}

// ---- Human-readable formatting (shared by card + modal + fallback text) ----

export function humanizeLaneStatus(status?: string | null): string {
  switch (status) {
    case 'failed': return 'a failed run';
    case 'recovering': return 'a recovery attempt';
    case 'awaiting_orchestrator': return 'an escalation';
    case 'awaiting_human': return 'an escalation';
    case 'base-moved': return 'the base branch moving';
    case 'stalled': return 'a stall';
    default: return (status || 'a failure').replace(/_/g, ' ');
  }
}

export function statusEventSummary(event: OrchestratorStatusEventData): { title: string; detail: string; tone: StatusEventTone } {
  switch (event.kind) {
    case 'mission-complete':
      return {
        title: 'Mission complete',
        detail: event.mergedCount > 0
          ? `${event.mergedCount} ${event.mergedCount === 1 ? 'packet' : 'packets'} merged and archived`
          : 'Archived · ready for the next mission',
        tone: 'success',
      };
    case 'merge':
      return {
        title: event.packetTitle,
        detail: mergeEvidenceLine(event),
        tone: 'success',
      };
    case 'heal':
      return event.outcome === 'recovered'
        ? {
            title: 'Lane recovered',
            detail: `${event.packetTitle ?? 'A lane'} auto-recovered${event.previousStatus ? ` after ${humanizeLaneStatus(event.previousStatus)}` : ''}`,
            tone: 'success',
          }
        : {
            title: 'Needs your input',
            detail: `${event.packetTitle ?? 'A lane'} couldn't auto-recover${event.previousStatus ? ` after ${humanizeLaneStatus(event.previousStatus)}` : ''}`,
            tone: 'attention',
          };
  }
}

export function formatPacketDiffEvidence(diff?: PacketDiffEvidence | null): string | null {
  const additions = typeof diff?.additions === 'number' ? diff.additions : null;
  const deletions = typeof diff?.deletions === 'number' ? diff.deletions : null;
  const files = typeof diff?.fileCount === 'number' ? diff.fileCount : null;
  if (additions === null && deletions === null && files === null) return null;
  return [
    additions !== null ? `+${additions}` : null,
    deletions !== null ? `-${deletions}` : null,
    files !== null ? `${files} ${files === 1 ? 'file' : 'files'}` : null,
  ].filter(Boolean).join(' ');
}

export function mergeEvidenceLine(event: Extract<OrchestratorStatusEventData, { kind: 'merge' }>): string {
  const parts = [
    formatPacketDiffEvidence(event.diff),
    [event.repoLabel, event.branch].filter(Boolean).join(' · '),
  ].filter((part): part is string => Boolean(part && part.trim()));
  return parts.length > 0 ? parts.join(' · ') : `Landed on ${event.branch || 'the base branch'}`;
}

// Plain-text fallback stored in the entry's `text` (so search / mobile / copy
// still work, and the card has something to detect against if statusEvent is
// ever stripped).
export function statusEventToText(event: OrchestratorStatusEventData): string {
  const { title, detail } = statusEventSummary(event);
  return `${title} — ${detail}`;
}
