import { and, desc, eq, gte, type SQL } from 'drizzle-orm';
import {
  buildApprovalContextMatchPredicate,
  extractApprovalContextIds,
  isOrchestratorReviewApproval,
  normalizeApprovalLookupValue,
  scoreApprovalContextMatch,
} from '@/lib/approvals/context';
import { stableApprovalJson } from '@/lib/approvals/fingerprint';
import {
  allFindingsResolved,
  buildOrchestratorReviewApprovalInput,
  buildOrchestratorReviewEvent,
  deriveOrchestratorReviewRisk,
  normalizeOrchestratorReview,
  type OrchestratorReviewRecordInput,
} from '@/lib/approvals/orchestrator-review';
import { approvals as approvalsTable, approvalEvents as approvalEventsTable, getDb, getSqlite } from '@/lib/db';
import type { EventSeverity } from '@/lib/fleet/types';
import { findLaneByPacket, getLane } from '@/lib/lane/registry';
import { getActiveProjectScopeForRepoSync } from '@/lib/repos/projects';
import type {
  ApprovalActor,
  ApprovalAuditEvent,
  ApprovalRecord,
  ApprovalRisk,
  CreateApprovalInput,
  MobileApprovalCard,
} from '@/lib/approvals/types';
import { resolveApproval } from '@/lib/approvals/resolution';

export { resolveApproval } from '@/lib/approvals/resolution';

type ApprovalRow = typeof approvalsTable.$inferSelect;
type ApprovalInsert = typeof approvalsTable.$inferInsert;

const APPROVAL_CONTEXT_LOOKUP_LIMIT = 100;
const APPROVAL_CONTEXT_LOOKBACK_MS = 1000 * 60 * 60 * 24 * 90;
const STALE_APPROVAL_TTL_MS = 1000 * 60 * 30;

export type ReviewTurnOutcome = 'active' | 'completed' | 'failed' | 'quota_discarded';

function getApprovalDb() {
  const db = getDb();
  if (!db) {
    throw new Error('[approval-store] SQLite database is unavailable');
  }
  return db;
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) {
    return fallback;
  }

  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function serializeJson(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

function mapApprovalRow(row: ApprovalRow | undefined): ApprovalRecord | null {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    projectId: row.projectId ?? null,
    source: row.source,
    runtime: row.runtime,
    agent: row.agent,
    sessionKey: row.sessionKey,
    title: row.title,
    description: row.description,
    summary: row.summary,
    toolName: row.toolName ?? undefined,
    args: parseJson<ApprovalRecord['args']>(row.argsJson, undefined),
    command: row.command ?? undefined,
    editable: row.editable ?? undefined,
    diff: parseJson<ApprovalRecord['diff']>(row.diffJson, undefined),
    gateResult: parseJson<ApprovalRecord['gateResult']>(row.gateResultJson, undefined),
    conflictReport: parseJson<ApprovalRecord['conflictReport']>(row.conflictReportJson, undefined),
    risk: row.risk,
    metadata: parseJson<ApprovalRecord['metadata']>(row.metadataJson, undefined),
    policyRuleId: row.policyRuleId ?? undefined,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    resolvedAt: row.resolvedAt ?? undefined,
    resolution: parseJson<ApprovalRecord['resolution']>(row.resolutionJson, undefined),
    audit: parseJson<ApprovalAuditEvent[]>(row.auditJson, []),
    fingerprint: row.fingerprint,
    continuation: parseJson<ApprovalRecord['continuation']>(row.continuationJson, undefined),
  };
}

function toApprovalValues(approval: ApprovalRecord): ApprovalInsert {
  const { packetId, laneId } = extractApprovalContextIds(approval.metadata);

  return {
    id: approval.id,
    projectId: approval.projectId,
    source: approval.source,
    runtime: approval.runtime,
    agent: approval.agent,
    sessionKey: approval.sessionKey,
    title: approval.title,
    description: approval.description,
    summary: approval.summary,
    toolName: approval.toolName ?? null,
    argsJson: serializeJson(approval.args),
    command: approval.command ?? null,
    editable: approval.editable ?? null,
    diffJson: serializeJson(approval.diff),
    gateResultJson: serializeJson(approval.gateResult),
    conflictReportJson: serializeJson(approval.conflictReport),
    risk: approval.risk,
    metadataJson: serializeJson(approval.metadata),
    packetId,
    laneId,
    policyRuleId: approval.policyRuleId ?? null,
    status: approval.status,
    createdAt: approval.createdAt,
    updatedAt: approval.updatedAt,
    resolvedAt: approval.resolvedAt ?? null,
    resolutionJson: serializeJson(approval.resolution),
    auditJson: JSON.stringify(approval.audit),
    fingerprint: approval.fingerprint,
    continuationJson: serializeJson(approval.continuation),
  };
}

function toApprovalUpdateValues(approval: ApprovalRecord): Omit<ApprovalInsert, 'id'> {
  const { id, ...values } = toApprovalValues(approval);
  void id;
  return values;
}

function insertApprovalRecord(approval: ApprovalRecord) {
  getApprovalDb().insert(approvalsTable).values(toApprovalValues(approval)).run();
}

function updateApprovalRecord(approval: ApprovalRecord) {
  getApprovalDb()
    .update(approvalsTable)
    .set(toApprovalUpdateValues(approval))
    .where(eq(approvalsTable.id, approval.id))
    .run();
}

function fingerprintForApproval(input: CreateApprovalInput) {
  const projectId = inferApprovalProjectId(input);
  return [
    projectId ?? '',
    input.source,
    input.runtime,
    input.sessionKey,
    input.toolName ?? '',
    input.summary,
    stableApprovalJson(input.args ?? {}),
  ].join('::');
}

function inferApprovalRepoPath(input: Pick<CreateApprovalInput, 'continuation' | 'metadata'>): string | null {
  const continuation = input.continuation;
  if (continuation?.kind === 'plan') return continuation.repoPath;
  if (continuation?.kind === 'llm-chat') return continuation.repoPath ?? null;
  if (continuation?.kind === 'runtime') return continuation.cwd ?? null;
  if (continuation?.kind === 'lane') return getLane(continuation.laneId)?.repoPath ?? null;
  const metadata = input.metadata;
  return metadata?.RepoPath
    ?? metadata?.repoPath
    ?? metadata?.Workspace
    ?? null;
}

function inferApprovalProjectId(input: Pick<CreateApprovalInput, 'projectId' | 'continuation' | 'metadata'>): string | null {
  const explicit = input.projectId?.trim();
  if (explicit) return explicit;
  const repoPath = inferApprovalRepoPath(input);
  return getActiveProjectScopeForRepoSync(repoPath).projectId;
}

function createApprovalRecord(input: CreateApprovalInput): ApprovalRecord {
  const createdAt = Date.now();
  return {
    id: `approval-${createdAt}-${Math.random().toString(36).slice(2, 8)}`,
    projectId: inferApprovalProjectId(input),
    source: input.source,
    runtime: input.runtime,
    agent: input.agent,
    sessionKey: input.sessionKey,
    title: input.title,
    description: input.description,
    summary: input.summary,
    toolName: input.toolName,
    args: input.args,
    command: input.command,
    editable: input.editable,
    diff: input.diff,
    gateResult: input.gateResult,
    conflictReport: input.conflictReport,
    risk: input.risk,
    metadata: input.metadata,
    policyRuleId: input.policyRuleId,
    status: 'pending',
    createdAt,
    updatedAt: createdAt,
    audit: [auditEvent('created', input.source === 'test' ? 'test' : 'system')],
    fingerprint: fingerprintForApproval(input),
    continuation: input.continuation,
  };
}

export function auditEvent(
  type: ApprovalAuditEvent['type'],
  actor: ApprovalActor,
  note?: string,
  details?: Partial<Omit<ApprovalAuditEvent, 'type' | 'actor' | 'timestamp' | 'note'>>,
): ApprovalAuditEvent {
  return {
    type,
    actor,
    timestamp: Date.now(),
    note: note?.trim() || undefined,
    ...details,
  };
}

export function insertApprovalEvent(approvalId: string, event: ApprovalAuditEvent): void {
  const { type: eventType, actor, note, timestamp, ...rest } = event;
  getApprovalDb().insert(approvalEventsTable).values({
    id: `evt-${approvalId}-${timestamp}-${Math.random().toString(36).slice(2, 8)}`,
    approvalId,
    eventType,
    actor,
    note: note ?? null,
    detailsJson: JSON.stringify(rest),
    timestamp,
  }).run();
}

export function listApprovalEvents(approvalId: string): ApprovalAuditEvent[] {
  return getApprovalDb()
    .select()
    .from(approvalEventsTable)
    .where(eq(approvalEventsTable.approvalId, approvalId))
    .orderBy(approvalEventsTable.timestamp)
    .all()
    .map((row) => ({
      type: row.eventType as ApprovalAuditEvent['type'],
      actor: row.actor as ApprovalActor,
      timestamp: row.timestamp,
      note: row.note ?? undefined,
      ...parseJson<Record<string, unknown>>(row.detailsJson, {}),
    })) as ApprovalAuditEvent[];
}

export function approvalSeverity(risk: ApprovalRisk): EventSeverity {
  if (risk === 'high') return 'critical';
  if (risk === 'medium') return 'warning';
  return 'info';
}

export function expireStaleApprovals() {
  const cutoff = Date.now() - STALE_APPROVAL_TTL_MS;
  const staleIds = getSqlite()
    .prepare(`
      SELECT id FROM approvals
      WHERE status = 'pending'
        AND created_at < ?
    `)
    .all(cutoff) as Array<{ id: string }>;

  let changes = 0;
  for (const { id } of staleIds) {
    const resolved = resolveApproval(id, 'reject', 'system', 'Expired: stale pending approval TTL exceeded');
    if (resolved) {
      changes += 1;
    }
  }

  if (changes > 0) {
    console.log(`[approvals] Expired ${changes} stale pending approvals`);
  }

  return changes;
}

export function listApprovals(options: { status?: ApprovalRecord['status'] | 'all'; sessionKey?: string; projectId?: string | null } = {}) {
  const { status = 'pending', sessionKey } = options;
  const projectId = options.projectId === undefined
    ? getActiveProjectScopeForRepoSync().projectId
    : options.projectId?.trim() || null;

  // Auto-expire stale pending approvals before querying
  if (status === 'pending' || status === 'all') {
    try {
      expireStaleApprovals();
    } catch {
      // Non-fatal — proceed with the query even if expiry fails
    }
  }

  const db = getApprovalDb();

  if (status === 'all' && sessionKey) {
    const conditions = [eq(approvalsTable.sessionKey, sessionKey)];
    if (projectId) conditions.push(eq(approvalsTable.projectId, projectId));
    return db
      .select()
      .from(approvalsTable)
      .where(and(...conditions))
      .orderBy(desc(approvalsTable.createdAt))
      .all()
      .map((row) => mapApprovalRow(row)!)
      .filter((approval): approval is ApprovalRecord => approval !== null)
      .filter((approval) => approval.args?.approvalRoute !== 'dispatcher');
  }

  if (status !== 'all' && sessionKey) {
    const conditions = [
      eq(approvalsTable.status, status),
      eq(approvalsTable.sessionKey, sessionKey),
    ];
    if (projectId) conditions.push(eq(approvalsTable.projectId, projectId));
    return db
      .select()
      .from(approvalsTable)
      .where(and(...conditions))
      .orderBy(desc(approvalsTable.createdAt))
      .all()
      .map((row) => mapApprovalRow(row)!)
      .filter((approval): approval is ApprovalRecord => approval !== null)
      .filter((approval) => approval.args?.approvalRoute !== 'dispatcher');
  }

  if (status !== 'all') {
    const conditions = [eq(approvalsTable.status, status)];
    if (projectId) conditions.push(eq(approvalsTable.projectId, projectId));
    return db
      .select()
      .from(approvalsTable)
      .where(and(...conditions))
      .orderBy(desc(approvalsTable.createdAt))
      .all()
      .map((row) => mapApprovalRow(row)!)
      .filter((approval): approval is ApprovalRecord => approval !== null)
      .filter((approval) => approval.args?.approvalRoute !== 'dispatcher');
  }

  const rows = projectId
    ? db
      .select()
      .from(approvalsTable)
      .where(eq(approvalsTable.projectId, projectId))
      .orderBy(desc(approvalsTable.createdAt))
      .all()
    : db
      .select()
      .from(approvalsTable)
      .orderBy(desc(approvalsTable.createdAt))
      .all();

  return rows
    .map((row) => mapApprovalRow(row)!)
    .filter((approval): approval is ApprovalRecord => approval !== null)
    .filter((approval) => approval.args?.approvalRoute !== 'dispatcher');
}

export function listUnsettledApprovalContinuations(options: { sessionKey?: string; projectId?: string | null } = {}) { return listApprovals({ status: 'all', ...options }).filter((approval) => approval.resolution?.continuationStatus === 'pending' || approval.resolution?.continuationStatus === 'outcome_unknown'); }
export function getApproval(id: string) {
  const row = getApprovalDb()
    .select()
    .from(approvalsTable)
    .where(eq(approvalsTable.id, id))
    .get();
  return mapApprovalRow(row);
}

export function markSecondPassAgreed(approvalId: string): void {
  const existing = getApproval(approvalId);
  if (!existing) return;

  updateApprovalRecord({
    ...existing,
    args: {
      ...existing.args,
      secondPassAgreed: true,
    },
    updatedAt: Date.now(),
  });
}

function mapApprovalRows(rows: ApprovalRow[]) {
  return rows
    .map((row) => mapApprovalRow(row)!)
    .filter((approval): approval is ApprovalRecord => approval !== null);
}

function queryApprovals(where: SQL<unknown>) {
  return mapApprovalRows(
    getApprovalDb()
      .select()
      .from(approvalsTable)
      .where(where)
      .orderBy(desc(approvalsTable.createdAt))
      .limit(APPROVAL_CONTEXT_LOOKUP_LIMIT)
      .all(),
  );
}

function listApprovalCandidatesForContext(options: {
  packetId?: string;
  laneId?: string;
  sessionKey?: string;
  projectId?: string | null;
}) {
  const packetId = normalizeApprovalLookupValue(options.packetId);
  const laneId = normalizeApprovalLookupValue(options.laneId);
  const sessionKey = normalizeApprovalLookupValue(options.sessionKey);
  const projectId = options.projectId === undefined
    ? getActiveProjectScopeForRepoSync().projectId
    : options.projectId?.trim() || null;
  const createdAfter = Date.now() - APPROVAL_CONTEXT_LOOKBACK_MS;
  const rowsById = new Map<string, ApprovalRecord>();

  if (sessionKey) {
    const conditions = [
      eq(approvalsTable.sessionKey, sessionKey),
      gte(approvalsTable.createdAt, createdAfter),
    ];
    if (projectId) conditions.push(eq(approvalsTable.projectId, projectId));
    for (const approval of queryApprovals(and(...conditions)!)) {
      rowsById.set(approval.id, approval);
    }
  }

  const additionalPredicate = buildApprovalContextMatchPredicate({ packetId, laneId });
  if (additionalPredicate) {
    const conditions = [
      gte(approvalsTable.createdAt, createdAfter),
      additionalPredicate,
    ];
    if (projectId) conditions.push(eq(approvalsTable.projectId, projectId));
    for (const approval of queryApprovals(and(...conditions)!)) {
      rowsById.set(approval.id, approval);
    }
  }

  return Array.from(rowsById.values())
    .sort((left, right) => right.createdAt - left.createdAt);
}

export function listApprovalsForContext(options: { packetId?: string; laneId?: string; sessionKey?: string; projectId?: string | null }) {
  return listApprovalCandidatesForContext(options)
    .map((approval) => ({
      approval,
      score: scoreApprovalContextMatch(approval, options),
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => (
      right.score - left.score
      || (right.approval.resolvedAt ?? right.approval.updatedAt) - (left.approval.resolvedAt ?? left.approval.updatedAt)
    ))
    .map((entry) => entry.approval);
}

export function createApproval(input: CreateApprovalInput) {
  const db = getApprovalDb();
  const fingerprint = fingerprintForApproval(input);
  const existing = mapApprovalRow(
    db
      .select()
      .from(approvalsTable)
      .where(and(
        eq(approvalsTable.status, 'pending'),
        eq(approvalsTable.fingerprint, fingerprint),
      ))
      .orderBy(desc(approvalsTable.updatedAt))
      .get(),
  );

  if (existing) {
    const next: ApprovalRecord = {
      ...existing,
      title: input.title,
      description: input.description,
      summary: input.summary,
      toolName: input.toolName,
      args: input.args,
      command: input.command,
      editable: input.editable,
      diff: input.diff,
      gateResult: input.gateResult ?? existing.gateResult,
      conflictReport: input.conflictReport ?? existing.conflictReport,
      risk: input.risk,
      metadata: input.metadata,
      continuation: input.continuation ?? existing.continuation,
      updatedAt: Date.now(),
      audit: [...existing.audit, auditEvent('updated', 'system', 'Pending approval reused for matching request.')],
    };
    updateApprovalRecord(next);
    return next;
  }

  const approval = createApprovalRecord(input);
  insertApprovalRecord(approval);
  notifyApprovalCreatedAsync(approval);
  return approval;
}

/**
 * Fire-and-forget push notification for a freshly-created approval.
 * Dynamic import keeps the push subsystem out of the approvals cold-path.
 */
function notifyApprovalCreatedAsync(approval: ApprovalRecord): void {
  void import('@/lib/push/notify')
    .then(({ notifyApprovalCreated }) => {
      notifyApprovalCreated({
        approvalId: approval.id,
        title: approval.title,
        risk: approval.risk,
      });
    })
    .catch((error) => {
      // Push is best-effort; never block approval creation on notification failure.
      console.warn('[approval-store] push notify failed', error);
    });
}

export function recordApprovalAudit(
  id: string,
  type: ApprovalAuditEvent['type'],
  actor: ApprovalActor,
  note?: string,
  details?: Partial<Omit<ApprovalAuditEvent, 'type' | 'actor' | 'timestamp' | 'note'>>,
) {
  const existing = getApproval(id);
  if (!existing) return null;

  const event = auditEvent(type, actor, note, details);

  insertApprovalEvent(id, event);

  // Also append to audit_json for backward compat reads
  const next: ApprovalRecord = {
    ...existing,
    updatedAt: Date.now(),
    audit: [...existing.audit, event],
  };
  updateApprovalRecord(next);
  return next;
}

export function supersedeOrchestratorReviewApprovals(packetId: string, reason: string): number {
  const normalizedPacketId = packetId.trim();
  if (!normalizedPacketId) return 0;
  const approvals = queryApprovals(and(
    eq(approvalsTable.packetId, normalizedPacketId),
    eq(approvalsTable.toolName, 'orchestrator_review'),
    eq(approvalsTable.status, 'approved'),
  )!)
    .filter((approval): approval is ApprovalRecord => approval?.args?.reviewSuperseded !== true);
  const supersededAt = Date.now();
  const note = reason.trim() || 'Superseded by a new packet attempt.';
  for (const approval of approvals) {
    const event = auditEvent('updated', 'system', note);
    updateApprovalRecord({
      ...approval,
      args: {
        ...approval.args,
        reviewSuperseded: true,
        reviewSupersededAt: supersededAt,
        reviewSupersededReason: note,
      },
      metadata: {
        ...approval.metadata,
        'Review State': 'superseded',
        'Superseded Reason': note,
      },
      updatedAt: supersededAt,
      audit: [...approval.audit, event],
    });
    insertApprovalEvent(approval.id, event);
  }
  return approvals.length;
}

export function finalizeOrchestratorReviewTurn(reviewTurnId: string, outcome: ReviewTurnOutcome): number {
  const normalizedTurnId = reviewTurnId.trim();
  if (!normalizedTurnId) return 0;
  const approvals = queryApprovals(eq(approvalsTable.toolName, 'orchestrator_review'))
    .filter((approval) => approval?.args?.reviewTurnId === normalizedTurnId);
  const finalizedAt = Date.now();
  for (const approval of approvals) {
    const discarded = outcome !== 'completed';
    const note = discarded
      ? `Review turn ${normalizedTurnId} ended as ${outcome}; approval is not merge-authorizing.`
      : `Review turn ${normalizedTurnId} completed.`;
    const event = auditEvent('updated', 'system', note);
    updateApprovalRecord({
      ...approval,
      args: {
        ...approval.args,
        reviewTurnId: normalizedTurnId,
        reviewTurnOutcome: outcome,
        ...(discarded ? {
          reviewSuperseded: true,
          reviewSupersededAt: finalizedAt,
          reviewSupersededReason: note,
        } : {}),
      },
      metadata: {
        ...approval.metadata,
        'Review Turn': normalizedTurnId,
        'Review Turn Outcome': outcome,
      },
      updatedAt: finalizedAt,
      audit: [...approval.audit, event],
    });
    insertApprovalEvent(approval.id, event);
  }
  return approvals.length;
}

export function recordOrchestratorReview(
  packetId: string,
  review: OrchestratorReviewRecordInput,
): ApprovalAuditEvent {
  const normalizedPacketId = packetId.trim();
  const normalizedReview = normalizeOrchestratorReview(review);
  const reviewTurnId = normalizedReview.reviewTurnId
    ?? `review-turn-standalone-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const reviewTurnOutcome = normalizedReview.reviewTurnOutcome ?? 'completed';
  const lane = normalizedPacketId ? findLaneByPacket(normalizedPacketId) : null;

  let approval = getApprovalDb()
    .select()
    .from(approvalsTable)
    .where(and(
      eq(approvalsTable.status, 'pending'),
      eq(approvalsTable.toolName, 'orchestrator_review'),
    ))
    .orderBy(desc(approvalsTable.updatedAt))
    .all()
    .map((row) => mapApprovalRow(row)!)
    .filter((candidate): candidate is ApprovalRecord => candidate !== null)
    .find((candidate) => isOrchestratorReviewApproval(candidate, normalizedPacketId, lane?.id ?? null)) ?? null;

  const shouldInsert = !approval;
  if (!approval) {
    approval = createApprovalRecord(buildOrchestratorReviewApprovalInput(normalizedPacketId, lane, normalizedReview));
  }

  const reviewEvent = buildOrchestratorReviewEvent(normalizedReview);
  const reviewedApproval: ApprovalRecord = {
    ...approval,
    risk: deriveOrchestratorReviewRisk(normalizedReview),
    updatedAt: reviewEvent.timestamp,
    metadata: {
      ...approval.metadata,
      Packet: normalizedPacketId,
      ...(lane ? {
        Lane: lane.id,
        Branch: lane.branch,
        Base: lane.baseBranch,
        Runtime: lane.runtime,
      } : {}),
      ...(normalizedReview.reviewer ? { Reviewer: normalizedReview.reviewer } : {}),
      ...(normalizedReview.diffSha ? { 'Diff SHA': normalizedReview.diffSha } : {}),
      ...(normalizedReview.reviewedHeadSha ? { 'Reviewed HEAD': normalizedReview.reviewedHeadSha } : {}),
      ...(normalizedReview.parseWarning ? { 'Parse Warning': normalizedReview.parseWarning } : {}),
    },
    args: {
      ...approval.args,
      packetId: normalizedPacketId,
      approved: normalizedReview.approved,
      findings: normalizedReview.findings,
      ...(normalizedReview.reviewedHeadSha ? { reviewedHeadSha: normalizedReview.reviewedHeadSha } : {}),
      ...(normalizedReview.contractCoverageEvidence ? { contractCoverageEvidence: normalizedReview.contractCoverageEvidence } : {}),
      requiresSecondPass: normalizedReview.requiresSecondPass === true,
      secondPassAgreed: approval.args?.secondPassAgreed === true ? true : false,
      ...(normalizedReview.parseWarning ? { parseWarning: normalizedReview.parseWarning } : {}),
      ...(normalizedReview.rawText ? { rawText: normalizedReview.rawText } : {}),
      reviewTurnId,
      reviewTurnOutcome,
    },
    audit: [...approval.audit, reviewEvent],
  };
  let nextApproval = reviewedApproval;
  if (normalizedReview.approved && allFindingsResolved(normalizedReview.findings) && reviewedApproval.status === 'pending') {
    const resolvedAt = Date.now();
    const reviewerLabel = normalizedReview.reviewer ? ` by ${normalizedReview.reviewer}` : '';
    nextApproval = {
      ...reviewedApproval,
      status: 'approved',
      updatedAt: resolvedAt,
      resolvedAt,
      resolution: {
        action: 'approved',
        actor: 'orchestrator',
        note: `Auto-approved after orchestrator review${reviewerLabel}.`,
      },
      audit: [
        ...reviewedApproval.audit,
        auditEvent('approved', 'orchestrator', `Auto-approved after orchestrator review${reviewerLabel}.`),
      ],
    };
  }

  if (shouldInsert) {
    insertApprovalRecord(nextApproval);
  } else {
    updateApprovalRecord(nextApproval);
  }
  insertApprovalEvent(nextApproval.id, reviewEvent);

  return reviewEvent;
}

export function listOrchestratorReviews(packetId: string) {
  const normalizedPacketId = packetId.trim();
  if (!normalizedPacketId) {
    return [] as ApprovalAuditEvent[];
  }

  const lane = findLaneByPacket(normalizedPacketId);
  const contextPredicate = buildApprovalContextMatchPredicate({
    packetId: normalizedPacketId,
    laneId: lane?.id ?? undefined,
  });
  if (!contextPredicate) {
    return [] as ApprovalAuditEvent[];
  }

  return queryApprovals(and(
    eq(approvalsTable.toolName, 'orchestrator_review'),
    gte(approvalsTable.createdAt, Date.now() - APPROVAL_CONTEXT_LOOKBACK_MS),
    contextPredicate,
  )!)
    .filter((approval) => isOrchestratorReviewApproval(approval, normalizedPacketId, lane?.id ?? null))
    .flatMap((approval) => approval.audit.filter((event) => event.type === 'orchestrator_review'))
    .sort((left, right) => right.timestamp - left.timestamp);
}

function inferApprovalRuntime(sessionKey: string) {
  if (sessionKey.startsWith('claude-code:')) return 'claude-code' as const;
  if (sessionKey.startsWith('gemini:')) return 'gemini' as const;
  if (sessionKey.startsWith('opencode:')) return 'opencode' as const;
  return 'codex' as const;
}

export function createTestApproval(sessionKey = 'codex:thoughts-test') {
  return createApproval({
    source: 'test',
    runtime: inferApprovalRuntime(sessionKey),
    agent: 'Test Harness',
    sessionKey,
    title: 'Execute shell command',
    description: 'Test approval for validating the shared desktop/mobile queue and resolution flow.',
    summary: 'Execute shell command',
    toolName: 'run_terminal_command',
    args: {
      command: 'rm -rf node_modules && npm install && npm run build',
    },
    command: 'rm -rf node_modules && npm install && npm run build',
    editable: true,
    risk: 'medium',
    metadata: {
      Lane: 'test-only',
      Session: sessionKey,
    },
  });
}

export function toMobileApprovalCard(approval: ApprovalRecord): MobileApprovalCard {
  return {
    id: approval.id,
    sessionKey: approval.sessionKey,
    agent: approval.agent,
    severity: approvalSeverity(approval.risk),
    title: approval.title,
    description: approval.description,
    metadata: approval.metadata,
    gateResult: approval.gateResult,
    conflictReport: approval.conflictReport,
    actions: {
      approve: { label: approval.editable ? 'Approve' : 'Allow' },
      reject: { label: 'Deny' },
    },
    createdAt: approval.createdAt,
  };
}
