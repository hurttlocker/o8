// #569 — Standard ESM imports. The original CJS boundary was a workaround for
// the #568 tsx -e interop quirk — that smoke-test pattern was retired in
// CLAUDE.md (use `tsx <file>` instead of `tsx -e "import(...)"`). Plain ESM
// matches every other module in the codebase.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { and, eq, gte, isNull, or, sql } from 'drizzle-orm';
import { approvals, dispatchRules, getDb, lanes } from '@/lib/db';
import { deleteRule, demoteRule, promoteRule } from '@/lib/dispatch/rules-store';

const execFileAsync = promisify(execFile);
const APPROVAL_LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000;
const STALE_DECAY_MS = 7 * 24 * 60 * 60 * 1000;
const DROP_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
const APPROVED_SIGNAL_WEIGHT = 1;
const REJECTED_SIGNAL_WEIGHT = -1.5;
const PROMOTION_THRESHOLD = 5;
const DEMOTION_THRESHOLD = -2;

type Rule = import('@/lib/dispatch/rules-store').Rule;
type DispatchDb = NonNullable<ReturnType<typeof getDb>>;
type DispatchTx = Parameters<Parameters<DispatchDb['transaction']>[0]>[0];

interface RulesPromotionCycleResult {
  promoted: number;
  demoted: number;
}

function escapeSqlLikePattern(value: string) {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll('%', '\\%')
    .replaceAll('_', '\\_');
}

function parseIsoMs(value?: string | null): number | null {
  if (!value) {
    return null;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isOlderThan(
  value: string | null,
  nowMs: number,
  thresholdMs: number,
  options?: { treatMissingAsStale?: boolean },
) {
  const parsed = parseIsoMs(value);
  if (parsed === null) {
    return options?.treatMissingAsStale ?? false;
  }
  return nowMs - parsed > thresholdMs;
}

function reviewContainsRuleText(ruleText: string) {
  const normalizedRuleText = ruleText.trim().toLowerCase();
  if (!normalizedRuleText) {
    return sql<boolean>`0`;
  }
  return sql<boolean>`LOWER(${approvals.description}) LIKE ${`%${escapeSqlLikePattern(normalizedRuleText)}%`} ESCAPE '\\'`;
}

function countMatchingApprovals(
  tx: DispatchTx,
  rule: Rule,
  status: 'approved' | 'rejected',
  createdAfter: number,
) {
  const row = tx
    .select({ count: sql<number>`COUNT(DISTINCT ${approvals.id})` })
    .from(approvals)
    .innerJoin(
      lanes,
      or(
        eq(approvals.laneId, lanes.id),
        and(
          isNull(approvals.laneId),
          eq(approvals.packetId, lanes.packetId),
        ),
      )!,
    )
    .where(and(
      eq(approvals.status, status),
      gte(approvals.createdAt, createdAfter),
      eq(lanes.repoPath, rule.repoPath),
      reviewContainsRuleText(rule.ruleText),
    ))
    .get();

  return row?.count ?? 0;
}

function listMatchingApprovedMerges(tx: DispatchTx, rule: Rule, createdAfter: number) {
  return tx.select({ laneId: lanes.id, label: lanes.label, resolvedAt: approvals.resolvedAt }).from(approvals)
    .innerJoin(lanes, or(eq(approvals.laneId, lanes.id), and(isNull(approvals.laneId), eq(approvals.packetId, lanes.packetId)))!)
    .where(and(eq(approvals.status, 'approved'), gte(approvals.createdAt, createdAfter), eq(lanes.status, 'completed'), eq(lanes.repoPath, rule.repoPath), reviewContainsRuleText(rule.ruleText))).all();
}

async function countRecentReverts(repoPath: string, merges: Array<{ label: string; resolvedAt: number | null }>) {
  let reverted = 0;
  for (const merge of merges) {
    if (!merge.resolvedAt) continue;
    const since = new Date(merge.resolvedAt).toISOString();
    const until = new Date(merge.resolvedAt + (24 * 60 * 60 * 1000)).toISOString();
    try {
      const { stdout: mergeLog } = await execFileAsync('git', ['log', '--all', `--since=${since}`, `--until=${until}`, '--format=%H%x09%s'], { windowsHide: true, cwd: repoPath, maxBuffer: 1024 * 1024 });
      const mergeSha = mergeLog.split('\n').find((line) => line.includes(`\tMerge lane ${merge.label} (`))?.split('\t')[0];
      if (!mergeSha) continue;
      const { stdout: revertLog } = await execFileAsync('git', ['log', '--all', `--since=${since}`, `--until=${until}`, '--fixed-strings', '--grep', mergeSha, '--format=%H'], { windowsHide: true, cwd: repoPath, maxBuffer: 1024 * 1024 });
      reverted += revertLog.trim() ? 1 : 0;
    } catch {}
  }
  return reverted;
}

export async function runRulesPromotionCycle(options?: { now?: Date }): Promise<RulesPromotionCycleResult> {
  const db = getDb();
  if (!db) {
    throw new Error('[rules-promotion] SQLite database is unavailable');
  }

  const now = options?.now ?? new Date();
  const nowMs = now.getTime();
  const createdAfter = nowMs - APPROVAL_LOOKBACK_MS;
  const candidates = db
    .select()
    .from(dispatchRules)
    .where(and(
      isNull(dispatchRules.promotedAt),
      isNull(dispatchRules.demotedAt),
    ))
    .all();

  let promoted = 0;
  let demoted = 0;

  for (const rule of candidates) {
    try {
      const approvedMerges = Array.from(new Map(db.transaction((tx) => listMatchingApprovedMerges(tx, rule, createdAfter)).map((merge) => [merge.laneId, merge])).values());
      const rejectedCount = db.transaction((tx) => countMatchingApprovals(tx, rule, 'rejected', createdAfter));
      const revertedCount = await countRecentReverts(rule.repoPath, approvedMerges);

      db.transaction((tx) => {
        let workingScore = rule.signalScore
          + (approvedMerges.length * APPROVED_SIGNAL_WEIGHT)
          + (rejectedCount * REJECTED_SIGNAL_WEIGHT)
          + (revertedCount * -3);

        if (isOlderThan(rule.lastUsedAt, nowMs, STALE_DECAY_MS, { treatMissingAsStale: true })) {
          workingScore *= 0.5;
        }

        const shouldPromote = workingScore >= PROMOTION_THRESHOLD;
        const shouldDemote = workingScore <= DEMOTION_THRESHOLD;
        const shouldDrop = (
          !shouldPromote
          && !shouldDemote
          && isOlderThan(rule.lastUsedAt, nowMs, DROP_AFTER_MS)
          && rule.signalScore < 1
        );
        if (shouldDrop) {
          deleteRule(rule.id, tx);
          return;
        }

        tx
          .update(dispatchRules)
          .set({ signalScore: workingScore })
          .where(eq(dispatchRules.id, rule.id))
          .run();

        if (shouldPromote) {
          promoteRule(rule.id, tx);
          promoted += 1;
          return;
        }

        if (shouldDemote) {
          demoteRule(rule.id, tx);
          demoted += 1;
        }
      });
    } catch (error) {
      console.warn(`[rules-promotion] Failed to score rule ${rule.id}:`, error);
    }
  }

  return {
    promoted,
    demoted,
  };
}
