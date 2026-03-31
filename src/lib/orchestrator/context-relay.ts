import { listApprovalsForContext } from '@/lib/approvals/store';
import type { ApprovalAuditEvent, OrchestratorReviewFinding } from '@/lib/approvals/types';
import { getCortexClient } from '@/lib/cortex/client';
import { findLaneByPacket } from '@/lib/lane/registry';
import type { AgentSummary } from '@/lib/fleet/types';
import { extractReviewFindings, extractReviewPatterns } from '@/lib/orchestrator/review-lessons';
import type { PacketContext } from '@/lib/orchestrator/types';
import { getRuntimeInventorySnapshot } from '@/lib/runtime/inventory';
import { getRuntime } from '@/lib/runtimes/registry';
import type { RuntimeId, RuntimeTranscriptEntry } from '@/lib/runtimes/types';
import { truncateText } from '@/lib/util/text';

const PACKET_CONTEXT_SOURCE_PREFIX = 'orchestrator-packet-context';
const PACKET_CONTEXT_KIND = 'orchestrator packet context';
const PACKET_CONTEXT_JSON_START = '<context-pass-json>';
const PACKET_CONTEXT_JSON_END = '</context-pass-json>';
const PACKET_CONTEXT_SEARCH_LIMIT = 8;
const TRANSCRIPT_CAPTURE_LIMIT = 80;
const SUMMARY_LIMIT = 1_200;
const NOTE_LIMIT = 320;
const NOTE_PATTERN = /\b(blocker|blocked|blocking|note|notes|remaining|next step|todo|unable|could not|can't|cannot|failed|failure|error|waiting)\b/i;
type PacketReviewContext = NonNullable<PacketContext['review']>;

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

function serializePacketContext(context: PacketContext): string {
  return JSON.stringify({
    kind: PACKET_CONTEXT_KIND,
    purpose: 'dependency handoff',
    version: 1,
    ...context,
  });
}

function isPacketContext(value: unknown): value is PacketContext {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return typeof candidate.packetId === 'string'
    && typeof candidate.sessionKey === 'string'
    && typeof candidate.summary === 'string'
    && Array.isArray(candidate.changedFiles)
    && candidate.changedFiles.every((entry) => typeof entry === 'string')
    && (candidate.reviewFindings === undefined || (Array.isArray(candidate.reviewFindings) && candidate.reviewFindings.every(isReviewFinding)))
    && (candidate.patterns === undefined || isStringArray(candidate.patterns))
    && (candidate.conflictZones === undefined || isStringArray(candidate.conflictZones))
    && typeof candidate.completedAt === 'string'
    && typeof candidate.model === 'string'
    && (candidate.review === undefined || isPacketReviewContext(candidate.review));
}

function parseStoredPacketContext(value: unknown): PacketContext | null {
  if (isPacketContext(value)) {
    return value;
  }

  if (
    value
    && typeof value === 'object'
    && 'context' in value
    && isPacketContext((value as { context?: unknown }).context)
  ) {
    return (value as { context: PacketContext }).context;
  }

  return null;
}

function parsePacketContext(content: string): PacketContext | null {
  try {
    const parsed = JSON.parse(content) as unknown;
    const context = parseStoredPacketContext(parsed);
    if (context) {
      return context;
    }
  } catch {
    // Fall back to the legacy dual-format wrapper below.
  }

  const match = content.match(
    new RegExp(`${PACKET_CONTEXT_JSON_START}\\s*([\\s\\S]*?)\\s*${PACKET_CONTEXT_JSON_END}`),
  );
  if (!match?.[1]) {
    return null;
  }

  try {
    const parsed = JSON.parse(match[1]) as unknown;
    return parseStoredPacketContext(parsed);
  } catch {
    return null;
  }
}

async function findAgentSummary(sessionKey: string): Promise<AgentSummary | null> {
  const snapshot = await getRuntimeInventorySnapshot({ fresh: true });
  return snapshot.agents.find((agent) => agent.sessionKey === sessionKey) ?? null;
}

async function storePacketContext(context: PacketContext): Promise<void> {
  const client = getCortexClient();
  if (!(await client.isAvailable())) {
    console.warn(`[context-relay] Cortex unavailable; skipped packet context store for ${context.packetId}`);
    return;
  }

  const result = await client.store(
    serializePacketContext(context),
    `${PACKET_CONTEXT_SOURCE_PREFIX}-${context.packetId}`,
  );

  if (!result.ok) {
    console.error(`[context-relay] Failed to store packet context for ${context.packetId}`);
    return;
  }

  console.log(`[context-relay] Stored packet context for ${context.packetId}`);
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
    && (candidate.resolution === 'fixed' || candidate.resolution === 'accepted' || candidate.resolution === 'deferred');
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

  const client = getCortexClient();
  if (!(await client.isAvailable())) {
    return null;
  }

  const results = await client.search(
    `${PACKET_CONTEXT_KIND} dependency handoff ${normalizedPacketId}`,
    PACKET_CONTEXT_SEARCH_LIMIT,
  );

  const matches = results
    .map((result) => parsePacketContext(result.content))
    .filter((context): context is PacketContext => context !== null && context.packetId === normalizedPacketId)
    .sort((left, right) => new Date(right.completedAt).getTime() - new Date(left.completedAt).getTime());

  return matches[0] ?? null;
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
  const nextContext: PacketContext = existing
    ? {
        ...existing,
        review: reviewContext,
        reviewFindings: reviewContext.findings,
        patterns,
        conflictZones: conflictZones.length > 0 ? conflictZones : existing.conflictZones,
      }
    : {
        packetId: normalizedPacketId,
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

  await storePacketContext(nextContext);
  return nextContext;
}

export async function capturePacketCompletionContext(packetId: string, sessionKey: string): Promise<PacketContext> {
  const normalizedPacketId = packetId.trim();
  const normalizedSessionKey = sessionKey.trim();
  const runtimeId = inferRuntimeId(normalizedSessionKey);
  const runtime = runtimeId ? getRuntime(runtimeId) : undefined;
  const lane = findLaneByPacket(normalizedPacketId);

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
    sessionKey: normalizedSessionKey,
    summary: buildPacketSummary({
      lifecycleSummary: normalizeSummaryText(agent?.runtimeSurface?.lifecycle?.summary ?? '', SUMMARY_LIMIT),
      assistantSummary: normalizeSummaryText(lastAssistantEntry?.text ?? '', SUMMARY_LIMIT),
      note: findRecentNote(transcript, lastAssistantEntry?.id ?? null),
      changedFiles,
    }),
    changedFiles,
    completedAt: agent?.runtimeSurface?.lifecycle?.lastRunFinishedAt
      ?? latestTranscriptTimestamp(transcript)
      ?? new Date().toISOString(),
    model: telemetry?.model?.trim()
      || agent?.model?.trim()
      || runtimeId
      || 'unknown',
    ...approvalReviewContext,
  };

  await storePacketContext(context);
  return context;
}
