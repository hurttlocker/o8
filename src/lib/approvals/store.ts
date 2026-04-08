import { and, desc, eq, gte, type SQL } from 'drizzle-orm';
import {
  buildApprovalContextMatchPredicate,
  extractApprovalContextIds,
  isOrchestratorReviewApproval,
  normalizeApprovalLookupValue,
  scoreApprovalContextMatch,
} from '@/lib/approvals/context';
import {
  allFindingsResolved,
  buildOrchestratorReviewApprovalInput,
  buildOrchestratorReviewEvent,
  deriveOrchestratorReviewRisk,
  normalizeOrchestratorReview,
} from '@/lib/approvals/orchestrator-review';
import { approvals as approvalsTable, approvalEvents as approvalEventsTable, getDb, getSqlite } from '@/lib/db';
import type { EventSeverity } from '@/lib/fleet/types';
import { findLaneByPacket } from '@/lib/lane/registry';
import type {
  ApprovalActor,
  ApprovalAuditEvent,
  ApprovalRecord,
  ApprovalRisk,
  CreateApprovalInput,
  MobileApprovalCard,
  OrchestratorReviewFinding,
} from '@/lib/approvals/types';

type ApprovalRow = typeof approvalsTable.$inferSelect;
type ApprovalInsert = typeof approvalsTable.$inferInsert;

const APPROVAL_CONTEXT_LOOKUP_LIMIT = 100;
const APPROVAL_CONTEXT_LOOKBACK_MS = 1000 * 60 * 60 * 24 * 90;
const STALE_APPROVAL_TTL_MS = 1000 * 60 * 30;

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

function normalizeForFingerprint(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeForFingerprint);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, normalizeForFingerprint(nested)]),
    );
  }
  return value;
}

function stableJson(value: unknown) {
  return JSON.stringify(normalizeForFingerprint(value));
}

function fingerprintForApproval(input: CreateApprovalInput) {
  return [
    input.source,
    input.runtime,
    input.sessionKey,
    input.toolName ?? '',
    input.summary,
    stableJson(input.args ?? {}),
  ].join('::');
}

function createApprovalRecord(input: CreateApprovalInput): ApprovalRecord {
  const createdAt = Date.now();
  return {
    id: `approval-${createdAt}-${Math.random().toString(36).slice(2, 8)}`,
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

function auditEvent(
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

function insertApprovalEvent(approvalId: string, event: ApprovalAuditEvent): void {
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
  const result = getSqlite()
    .prepare(`
      UPDATE approvals
      SET status = 'rejected'
      WHERE status = 'pending'
        AND created_at < ?
    `)
    .run(cutoff);

  if (result.changes > 0) {
    console.log(`[approvals] Expired ${result.changes} stale pending approvals`);
  }

  return result.changes;
}

export function listApprovals(options: { status?: ApprovalRecord['status'] | 'all'; sessionKey?: string } = {}) {
  const { status = 'pending', sessionKey } = options;

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
    return db
      .select()
      .from(approvalsTable)
      .where(eq(approvalsTable.sessionKey, sessionKey))
      .orderBy(desc(approvalsTable.createdAt))
      .all()
      .map((row) => mapApprovalRow(row)!)
      .filter((approval): approval is ApprovalRecord => approval !== null);
  }

  if (status !== 'all' && sessionKey) {
    return db
      .select()
      .from(approvalsTable)
      .where(and(
        eq(approvalsTable.status, status),
        eq(approvalsTable.sessionKey, sessionKey),
      ))
      .orderBy(desc(approvalsTable.createdAt))
      .all()
      .map((row) => mapApprovalRow(row)!)
      .filter((approval): approval is ApprovalRecord => approval !== null);
  }

  if (status !== 'all') {
    return db
      .select()
      .from(approvalsTable)
      .where(eq(approvalsTable.status, status))
      .orderBy(desc(approvalsTable.createdAt))
      .all()
      .map((row) => mapApprovalRow(row)!)
      .filter((approval): approval is ApprovalRecord => approval !== null);
  }

  return db
    .select()
    .from(approvalsTable)
    .orderBy(desc(approvalsTable.createdAt))
    .all()
    .map((row) => mapApprovalRow(row)!)
    .filter((approval): approval is ApprovalRecord => approval !== null);
}

export function getApproval(id: string) {
  const row = getApprovalDb()
    .select()
    .from(approvalsTable)
    .where(eq(approvalsTable.id, id))
    .get();
  return mapApprovalRow(row);
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
}) {
  const packetId = normalizeApprovalLookupValue(options.packetId);
  const laneId = normalizeApprovalLookupValue(options.laneId);
  const sessionKey = normalizeApprovalLookupValue(options.sessionKey);
  const createdAfter = Date.now() - APPROVAL_CONTEXT_LOOKBACK_MS;
  const rowsById = new Map<string, ApprovalRecord>();

  if (sessionKey) {
    for (const approval of queryApprovals(and(
      eq(approvalsTable.sessionKey, sessionKey),
      gte(approvalsTable.createdAt, createdAfter),
    )!)) {
      rowsById.set(approval.id, approval);
    }
  }

  const additionalPredicate = buildApprovalContextMatchPredicate({ packetId, laneId });
  if (additionalPredicate) {
    for (const approval of queryApprovals(and(
      gte(approvalsTable.createdAt, createdAfter),
      additionalPredicate,
    )!)) {
      rowsById.set(approval.id, approval);
    }
  }

  return Array.from(rowsById.values())
    .sort((left, right) => right.createdAt - left.createdAt);
}

export function listApprovalsForContext(options: { packetId?: string; laneId?: string; sessionKey?: string }) {
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
  return approval;
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

  // Write to normalized events table (primary)
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

export function resolveApproval(id: string, action: 'approve' | 'reject', actor: ApprovalActor, note?: string) {
  const existing = getApproval(id);
  if (!existing) {
    return null;
  }

  if (existing.status !== 'pending') {
    return existing;
  }

  const resolvedAt = Date.now();
  const nextStatus = action === 'approve' ? 'approved' : 'rejected';
  const next: ApprovalRecord = {
    ...existing,
    status: nextStatus,
    updatedAt: resolvedAt,
    resolvedAt,
    resolution: {
      action: nextStatus,
      actor,
      note: note?.trim() || undefined,
    },
    audit: [...existing.audit, auditEvent(action === 'approve' ? 'approved' : 'rejected', actor, note)],
  };
  updateApprovalRecord(next);
  return next;
}

export function recordOrchestratorReview(
  packetId: string,
  review: {
    findings: OrchestratorReviewFinding[];
    reviewer?: string;
    approved: boolean;
    diffSha?: string;
  },
): ApprovalAuditEvent {
  const normalizedPacketId = packetId.trim();
  const normalizedReview = normalizeOrchestratorReview(review);
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
  if (sessionKey.startsWith('claude-code:')) return 'claude-code';
  if (sessionKey.startsWith('codex')) return 'codex';
  return 'codex';
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
