import { asc, eq, or } from 'drizzle-orm';
import { listApprovalsForContext } from '@/lib/approvals/store';
import type { ApprovalAuditEvent, OrchestratorReviewFinding } from '@/lib/approvals/types';
import { getDb, laneEvents, sessionOutcomes } from '@/lib/db';
import { getLaneSpokenDiffFacts } from '@/lib/lane/lane-diff-facts';
import { findLaneByPacket } from '@/lib/lane/registry';
import type { Lane } from '@/lib/lane/types';
import type { CloseUnmergedDisposition } from '@/lib/orchestrator/close-unmerged';
import type { AgentSummary } from '@/lib/fleet/types';
import { extractReviewFindings, extractReviewPatterns } from '@/lib/orchestrator/review-lessons';
import { outcomeFromPacketSelfReview } from '@/lib/orchestrator/context-relay-outcome';
import {
  buildMissingPacketSelfReview,
  parsePacketSelfReview,
  stripPacketSelfReview,
} from '@/lib/orchestrator/self-review';
import {
  parsePacketTaskContract,
  stripPacketTaskContract,
} from '@/lib/orchestrator/packet-task-contract';
import type { OrchestratorRuntime, PacketContext } from '@/lib/orchestrator/types';
import {
  isDispatchableRuntime,
  isOrchestratorRuntime,
  runtimeFromOwnedSessionKey,
} from '@/lib/orchestrator/runtime-capabilities';
import { getRuntimeInventorySnapshot } from '@/lib/runtime/inventory';
import { getRuntime } from '@/lib/runtimes/registry';
import type { RuntimeId, RuntimeTranscriptEntry } from '@/lib/runtimes/types';
import { getActiveProjectScopeForRepoSync } from '@/lib/repos/projects';
import { truncateText } from '@/lib/util/text';
import { syncTranscriptSearchDocument } from '@/lib/search/transcripts';

const TRANSCRIPT_CAPTURE_LIMIT = 5_000;
const SUMMARY_LIMIT = 1_200;
const NOTE_LIMIT = 320;
const NOTE_PATTERN = /\b(blocker|blocked|blocking|note|notes|remaining|next step|todo|unable|could not|can't|cannot|failed|failure|error|waiting)\b/i;
type PacketReviewContext = NonNullable<PacketContext['review']>;
const packetCompletionContextStore = new Map<string, PacketContext>();

function inferRuntimeId(sessionKey: string): RuntimeId | null {
  const ownedRuntime = runtimeFromOwnedSessionKey(sessionKey);
  if (ownedRuntime) return ownedRuntime;
  const separatorIndex = sessionKey.indexOf(':');
  const prefix = separatorIndex > 0 ? sessionKey.slice(0, separatorIndex).trim() : '';
  return isOrchestratorRuntime(prefix) ? prefix : null;
}

function normalizeSummaryText(text: string, max: number): string {
  const withoutCode = text.replace(/```[\s\S]*?```/g, '[code omitted]');
  const normalized = withoutCode
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ');

  return truncateText(normalized, max);
}

function pushUniqueSection(target: string[], value?: string) {
  const normalized = value?.trim();
  if (!normalized || target.includes(normalized)) {
    return;
  }
  target.push(normalized);
}

function pushUniqueString(target: string[], seen: Set<string>, value?: string) {
  const normalized = value?.trim();
  if (!normalized) {
    return;
  }

  const key = normalized.toLowerCase();
  if (seen.has(key)) {
    return;
  }

  seen.add(key);
  target.push(normalized);
}

function pushUniqueFinding(
  target: OrchestratorReviewFinding[],
  seen: Set<string>,
  finding: OrchestratorReviewFinding,
) {
  const description = finding.description.trim();
  const file = finding.file.trim() || 'unknown';
  if (!description) {
    return;
  }

  const key = `${file.toLowerCase()}:${finding.line ?? ''}:${description.toLowerCase()}`;
  if (seen.has(key)) {
    return;
  }

  seen.add(key);
  target.push({
    file,
    line: typeof finding.line === 'number' && Number.isFinite(finding.line) && finding.line > 0
      ? Math.floor(finding.line)
      : undefined,
    severity: finding.severity,
    description,
    resolution: finding.resolution,
    fixSuggestion: finding.fixSuggestion?.trim() || undefined,
  });
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function findLastAssistantEntry(entries: RuntimeTranscriptEntry[]): RuntimeTranscriptEntry | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.role !== 'assistant' || !entry.text.trim()) {
      continue;
    }
    return entry;
  }
  return null;
}

function findRecentNote(entries: RuntimeTranscriptEntry[], excludedEntryId?: string | null): string {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.id === excludedEntryId) {
      continue;
    }
    if (entry.role !== 'assistant' && entry.role !== 'system') {
      continue;
    }
    const text = entry.text.trim();
    if (!text || !NOTE_PATTERN.test(text)) {
      continue;
    }
    return normalizeSummaryText(text, NOTE_LIMIT);
  }
  return '';
}

function latestTranscriptTimestamp(entries: RuntimeTranscriptEntry[]): string | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const timestamp = entries[index]?.timestamp;
    if (!(timestamp instanceof Date) || Number.isNaN(timestamp.getTime())) {
      continue;
    }
    return timestamp.toISOString();
  }
  return null;
}

function findLatestSelfReview(entries: RuntimeTranscriptEntry[]): PacketContext['selfReview'] {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.role !== 'assistant' || !entry.text.trim()) {
      continue;
    }

    const selfReview = parsePacketSelfReview(entry.text);
    if (selfReview) {
      return selfReview;
    }
  }

  return buildMissingPacketSelfReview();
}

function findFirstTaskContract(entries: RuntimeTranscriptEntry[]): PacketContext['taskContract'] {
  for (const entry of entries) {
    if (entry.role !== 'assistant' || !entry.text.trim()) {
      continue;
    }
    const taskContract = parsePacketTaskContract(entry.text);
    if (taskContract) {
      return taskContract;
    }
  }
  return undefined;
}

function buildChangedFileList(entries: RuntimeTranscriptEntry[], runtimeChangedFiles: Array<{ path: string }>): string[] {
  const seen = new Set<string>();
  const files: string[] = [];
  const transcriptFiles = entries
    .map((entry) => entry.filePath)
    .filter((value): value is string => Boolean(value?.trim()));

  for (const filePath of runtimeChangedFiles.map((file) => file.path).concat(transcriptFiles)) {
    const normalized = filePath.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    files.push(normalized);
  }

  return files.sort((left, right) => left.localeCompare(right));
}

function buildPacketSummary(input: {
  lifecycleSummary?: string;
  assistantSummary?: string;
  note?: string;
  changedFiles: string[];
}): string {
  const sections: string[] = [];
  pushUniqueSection(sections, input.lifecycleSummary);
  pushUniqueSection(sections, input.assistantSummary);

  if (sections.length === 0) {
    if (input.changedFiles.length > 0) {
      sections.push(`Updated ${input.changedFiles.length} file${input.changedFiles.length === 1 ? '' : 's'} during the completed run.`);
    } else {
      sections.push('Completed the run without a recoverable assistant summary.');
    }
  }

  if (input.note) {
    pushUniqueSection(sections, `Notes: ${input.note}`);
  }

  return sections.join('\n\n');
}

async function findAgentSummary(sessionKey: string): Promise<AgentSummary | null> {
  const snapshot = await getRuntimeInventorySnapshot({ fresh: true });
  return snapshot.agents.find((agent) => agent.sessionKey === sessionKey) ?? null;
}

function isReviewFinding(value: unknown): value is OrchestratorReviewFinding {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return typeof candidate.file === 'string'
    && typeof candidate.description === 'string'
    && (candidate.line === undefined || (typeof candidate.line === 'number' && Number.isFinite(candidate.line)))
    && (candidate.severity === 'bug' || candidate.severity === 'rule_violation' || candidate.severity === 'note')
    && (candidate.resolution === 'fixed' || candidate.resolution === 'accepted' || candidate.resolution === 'deferred')
    && (candidate.fixSuggestion === undefined || typeof candidate.fixSuggestion === 'string');
}

function toPacketReviewContext(review: {
  findings: OrchestratorReviewFinding[];
  reviewer?: string;
  approved: boolean;
  diffSha?: string;
}): PacketReviewContext {
  const reviewer = review.reviewer?.trim();
  const diffSha = review.diffSha?.trim();
  return {
    reviewer: reviewer || undefined,
    approved: review.approved,
    diffSha: diffSha || undefined,
    findings: review.findings.map((finding) => ({
      file: finding.file.trim(),
      line: typeof finding.line === 'number' && Number.isFinite(finding.line) && finding.line > 0
        ? Math.floor(finding.line)
        : undefined,
      severity: finding.severity,
      description: finding.description.trim(),
      resolution: finding.resolution,
      fixSuggestion: finding.fixSuggestion?.trim() || undefined,
    })),
    reviewedAt: new Date().toISOString(),
  };
}

function buildConflictZonesFromFindings(findings: OrchestratorReviewFinding[]) {
  const zones: string[] = [];
  const seen = new Set<string>();

  for (const finding of findings) {
    const file = finding.file.trim();
    if (!file) {
      continue;
    }

    const zone = typeof finding.line === 'number' ? `${file} (line ${finding.line})` : file;
    pushUniqueString(zones, seen, zone);
  }

  return zones;
}

function buildPacketReviewContextFromEvent(event: ApprovalAuditEvent): PacketReviewContext | null {
  if (event.type !== 'orchestrator_review') {
    return null;
  }

  const findings = Array.isArray(event.findings)
    ? event.findings.filter(isReviewFinding)
    : extractReviewFindings(event.note ?? '');
  const approved = typeof event.approved === 'boolean' ? event.approved : false;

  return {
    reviewer: event.reviewer?.trim() || undefined,
    approved,
    diffSha: event.diffSha?.trim() || undefined,
    findings,
    reviewedAt: new Date(event.timestamp).toISOString(),
  };
}

function extractApprovalReviewContext(
  auditEvents: ApprovalAuditEvent[],
  changedFiles: string[],
): Pick<PacketContext, 'review' | 'reviewFindings' | 'patterns' | 'conflictZones'> {
  const reviewFindings: OrchestratorReviewFinding[] = [];
  const findingKeys = new Set<string>();
  const patterns: string[] = [];
  const patternKeys = new Set<string>();
  const conflictZones: string[] = [];
  const conflictZoneKeys = new Set<string>();
  let latestReview: PacketReviewContext | null = null;
  let latestReviewTimestamp = Number.NEGATIVE_INFINITY;

  for (const event of auditEvents) {
    if (event.type !== 'orchestrator_review') {
      continue;
    }

    const reviewContext = buildPacketReviewContextFromEvent(event);
    if (reviewContext && event.timestamp >= latestReviewTimestamp) {
      latestReview = reviewContext;
      latestReviewTimestamp = event.timestamp;
    }

    const findings = Array.isArray(event.findings)
      ? event.findings.filter(isReviewFinding)
      : extractReviewFindings(event.note ?? '');
    for (const finding of findings) {
      pushUniqueFinding(reviewFindings, findingKeys, finding);
    }

    const derivedPatterns = isStringArray(event.patterns)
      ? event.patterns
      : extractReviewPatterns(event.note ?? '', findings);
    for (const pattern of derivedPatterns) {
      pushUniqueString(patterns, patternKeys, pattern);
    }

    for (const zone of isStringArray(event.conflictZones) ? event.conflictZones : []) {
      pushUniqueString(conflictZones, conflictZoneKeys, zone);
    }
  }

  if (conflictZones.length === 0) {
    for (const filePath of changedFiles) {
      pushUniqueString(conflictZones, conflictZoneKeys, filePath);
    }
  }

  return {
    review: latestReview ?? undefined,
    reviewFindings: reviewFindings.length > 0 ? reviewFindings : latestReview?.findings,
    patterns: patterns.length > 0 ? patterns : undefined,
    conflictZones: conflictZones.length > 0 ? conflictZones : undefined,
  };
}

export async function readPacketCompletionContext(packetId: string): Promise<PacketContext | null> {
  const normalizedPacketId = packetId.trim();
  if (!normalizedPacketId) {
    return null;
  }
  return packetCompletionContextStore.get(normalizedPacketId) ?? null;
}

export async function recordPacketReviewContext(
  packetId: string,
  review: {
    findings: OrchestratorReviewFinding[];
    reviewer?: string;
    approved: boolean;
    diffSha?: string;
  },
): Promise<PacketContext | null> {
  const normalizedPacketId = packetId.trim();
  if (!normalizedPacketId) {
    return null;
  }

  const reviewContext = toPacketReviewContext(review);
  const patterns = extractReviewPatterns(
    reviewContext.findings.map((finding) => finding.description).join('\n'),
    reviewContext.findings,
  );
  const conflictZones = buildConflictZonesFromFindings(reviewContext.findings);
  const existing = await readPacketCompletionContext(normalizedPacketId);
  const lane = existing ? null : findLaneByPacket(normalizedPacketId);
  const projectId = existing?.projectId
    ?? getActiveProjectScopeForRepoSync(lane?.repoPath ?? null).projectId;
  const nextContext: PacketContext = existing
    ? {
        ...existing,
        projectId,
        review: reviewContext,
        reviewFindings: reviewContext.findings,
        patterns,
        conflictZones: conflictZones.length > 0 ? conflictZones : existing.conflictZones,
      }
    : {
        packetId: normalizedPacketId,
        projectId,
        sessionKey: lane?.sessionKey || (lane ? `lane:${lane.id}` : `packet:${normalizedPacketId}`),
        summary: 'Review recorded before packet completion context was captured.',
        changedFiles: [],
        reviewFindings: reviewContext.findings,
        patterns,
        conflictZones,
        completedAt: new Date().toISOString(),
        model: lane?.runtime ?? 'unknown',
        review: reviewContext,
      };

  packetCompletionContextStore.set(normalizedPacketId, nextContext);

  return nextContext;
}

export async function capturePacketCompletionContext(packetId: string, sessionKey: string): Promise<PacketContext> {
  const normalizedPacketId = packetId.trim();
  const normalizedSessionKey = sessionKey.trim();
  const runtimeId = inferRuntimeId(normalizedSessionKey);
  const runtime = runtimeId ? getRuntime(runtimeId) : undefined;
  const lane = findLaneByPacket(normalizedPacketId);
  const projectId = getActiveProjectScopeForRepoSync(lane?.repoPath ?? null).projectId;

  const [transcriptResult, changedFilesResult, agentResult, telemetryResult, spokenDiffResult] = await Promise.allSettled([
    runtime?.readTranscript(normalizedSessionKey, undefined, TRANSCRIPT_CAPTURE_LIMIT) ?? Promise.resolve([]),
    runtime?.getChangedFiles(normalizedSessionKey) ?? Promise.resolve([]),
    findAgentSummary(normalizedSessionKey),
    runtime?.getTelemetry?.(normalizedSessionKey) ?? Promise.resolve(undefined),
    Promise.resolve().then(() => (
      lane ? getLaneSpokenDiffFacts(lane) : undefined
    )),
  ]);

  const transcript = transcriptResult.status === 'fulfilled' ? transcriptResult.value : [];
  const changedFiles = buildChangedFileList(
    transcript,
    changedFilesResult.status === 'fulfilled' ? changedFilesResult.value : [],
  );
  const agent = agentResult.status === 'fulfilled' ? agentResult.value : null;
  const telemetry = telemetryResult.status === 'fulfilled' ? telemetryResult.value : undefined;
  const lastAssistantEntry = findLastAssistantEntry(transcript);
  const selfReview = findLatestSelfReview(transcript);
  const taskContract = findFirstTaskContract(transcript);
  const matchingApprovals = listApprovalsForContext({
    packetId: normalizedPacketId,
    laneId: lane?.id ?? undefined,
    sessionKey: normalizedSessionKey,
  });
  const approvalReviewContext = extractApprovalReviewContext(
    matchingApprovals.flatMap((approval) => approval.audit),
    changedFiles,
  );
  const context: PacketContext = {
    packetId: normalizedPacketId,
    projectId,
    sessionKey: normalizedSessionKey,
    ...(spokenDiffResult.status === 'fulfilled' && spokenDiffResult.value
      ? {
          headSha: spokenDiffResult.value.headSha,
          diffFingerprint: spokenDiffResult.value.fingerprint,
        }
      : {}),
    summary: buildPacketSummary({
      lifecycleSummary: normalizeSummaryText(agent?.runtimeSurface?.lifecycle?.summary ?? '', SUMMARY_LIMIT),
      assistantSummary: normalizeSummaryText(
        stripPacketTaskContract(stripPacketSelfReview(lastAssistantEntry?.text ?? '')),
        SUMMARY_LIMIT,
      ),
      note: findRecentNote(transcript, lastAssistantEntry?.id ?? null),
      changedFiles,
    }),
    changedFiles,
    selfReview,
    ...(taskContract ? { taskContract } : {}),
    completedAt: agent?.runtimeSurface?.lifecycle?.lastRunFinishedAt
      ?? latestTranscriptTimestamp(transcript)
      ?? new Date().toISOString(),
    model: telemetry?.model?.trim()
      || agent?.model?.trim()
      || lane?.model?.trim()
      || 'unknown',
    ...approvalReviewContext,
  };

  packetCompletionContextStore.set(normalizedPacketId, context);

  // #984 Stage 1 — index the transcript once, at packet completion. Cmd+K
  // reads this durable FTS document and never scans runtime files per keystroke.
  try {
    syncTranscriptSearchDocument({
      packetId: normalizedPacketId,
      laneId: lane?.id ?? null,
      sessionKey: normalizedSessionKey,
      title: lane?.label?.trim() || `Packet ${normalizedPacketId}`,
      repoPath: lane?.repoPath ?? null,
      runtime: runtimeId,
      entries: transcript,
      completedAt: context.completedAt,
    });
  } catch (error) {
    console.warn('[transcript-search-write] failed for', normalizedPacketId, error);
  }

  // #1108 — Persist to the session_outcomes ledger. Without this, the implicit
  // brain (Recent Outcomes context, the auto-directive proposer, and the runtime
  // routing recommender) all silently no-op because the table is empty. Fire-
  // and-forget — never block the capture flow.
  void persistSessionOutcome(context, lane, runtimeId).catch((err) => {
    console.warn('[session-outcome-write] failed for', normalizedPacketId, err);
  });

  return context;
}

/**
 * Insert one row into `session_outcomes` for a freshly-captured packet
 * completion. `mergedClean` is left NULL — the actual merge handler stamps
 * it later. Idempotent: id is derived from packetId + sessionKey + completedAt
 * so re-captures within the same second collapse via onConflictDoNothing.
 */
// Runtimes the session_outcomes table tracks (subset of the broader RuntimeId
// union — RuntimeId also includes things like 'remote-customer' that the
// dispatch routing recommender doesn't score).
type LedgerRuntime = OrchestratorRuntime;
const LANE_START_STATUSES: ReadonlySet<string> = new Set(['launching', 'running']);

function isLedgerRuntime(r: string | null): r is LedgerRuntime {
  return isDispatchableRuntime(r);
}

type OutcomeStartDerivation = {
  startedAt: string;
  durationMs: number | null;
  source: 'derived-start' | 'fallback';
  detail: string;
};

function parseLaneEventPayload(payloadJson: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(payloadJson);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Bad historical event payloads should only disable start derivation.
  }
  return {};
}

function parseIsoMs(value: string): number | null {
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function fallbackOutcomeStart(completedAt: string, detail: string): OutcomeStartDerivation {
  return {
    startedAt: completedAt,
    durationMs: null,
    source: 'fallback',
    detail,
  };
}

function deriveOutcomeStartFromLaneEvents(
  db: NonNullable<ReturnType<typeof getDb>>,
  lane: Lane,
  completedAt: string,
): OutcomeStartDerivation {
  try {
    const rows = db
      .select({
        verb: laneEvents.verb,
        payloadJson: laneEvents.payloadJson,
        timestamp: laneEvents.timestamp,
      })
      .from(laneEvents)
      .where(eq(laneEvents.laneId, lane.id))
      .orderBy(asc(laneEvents.timestamp))
      .all();
    const startRow = rows.find((row) => {
      if (row.verb === 'open_lane') {
        return true;
      }
      if (row.verb !== 'status_change') {
        return false;
      }
      const status = parseLaneEventPayload(row.payloadJson).status;
      return typeof status === 'string' && LANE_START_STATUSES.has(status);
    });

    if (!startRow) {
      return fallbackOutcomeStart(completedAt, 'no lane start event');
    }

    const startedMs = parseIsoMs(startRow.timestamp);
    const completedMs = parseIsoMs(completedAt);
    if (startedMs === null || completedMs === null || startedMs >= completedMs) {
      return fallbackOutcomeStart(completedAt, `invalid start window from ${startRow.verb}`);
    }

    return {
      startedAt: startRow.timestamp,
      durationMs: Math.round(completedMs - startedMs),
      source: 'derived-start',
      detail: startRow.verb,
    };
  } catch (err) {
    return fallbackOutcomeStart(completedAt, `lane start lookup failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function persistSessionOutcome(
  context: PacketContext,
  lane: Lane | null,
  runtimeId: RuntimeId | null,
): Promise<void> {
  // We need a ledger-tracked runtime + a repoPath to write a useful row. Skip
  // silently if either is missing — captures that lack them (ad-hoc scratch
  // runs, customer runtimes) weren't going to feed any downstream brain
  // consumer anyway.
  if (!isLedgerRuntime(runtimeId) || !lane?.repoPath) return;
  const db = getDb();
  if (!db) return;

  // Deterministic id keyed on the unique-per-second tuple — re-captures of the
  // exact same completion (auto-review re-pulling context) collapse cleanly.
  const completedAt = context.completedAt;
  const sessionFingerprint = context.sessionKey.replace(/[^a-z0-9]/gi, '').slice(-24);
  const id = `outcome-${context.packetId.slice(0, 16)}-${sessionFingerprint}-${completedAt.slice(0, 19)}`;
  const start = deriveOutcomeStartFromLaneEvents(db, lane, completedAt);
  console.log(
    `[context-relay] ${start.source} packet=${context.packetId} lane=${lane.id} startedAt=${start.startedAt} completedAt=${completedAt} durationMs=${start.durationMs ?? 'null'} detail=${start.detail}`,
  );

  // Outcome derivation remains coarse at capture time, but a present failed
  // receipt must not be promoted to success. Merge later stamps mergedClean.
  const outcome = outcomeFromPacketSelfReview(context.selfReview);

  try {
    await db.insert(sessionOutcomes).values({
      id,
      projectId: context.projectId ?? null,
      repoPath: lane.repoPath,
      branch: lane.branch ?? null,
      runtime: runtimeId,
      sessionKey: context.sessionKey,
      laneId: lane.id,
      packetId: context.packetId,
      outcome,
      summary: (context.summary || '(no summary)').slice(0, 4000),
      changedFilesJson: JSON.stringify((context.changedFiles ?? []).slice(0, 50)),
      model: context.model ?? null,
      startedAt: start.startedAt,
      completedAt,
      durationMs: start.durationMs,
      // mergedClean / reviewApproved / reviewFindingsCount left at defaults;
      // the merge handler stamps mergedClean via markOutcomeMerged() below
      // when the packet's branch actually lands on main. Without that hop the
      // routing recommender (#747) never sees a scoreable signal.
    }).onConflictDoNothing();
    // New ledger row — cached "what shipped"-style Q&A answers are now stale.
    // Lazy import keeps the qa module out of this file's cold-start graph.
    try {
      const { invalidateAnswerCache } = await import('@/lib/cortex/qa/ask');
      invalidateAnswerCache();
    } catch {
      // Best-effort — never let cache invalidation break the capture flow.
    }
  } catch (err) {
    // Swallow — never let a ledger write break the capture flow.
    console.warn('[session-outcome-write] insert failed:', err);
  }
}

/**
 * Stamp `merged_clean` on the session_outcomes row(s) for a successfully-
 * reconciled packet/lane. Best-effort + fire-and-forget by the caller — never
 * block a merge over a ledger write.
 *
 * Looks up by laneId and packetId when available. Updates every matching row
 * in case a retry produced two captures for the same
 * packet (deterministic id collapses most cases, but be defensive).
 */
export async function markOutcomeMerged({
  laneId,
  packetId,
  mergedClean = true,
}: {
  laneId?: string | null;
  packetId?: string | null;
  mergedClean?: boolean;
}): Promise<void> {
  const db = getDb();
  if (!db) return;
  const trimmedLane = laneId?.trim() || null;
  const trimmedPacket = packetId?.trim() || null;
  if (!trimmedLane && !trimmedPacket) return;

  try {
    if (trimmedLane) {
      await db.update(sessionOutcomes)
        .set({ mergedClean })
        .where(eq(sessionOutcomes.laneId, trimmedLane));
    }
    if (trimmedPacket) {
      await db.update(sessionOutcomes)
        .set({ mergedClean })
        .where(eq(sessionOutcomes.packetId, trimmedPacket));
    }
  } catch (err) {
    console.warn('[session-outcome-merge] mergedClean update failed:', err);
  }
}

/**
 * Replace the provisional worker-completion result with the operator's final
 * disposition when work is intentionally closed without merging.
 */
export async function markOutcomeClosedUnmerged({
  laneId,
  packetId,
  disposition,
  lane,
  summary,
}: {
  laneId?: string | null;
  packetId?: string | null;
  disposition: CloseUnmergedDisposition;
  lane?: Pick<Lane, 'id' | 'repoPath' | 'branch' | 'runtime' | 'sessionKey' | 'createdAt'> | null;
  summary?: string | null;
}): Promise<void> {
  const db = getDb();
  if (!db) return;
  const trimmedLane = laneId?.trim() || null;
  const trimmedPacket = packetId?.trim() || null;
  if (!trimmedLane && !trimmedPacket) return;

  try {
    const completedAt = new Date().toISOString();
    const outcomeSummary = summary?.trim() || 'Closed unmerged by the operator.';
    const targets = [
      trimmedLane ? eq(sessionOutcomes.laneId, trimmedLane) : null,
      trimmedPacket ? eq(sessionOutcomes.packetId, trimmedPacket) : null,
    ].filter((target): target is NonNullable<typeof target> => target !== null);
    const updated = await db.update(sessionOutcomes)
      .set({
        outcome: disposition,
        summary: outcomeSummary,
        completedAt,
        mergedClean: false,
      })
      .where(targets.length === 1 ? targets[0] : or(...targets))
      .run();
    const changes = (updated as unknown as { changes?: number }).changes ?? 0;
    if (changes === 0 && lane) {
      const outcomeId = `outcome-close-${trimmedPacket ?? trimmedLane}-${completedAt.slice(0, 19)}`;
      await db.insert(sessionOutcomes).values({
        id: outcomeId,
        repoPath: lane.repoPath,
        branch: lane.branch,
        runtime: lane.runtime,
        sessionKey: lane.sessionKey,
        laneId: trimmedLane ?? lane.id,
        packetId: trimmedPacket,
        outcome: disposition,
        summary: outcomeSummary,
        startedAt: lane.createdAt,
        completedAt,
        mergedClean: false,
      }).onConflictDoNothing();
    }
    try {
      const { invalidateAnswerCache } = await import('@/lib/cortex/qa/ask');
      invalidateAnswerCache();
    } catch {
      // Best-effort — a ledger close must not fail because the cache is unavailable.
    }
  } catch (err) {
    console.warn('[session-outcome-close-unmerged] update failed:', err);
  }
}
