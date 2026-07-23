import type Database from 'better-sqlite3';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import type { ApprovalRecord } from './types';
import { getDataDir } from '@/lib/data-dir-migration';

const LEGACY_STORE_PATH = path.join(getDataDir(), 'approvals.json');

interface LegacyApprovalStoreShape {
  version: 1;
  approvals: ApprovalRecord[];
}

function loadLegacyApprovalStore(): LegacyApprovalStoreShape | null {
  try {
    if (!existsSync(LEGACY_STORE_PATH)) {
      return null;
    }

    const raw = readFileSync(LEGACY_STORE_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<LegacyApprovalStoreShape> | null;
    if (!parsed || parsed.version !== 1) {
      console.warn('[approval-store] Legacy approvals.json has an unsupported version; skipping migration');
      return null;
    }

    return {
      version: 1,
      approvals: (parsed.approvals ?? []).filter(Boolean) as ApprovalRecord[],
    };
  } catch (error) {
    console.error('[approval-store] Failed to read legacy approvals.json:', error);
    return null;
  }
}

function countRows(sqlite: Database.Database, tableName: string): number {
  const row = sqlite.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get() as { count: number } | undefined;
  return row?.count ?? 0;
}

function serializeJson(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

export function migrateLegacyApprovalStoreIfNeeded(
  sqlite: Database.Database,
  options: { approvalsTablePreviouslyMissing: boolean },
): void {
  if (!existsSync(LEGACY_STORE_PATH)) {
    return;
  }

  const approvalCount = countRows(sqlite, 'approvals');
  const shouldImport = options.approvalsTablePreviouslyMissing || approvalCount === 0;

  if (!shouldImport) {
    console.warn('[approval-store] Legacy approvals.json still exists, but SQLite approvals already contain data; leaving the file in place');
    return;
  }

  const legacy = loadLegacyApprovalStore();
  if (!legacy) {
    return;
  }

  const approvalRecords = legacy.approvals ?? [];
  const insertApproval = sqlite.prepare(`
    INSERT INTO approvals (
      id,
      source,
      runtime,
      agent,
      session_key,
      title,
      description,
      summary,
      tool_name,
      args_json,
      command,
      editable,
      diff_json,
      risk,
      metadata_json,
      policy_rule_id,
      status,
      created_at,
      updated_at,
      resolved_at,
      resolution_json,
      audit_json,
      fingerprint,
      continuation_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const transaction = sqlite.transaction(() => {
    for (const approval of approvalRecords) {
      insertApproval.run(
        approval.id,
        approval.source,
        approval.runtime,
        approval.agent,
        approval.sessionKey,
        approval.title,
        approval.description,
        approval.summary,
        approval.toolName ?? null,
        serializeJson(approval.args),
        approval.command ?? null,
        typeof approval.editable === 'boolean' ? (approval.editable ? 1 : 0) : null,
        serializeJson(approval.diff),
        approval.risk,
        serializeJson(approval.metadata),
        approval.policyRuleId ?? null,
        approval.status,
        approval.createdAt,
        approval.updatedAt,
        approval.resolvedAt ?? null,
        serializeJson(approval.resolution),
        JSON.stringify(approval.audit ?? []),
        approval.fingerprint,
        serializeJson(approval.continuation),
      );
    }
  });

  transaction();

  try {
    unlinkSync(LEGACY_STORE_PATH);
  } catch (error) {
    console.error('[approval-store] Imported legacy approvals.json but failed to delete it:', error);
    return;
  }

  console.log(`[approval-store] Migrated ${approvalRecords.length} approvals from legacy approvals.json`);
}
