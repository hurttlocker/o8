import { listApprovalsForContext } from '@/lib/approvals/store';
import type { ApprovalAuditEvent, OrchestratorReviewFinding } from '@/lib/approvals/types';
import { getDb, sessionOutcomes } from '@/lib/db';
import { findLaneByPacket } from '@/lib/lane/registry';
import type { Lane } from '@/lib/lane/types';
import type { AgentSummary } from '@/lib/fleet/types';
import { extractReviewFindings, extractReviewPatterns } from '@/lib/orchestrator/review-lessons';
import {
  buildMissingPacketSelfReview,
  isPacketSelfReview,
  parsePacketSelfReview,
  stripPacketSelfReview,
} from '@/lib/orchestrator/self-review';
import type { PacketContext } from '@/lib/orchestrator/types';
import { getRuntimeInventorySnapshot } from '@/lib/runtime/inventory';
import { getRuntime } from '@/lib/runtimes/registry';
import type { RuntimeId, RuntimeTranscriptEntry } from '@/lib/runtimes/types';
import { getActiveProjectScopeForRepoSync } from '@/lib/repos/projects';
import { truncateText } from '@/lib/util/text';

const TRANSCRIPT_CAPTURE_LIMIT = 80;
const SUMMARY_LIMIT = 1_200;
const NOTE_LIMIT = 320;
const NOTE_PATTERN = /\b(blocker|blocked|blocking|note|notes|remaining|next step|todo|unable|could not|can't|cannot|failed|failure|error|waiting)\b/i;
type PacketReviewContext = NonNullable<PacketContext['review']>;
const packetCompletionContextStore = new Map<string, PacketContext>();

function inferRuntimeId(sessionKey: string): RuntimeId | null {
  if (sessionKey.startsWith('claude-code:')) {
    return 'claude-code';
  }
  if (sessionKey.startsWith('codex')) {
    return 'codex';
  }
  return null;
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

function isPacketReviewContext(value: unknown): value is PacketReviewContext {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return typeof candidate.approved === 'boolean'
    && Array.isArray(candidate.findings)
    && candidate.findings.every(isReviewFinding)
    && typeof candidate.reviewedAt === 'string'
    && (candidate.reviewer === undefined || typeof candidate.reviewer === 'string')
    && (candidate.diffSha === undefined || typeof candidate.diffSha === 'string');
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

  const [transcriptResult, changedFilesResult, agentResult, telemetryResult] = await Promise.allSettled([
    runtime?.readTranscript(normalizedSessionKey, undefined, TRANSCRIPT_CAPTURE_LIMIT) ?? Promise.resolve([]),
    runtime?.getChangedFiles(normalizedSessionKey) ?? Promise.resolve([]),
    findAgentSummary(normalizedSessionKey),
    runtime?.getTelemetry?.(normalizedSessionKey) ?? Promise.resolve(undefined),
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
    summary: buildPacketSummary({
      lifecycleSummary: normalizeSummaryText(agent?.runtimeSurface?.lifecycle?.summary ?? '', SUMMARY_LIMIT),
      assistantSummary: normalizeSummaryText(stripPacketSelfReview(lastAssistantEntry?.text ?? ''), SUMMARY_LIMIT),
      note: findRecentNote(transcript, lastAssistantEntry?.id ?? null),
      changedFiles,
    }),
    changedFiles,
    selfReview,
    completedAt: agent?.runtimeSurface?.lifecycle?.lastRunFinishedAt
      ?? latestTranscriptTimestamp(transcript)
      ?? new Date().toISOString(),
    model: telemetry?.model?.trim()
      || agent?.model?.trim()
      || runtimeId
      || 'unknown',
    ...approvalReviewContext,
  };

  packetCompletionContextStore.set(normalizedPacketId, context);

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
type LedgerRuntime = 'codex' | 'claude-code' | 'gemini' | 'opencode';
const LEDGER_RUNTIMES: ReadonlySet<string> = new Set(['codex', 'claude-code', 'gemini', 'opencode']);
function isLedgerRuntime(r: string | null): r is LedgerRuntime {
  return r !== null && LEDGER_RUNTIMES.has(r);
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

  // Outcome derivation — coarse signal at capture time; merge will overwrite
  // mergedClean once it actually fires. selfReview presence is the cheapest
  // available "agent intended to be done" signal.
  const outcome: 'succeeded' | 'failed' | 'partial' | 'interrupted' = context.selfReview
    ? 'succeeded'
    : 'partial';

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
      startedAt: completedAt, // best available — runtime telemetry could refine
      completedAt,
      // mergedClean / reviewApproved / reviewFindingsCount left at defaults;
      // the merge + review handlers update them when they fire (follow-up).
    }).onConflictDoNothing();
  } catch (err) {
    // Swallow — never let a ledger write break the capture flow.
    console.warn('[session-outcome-write] insert failed:', err);
  }
}
