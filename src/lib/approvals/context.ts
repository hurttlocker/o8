import { and, eq, or, sql, type SQL } from 'drizzle-orm';
import type { ApprovalRecord } from '@/lib/approvals/types';
import { approvals } from '@/lib/db/schema';

export interface ApprovalContextOptions {
  packetId?: string;
  laneId?: string;
  sessionKey?: string;
}

interface ApprovalContextIds {
  packetId: string | null;
  laneId: string | null;
}

export function normalizeApprovalLookupValue(value?: string | null) {
  return value?.trim() ?? '';
}

function extractContextValue(metadata: Record<string, unknown>, key: 'Packet' | 'Lane') {
  const value = metadata[key];
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = normalizeApprovalLookupValue(value);
  return normalized || null;
}

function parseApprovalMetadataJson(metadataJson?: string | null): Record<string, unknown> | null {
  if (!metadataJson) {
    return null;
  }

  try {
    const parsed = JSON.parse(metadataJson);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Invalid metadata should not block reads or migrations.
  }

  return null;
}

function combinePredicates(
  predicates: SQL<unknown>[],
  operator: 'and' | 'or',
): SQL<unknown> | undefined {
  if (predicates.length === 0) {
    return undefined;
  }
  if (predicates.length === 1) {
    return predicates[0];
  }
  return operator === 'and' ? and(...predicates)! : or(...predicates)!;
}

function escapeSqlLikePattern(value: string) {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll('%', '\\%')
    .replaceAll('_', '\\_');
}

function approvalSessionKeyContains(value: string): SQL<unknown> {
  return sql<boolean>`${approvals.sessionKey} LIKE ${`%${escapeSqlLikePattern(value)}%`} ESCAPE '\\'`;
}

export function extractApprovalContextIds(metadata?: Record<string, string> | null): ApprovalContextIds {
  if (!metadata) {
    return { packetId: null, laneId: null };
  }

  const contextMetadata = metadata as Record<string, unknown>;
  return {
    packetId: extractContextValue(contextMetadata, 'Packet'),
    laneId: extractContextValue(contextMetadata, 'Lane'),
  };
}

export function extractApprovalContextIdsFromMetadataJson(metadataJson?: string | null): ApprovalContextIds {
  const metadata = parseApprovalMetadataJson(metadataJson);
  if (!metadata) {
    return { packetId: null, laneId: null };
  }

  return {
    packetId: extractContextValue(metadata, 'Packet'),
    laneId: extractContextValue(metadata, 'Lane'),
  };
}

export function buildApprovalContextMatchPredicate(options: ApprovalContextOptions): SQL<unknown> | undefined {
  const packetId = normalizeApprovalLookupValue(options.packetId);
  const laneId = normalizeApprovalLookupValue(options.laneId);
  const sessionKey = normalizeApprovalLookupValue(options.sessionKey);
  const predicates: SQL<unknown>[] = [];

  if (sessionKey) {
    predicates.push(eq(approvals.sessionKey, sessionKey));
  }
  if (packetId) {
    predicates.push(eq(approvals.packetId, packetId));
    predicates.push(approvalSessionKeyContains(packetId));
  }
  if (laneId) {
    predicates.push(eq(approvals.laneId, laneId));
    predicates.push(approvalSessionKeyContains(laneId));
  }

  return combinePredicates(predicates, 'or');
}

export function scoreApprovalContextMatch(
  approval: ApprovalRecord,
  options: ApprovalContextOptions,
) {
  const packetId = normalizeApprovalLookupValue(options.packetId);
  const laneId = normalizeApprovalLookupValue(options.laneId);
  const sessionKey = normalizeApprovalLookupValue(options.sessionKey);
  const { packetId: approvalPacketId, laneId: approvalLaneId } = extractApprovalContextIds(approval.metadata);
  const approvalSessionKey = normalizeApprovalLookupValue(approval.sessionKey);

  if (packetId && approvalPacketId === packetId) {
    return 3;
  }
  if (laneId && approvalLaneId === laneId) {
    return 2;
  }
  if (sessionKey && approvalSessionKey === sessionKey) {
    return 1;
  }
  return 0;
}

export function isOrchestratorReviewApproval(
  approval: ApprovalRecord,
  packetId: string,
  laneId?: string | null,
) {
  if (approval.toolName !== 'orchestrator_review') {
    return false;
  }

  const { packetId: approvalPacketId, laneId: approvalLaneId } = extractApprovalContextIds(approval.metadata);
  return approvalPacketId === packetId || (laneId ? approvalLaneId === laneId : false);
}
