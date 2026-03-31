import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { findLaneByPacket } from '@/lib/lane/registry';
import type { Lane } from '@/lib/lane/types';
import type { EventSeverity } from '@/lib/fleet/types';
import type {
  ApprovalActor,
  ApprovalAuditEvent,
  ApprovalRecord,
  ApprovalRisk,
  CreateApprovalInput,
  MobileApprovalCard,
  OrchestratorReviewFinding,
} from '@/lib/approvals/types';

const APPROVALS_DIR = join(homedir(), '.cortex-ide');
const APPROVALS_PATH = join(APPROVALS_DIR, 'approvals.json');
const APPROVALS_TMP_PATH = `${APPROVALS_PATH}.tmp`;
const MAX_RESOLVED_TO_KEEP = 250;

interface ApprovalStoreShape {
  version: 1;
  approvals: ApprovalRecord[];
}

interface OrchestratorReviewRecordInput {
  findings: OrchestratorReviewFinding[];
  reviewer?: string;
  approved: boolean;
  diffSha?: string;
}

function ensureApprovalsDir() {
  mkdirSync(APPROVALS_DIR, { recursive: true });
}

function readStore(): ApprovalStoreShape {
  try {
    const raw = readFileSync(APPROVALS_PATH, 'utf8');
    const parsed = JSON.parse(raw) as Partial<ApprovalStoreShape>;
    if (!Array.isArray(parsed.approvals)) {
      return { version: 1, approvals: [] };
    }
    return {
      version: 1,
      approvals: parsed.approvals.filter(Boolean) as ApprovalRecord[],
    };
  } catch {
    return { version: 1, approvals: [] };
  }
}

function writeStore(store: ApprovalStoreShape) {
  ensureApprovalsDir();
  const resolved = store.approvals
    .filter((approval) => approval.status !== 'pending')
    .sort((left, right) => (right.resolvedAt ?? right.updatedAt) - (left.resolvedAt ?? left.updatedAt))
    .slice(0, MAX_RESOLVED_TO_KEEP);
  const pending = store.approvals.filter((approval) => approval.status === 'pending');
  const next: ApprovalStoreShape = {
    version: 1,
    approvals: [...pending, ...resolved],
  };
  writeFileSync(APPROVALS_TMP_PATH, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  renameSync(APPROVALS_TMP_PATH, APPROVALS_PATH);
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

function trimOptional(value?: string) {
  const normalized = value?.trim();
  return normalized || undefined;
}

function normalizeReviewFinding(finding: OrchestratorReviewFinding): OrchestratorReviewFinding {
  const normalizedLine = typeof finding.line === 'number' && Number.isFinite(finding.line) && finding.line > 0
    ? Math.floor(finding.line)
    : undefined;
  return {
    file: finding.file.trim(),
    line: normalizedLine,
    severity: finding.severity,
    description: finding.description.trim(),
    resolution: finding.resolution,
  };
}

function normalizeOrchestratorReview(review: {
  findings: OrchestratorReviewFinding[];
  reviewer?: string;
  approved: boolean;
  diffSha?: string;
}): OrchestratorReviewRecordInput {
  return {
    findings: review.findings.map(normalizeReviewFinding),
    reviewer: trimOptional(review.reviewer),
    approved: review.approved,
    diffSha: trimOptional(review.diffSha),
  };
}

function allFindingsResolved(findings: OrchestratorReviewFinding[]) {
  return findings.every((finding) => finding.resolution !== 'deferred');
}

function deriveOrchestratorReviewRisk(review: OrchestratorReviewRecordInput): ApprovalRisk {
  if (!review.approved) {
    return 'high';
  }

  if (review.findings.some((finding) => (
    finding.resolution === 'deferred'
    && (finding.severity === 'bug' || finding.severity === 'rule_violation')
  ))) {
    return 'high';
  }

  if (review.findings.length > 0) {
    return 'medium';
  }

  return 'low';
}

function buildOrchestratorReviewNote(review: OrchestratorReviewRecordInput) {
  const reviewer = review.reviewer ?? 'orchestrator';
  const verdict = review.approved ? 'approved' : 'requested changes';
  const findingCount = review.findings.length;
  const findingsSummary = findingCount === 0
    ? 'no findings'
    : `${findingCount} finding${findingCount === 1 ? '' : 's'}`;
  const diffSummary = review.diffSha ? ` Diff ${review.diffSha}.` : '';
  return `${reviewer} ${verdict} with ${findingsSummary}.${diffSummary}`;
}

function buildOrchestratorReviewEvent(review: OrchestratorReviewRecordInput): ApprovalAuditEvent {
  return {
    type: 'orchestrator_review',
    actor: 'orchestrator',
    timestamp: Date.now(),
    note: buildOrchestratorReviewNote(review),
    findings: review.findings.length > 0 ? review.findings : undefined,
    reviewer: review.reviewer,
    approved: review.approved,
    diffSha: review.diffSha,
  };
}

function buildOrchestratorReviewApprovalInput(
  packetId: string,
  lane: Lane | null,
  review: OrchestratorReviewRecordInput,
): CreateApprovalInput {
  return {
    source: 'runtime',
    runtime: lane?.runtime ?? 'codex',
    agent: lane?.label ?? review.reviewer ?? 'Orchestrator',
    sessionKey: lane?.sessionKey || (lane ? `lane:${lane.id}` : `packet:${packetId}`),
    title: 'Orchestrator review',
    description: lane
      ? `Orchestrator review for lane "${lane.label}" (${lane.branch} → ${lane.baseBranch})`
      : `Orchestrator review for packet ${packetId}`,
    summary: lane
      ? `Orchestrator review: ${lane.branch} → ${lane.baseBranch}`
      : `Orchestrator review: ${packetId}`,
    toolName: 'orchestrator_review',
    risk: deriveOrchestratorReviewRisk(review),
    metadata: {
      Packet: packetId,
      ...(lane ? {
        Lane: lane.id,
        Branch: lane.branch,
        Base: lane.baseBranch,
        Runtime: lane.runtime,
      } : {}),
      ...(review.reviewer ? { Reviewer: review.reviewer } : {}),
      ...(review.diffSha ? { 'Diff SHA': review.diffSha } : {}),
    },
  };
}

function isOrchestratorReviewApproval(
  approval: ApprovalRecord,
  packetId: string,
  laneId?: string | null,
) {
  if (approval.toolName !== 'orchestrator_review') {
    return false;
  }

  const metadataPacketId = approval.metadata?.Packet;
  const metadataLaneId = approval.metadata?.Lane;
  return metadataPacketId === packetId || (laneId ? metadataLaneId === laneId : false);
}

export function approvalSeverity(risk: ApprovalRisk): EventSeverity {
  if (risk === 'high') return 'critical';
  if (risk === 'medium') return 'warning';
  return 'info';
}

export function listApprovals(options: { status?: ApprovalRecord['status'] | 'all'; sessionKey?: string } = {}) {
  const { status = 'pending', sessionKey } = options;
  const store = readStore();
  return store.approvals
    .filter((approval) => (status === 'all' ? true : approval.status === status))
    .filter((approval) => (sessionKey ? approval.sessionKey === sessionKey : true))
    .sort((left, right) => right.createdAt - left.createdAt);
}

export function getApproval(id: string) {
  const store = readStore();
  return store.approvals.find((approval) => approval.id === id) ?? null;
}

function normalizeApprovalLookupValue(value?: string | null) {
  return value?.trim() ?? '';
}

function scoreApprovalContextMatch(
  approval: ApprovalRecord,
  options: { packetId?: string; laneId?: string; sessionKey?: string },
) {
  const packetId = normalizeApprovalLookupValue(options.packetId);
  const laneId = normalizeApprovalLookupValue(options.laneId);
  const sessionKey = normalizeApprovalLookupValue(options.sessionKey);
  const metadataPacketId = normalizeApprovalLookupValue(approval.metadata?.Packet);
  const metadataLaneId = normalizeApprovalLookupValue(approval.metadata?.Lane);
  const approvalSessionKey = normalizeApprovalLookupValue(approval.sessionKey);

  if (packetId && metadataPacketId === packetId) {
    return 3;
  }
  if (laneId && metadataLaneId === laneId) {
    return 2;
  }
  if (sessionKey && approvalSessionKey === sessionKey) {
    return 1;
  }
  return 0;
}

export function listApprovalsForContext(options: { packetId?: string; laneId?: string; sessionKey?: string }) {
  const store = readStore();
  return store.approvals
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
  const store = readStore();
  const fingerprint = fingerprintForApproval(input);
  const existing = store.approvals.find((approval) => (
    approval.status === 'pending'
    && approval.fingerprint === fingerprint
  ));

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
      risk: input.risk,
      metadata: input.metadata,
      continuation: input.continuation ?? existing.continuation,
      updatedAt: Date.now(),
      audit: [...existing.audit, auditEvent('updated', 'system', 'Pending approval reused for matching request.')],
    };
    store.approvals = store.approvals.map((approval) => approval.id === existing.id ? next : approval);
    writeStore(store);
    return next;
  }

  const approval = createApprovalRecord(input);
  store.approvals = [approval, ...store.approvals];
  writeStore(store);
  return approval;
}

export function recordApprovalAudit(
  id: string,
  type: ApprovalAuditEvent['type'],
  actor: ApprovalActor,
  note?: string,
  details?: Partial<Omit<ApprovalAuditEvent, 'type' | 'actor' | 'timestamp' | 'note'>>,
) {
  const store = readStore();
  const existing = store.approvals.find((approval) => approval.id === id);
  if (!existing) return null;
  const next: ApprovalRecord = {
    ...existing,
    updatedAt: Date.now(),
    audit: [...existing.audit, auditEvent(type, actor, note, details)],
  };
  store.approvals = store.approvals.map((approval) => approval.id === id ? next : approval);
  writeStore(store);
  return next;
}

export function resolveApproval(id: string, action: 'approve' | 'reject', actor: ApprovalActor, note?: string) {
  const store = readStore();
  const existing = store.approvals.find((approval) => approval.id === id);
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
  store.approvals = store.approvals.map((approval) => approval.id === id ? next : approval);
  writeStore(store);
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
  const store = readStore();

  let approval = store.approvals
    .filter((candidate) => candidate.status === 'pending' && isOrchestratorReviewApproval(candidate, normalizedPacketId, lane?.id ?? null))
    .sort((left, right) => right.updatedAt - left.updatedAt)[0];

  if (!approval) {
    approval = createApprovalRecord(buildOrchestratorReviewApprovalInput(normalizedPacketId, lane, normalizedReview));
    store.approvals = [approval, ...store.approvals];
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

  store.approvals = store.approvals.map((candidate) => candidate.id === approval.id ? nextApproval : candidate);
  writeStore(store);
  return reviewEvent;
}

export function listOrchestratorReviews(packetId: string) {
  const normalizedPacketId = packetId.trim();
  if (!normalizedPacketId) {
    return [] as ApprovalAuditEvent[];
  }

  const lane = findLaneByPacket(normalizedPacketId);
  const store = readStore();
  return store.approvals
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
    actions: {
      approve: { label: approval.editable ? 'Approve' : 'Allow' },
      reject: { label: 'Deny' },
    },
    createdAt: approval.createdAt,
  };
}
