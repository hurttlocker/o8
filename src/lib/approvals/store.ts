import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { EventSeverity } from '@/lib/fleet/types';
import type {
  ApprovalActor,
  ApprovalAuditEvent,
  ApprovalRecord,
  ApprovalRisk,
  CreateApprovalInput,
  MobileApprovalCard,
} from './types';

const APPROVALS_DIR = join(homedir(), '.cortex-ide');
const APPROVALS_PATH = join(APPROVALS_DIR, 'approvals.json');
const APPROVALS_TMP_PATH = `${APPROVALS_PATH}.tmp`;
const MAX_RESOLVED_TO_KEEP = 250;

interface ApprovalStoreShape {
  version: 1;
  approvals: ApprovalRecord[];
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

function auditEvent(
  type: ApprovalAuditEvent['type'],
  actor: ApprovalActor,
  note?: string,
): ApprovalAuditEvent {
  return {
    type,
    actor,
    timestamp: Date.now(),
    note: note?.trim() || undefined,
  };
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

  const createdAt = Date.now();
  const approval: ApprovalRecord = {
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
    status: 'pending',
    createdAt,
    updatedAt: createdAt,
    audit: [auditEvent('created', input.source === 'test' ? 'test' : 'system')],
    fingerprint,
    continuation: input.continuation,
  };
  store.approvals = [approval, ...store.approvals];
  writeStore(store);
  return approval;
}

export function recordApprovalAudit(id: string, type: ApprovalAuditEvent['type'], actor: ApprovalActor, note?: string) {
  const store = readStore();
  const existing = store.approvals.find((approval) => approval.id === id);
  if (!existing) return null;
  const next: ApprovalRecord = {
    ...existing,
    updatedAt: Date.now(),
    audit: [...existing.audit, auditEvent(type, actor, note)],
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

function inferApprovalRuntime(sessionKey: string) {
  if (sessionKey.startsWith('claude-code:')) return 'claude-code';
  if (sessionKey.startsWith('codex')) return 'codex';
  return 'openclaw';
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
