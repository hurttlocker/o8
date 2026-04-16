import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { dispatchRules, getDb } from '@/lib/db';

export type Rule = typeof dispatchRules.$inferSelect;

type DispatchRuleDb = ReturnType<typeof getDb>;

interface RecordDispatchRuleInput {
  repoPath: string;
  packetType: string;
  ruleText: string;
  source: Rule['source'];
  db?: DispatchRuleDb;
}

interface GetTopRulesForPacketInput {
  repoPath: string;
  packetType: string;
  limit?: number;
  db?: DispatchRuleDb;
}

function getDispatchRuleDb(db: DispatchRuleDb = getDb()) {
  if (!db) {
    throw new Error('[dispatch-rules] SQLite database is unavailable');
  }
  return db;
}

function nowIso() {
  return new Date().toISOString();
}

export function recordDispatchRule({
  repoPath,
  packetType,
  ruleText,
  source,
  db,
}: RecordDispatchRuleInput): string {
  const resolvedDb = getDispatchRuleDb(db);

  return resolvedDb.transaction((tx) => {
    const existing = tx
      .select({
        id: dispatchRules.id,
        signalScore: dispatchRules.signalScore,
      })
      .from(dispatchRules)
      .where(and(
        eq(dispatchRules.repoPath, repoPath),
        eq(dispatchRules.packetType, packetType),
        eq(dispatchRules.ruleText, ruleText),
      ))
      .get();

    if (existing) {
      tx
        .update(dispatchRules)
        .set({ signalScore: existing.signalScore + 0.5 })
        .where(eq(dispatchRules.id, existing.id))
        .run();
      return existing.id;
    }

    const id = randomUUID();
    tx.insert(dispatchRules).values({
      id,
      repoPath,
      packetType,
      ruleText,
      source,
      createdAt: nowIso(),
    }).run();
    return id;
  });
}

export function getTopRulesForPacket({
  repoPath,
  packetType,
  limit = 5,
  db,
}: GetTopRulesForPacketInput): Rule[] {
  const safeLimit = Math.max(0, Math.floor(limit));
  if (safeLimit === 0) {
    return [];
  }

  const resolvedDb = getDispatchRuleDb(db);
  return resolvedDb.transaction((tx) => {
    const rows = tx
      .select()
      .from(dispatchRules)
      .where(and(
        eq(dispatchRules.repoPath, repoPath),
        eq(dispatchRules.packetType, packetType),
        isNull(dispatchRules.demotedAt),
      ))
      .orderBy(desc(dispatchRules.signalScore))
      .limit(safeLimit)
      .all();

    if (rows.length === 0) {
      return rows;
    }

    const lastUsedAt = nowIso();
    tx
      .update(dispatchRules)
      .set({ lastUsedAt })
      .where(inArray(dispatchRules.id, rows.map((row) => row.id)))
      .run();

    return rows.map((row) => ({ ...row, lastUsedAt }));
  });
}

export function promoteRule(id: string, db?: DispatchRuleDb): void {
  getDispatchRuleDb(db)
    .update(dispatchRules)
    .set({ promotedAt: nowIso() })
    .where(eq(dispatchRules.id, id))
    .run();
}

export function demoteRule(id: string, db?: DispatchRuleDb): void {
  getDispatchRuleDb(db)
    .update(dispatchRules)
    .set({ demotedAt: nowIso() })
    .where(eq(dispatchRules.id, id))
    .run();
}
