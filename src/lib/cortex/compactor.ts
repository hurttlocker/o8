/**
 * Fact compactor — library extraction of scripts/compact-facts.ts (#961).
 *
 * All compaction jobs live here so they can be called from the in-process
 * scheduler (compactor-scheduler.ts) as well as from the CLI wrapper
 * (scripts/compact-facts.ts) without duplication.
 *
 * Exports:
 *   runCompaction(args, db)  — run all six jobs, returns a summary.
 *   CompactionArgs           — the parsed argument struct.
 *   CompactionResult         — what runCompaction returns.
 */

import type Database from 'better-sqlite3';

export interface CompactionArgs {
  dryRun: boolean;
  confidenceFloor: number;
  decayDays: number;
  decayFactor: number;
  jaccardThreshold: number;
  skipDecay: boolean;
  skipJaccard: boolean;
  reportContradictions: boolean;
  contradictionMinOverlap: number;
  /** #962 — enable Job 7 (cosine near-dup over facts.embedding). Off by default. */
  cosineDedup?: boolean;
  /** #962 — cosine similarity threshold for Job 7. Default 0.92. */
  cosineThreshold?: number;
}

export interface CompactionResult {
  orphansRemoved: number;
  lowConfRemoved: number;
  dupesRemoved: number;
  dupeGroupsMerged: number;
  decayed: number;
  jaccardRemoved: number;
  jaccardMerged: number;
  contradictionsReported: number;
  cosineRemoved: number;
  cosineMerged: number;
  elapsedMs: number;
}

// ── Internal types ────────────────────────────────────────────────────────────

interface CountRow { n: number }
interface DupeGroupRow { content: string; n: number }
interface BySourceRow { source_kind: string; n: number; avg_conf: number }

// ── Job 1 ─────────────────────────────────────────────────────────────────────

function gcOrphans(db: Database.Database, dryRun: boolean): { removed: number } {
  const candidates = [
    {
      label: 'github_comment',
      sql: `SELECT id FROM facts WHERE source_kind = 'github_comment'
              AND NOT EXISTS (SELECT 1 FROM github_comments WHERE id = facts.source_id)`,
    },
    {
      label: 'directive',
      sql: `SELECT id FROM facts WHERE source_kind = 'directive'
              AND NOT EXISTS (
                SELECT 1 FROM directives_fts
                 WHERE directive_id = substr(facts.source_id, length('directive:') + 1)
              )`,
    },
    {
      label: 'outcome',
      sql: `SELECT id FROM facts WHERE source_kind = 'outcome'
              AND NOT EXISTS (
                SELECT 1 FROM session_outcomes
                 WHERE id = substr(facts.source_id, length('outcome:') + 1)
              )`,
    },
    {
      label: 'pr',
      sql: `SELECT id FROM facts WHERE source_kind = 'pr'
              AND NOT EXISTS (
                SELECT 1 FROM github_pull_requests
                 WHERE pull_request_id = CAST(substr(facts.source_id, length('pr:') + 1) AS INTEGER)
              )`,
    },
    {
      label: 'issue',
      sql: `SELECT id FROM facts WHERE source_kind = 'issue'
              AND NOT EXISTS (
                SELECT 1 FROM github_issues
                 WHERE issue_id = CAST(substr(facts.source_id, length('issue:') + 1) AS INTEGER)
              )`,
    },
  ];

  let totalRemoved = 0;
  for (const { label, sql } of candidates) {
    const orphanIds = db.prepare(sql).all() as Array<{ id: string }>;
    if (orphanIds.length === 0) {
      console.log(`[gc] ${label}: 0 orphans`);
      continue;
    }
    console.log(`[gc] ${label}: ${orphanIds.length} orphans${dryRun ? ' (dry-run, not removing)' : ''}`);
    if (!dryRun) {
      const del = db.prepare(`DELETE FROM facts WHERE id = ?`);
      const tx = db.transaction((ids: Array<{ id: string }>) => {
        for (const { id } of ids) del.run(id);
      });
      tx(orphanIds);
    }
    totalRemoved += orphanIds.length;
  }
  return { removed: totalRemoved };
}

// ── Job 2 ─────────────────────────────────────────────────────────────────────

function dropLowConfidence(
  db: Database.Database,
  floor: number,
  dryRun: boolean,
): { removed: number } {
  const count = (
    db.prepare(`SELECT COUNT(*) AS n FROM facts WHERE confidence < ?`).get(floor) as CountRow
  ).n;
  if (count === 0) {
    console.log(`[low-conf] 0 facts below ${floor}`);
    return { removed: 0 };
  }
  console.log(`[low-conf] ${count} facts below ${floor}${dryRun ? ' (dry-run, not removing)' : ''}`);
  if (!dryRun) {
    db.prepare(`DELETE FROM facts WHERE confidence < ?`).run(floor);
  }
  return { removed: count };
}

// ── Job 3 ─────────────────────────────────────────────────────────────────────

function collapseExactDupes(
  db: Database.Database,
  dryRun: boolean,
): { removed: number; merged: number } {
  const groups = db
    .prepare(
      `SELECT content, COUNT(*) AS n
         FROM facts
        GROUP BY content
       HAVING n > 1
        ORDER BY n DESC`,
    )
    .all() as DupeGroupRow[];
  if (groups.length === 0) {
    console.log('[dupes] 0 exact-content groups');
    return { removed: 0, merged: 0 };
  }
  let removed = 0;
  const merged = groups.length;

  if (dryRun) {
    const totalDupes = groups.reduce((acc, g) => acc + (g.n - 1), 0);
    console.log(
      `[dupes] ${groups.length} groups, ${totalDupes} dupe rows (dry-run, not collapsing)`,
    );
    for (const g of groups.slice(0, 5)) {
      console.log(`  - ${g.n}x "${g.content.slice(0, 80)}..."`);
    }
    return { removed: totalDupes, merged };
  }

  const findGroupRows = db.prepare(
    `SELECT id, confidence, created_at
       FROM facts
      WHERE content = ?
      ORDER BY confidence DESC, created_at DESC`,
  );
  const deleteFact = db.prepare(`DELETE FROM facts WHERE id = ?`);
  const bumpConfidence = db.prepare(
    `UPDATE facts SET confidence = MIN(1.0, confidence + ?) WHERE id = ?`,
  );

  const tx = db.transaction(() => {
    for (const g of groups) {
      const rows = findGroupRows.all(g.content) as Array<{
        id: string;
        confidence: number;
        created_at: string;
      }>;
      if (rows.length < 2) continue;
      const [keeper, ...losers] = rows;
      for (const l of losers) deleteFact.run(l.id);
      const bump = Math.min(0.05 * (rows.length - 1), 0.1);
      bumpConfidence.run(bump, keeper.id);
      removed += losers.length;
    }
  });
  tx();
  console.log(`[dupes] collapsed ${merged} groups -> removed ${removed} dupe rows`);
  return { removed, merged };
}

// ── Job 4 ─────────────────────────────────────────────────────────────────────

function timeDecay(
  db: Database.Database,
  decayDays: number,
  decayFactor: number,
  dryRun: boolean,
): { decayed: number } {
  if (decayFactor >= 1.0 || decayDays <= 0) {
    console.log('[time-decay] skipped (factor=1 or days=0)');
    return { decayed: 0 };
  }
  const ageCutoff = `datetime('now', '-${decayDays} days')`;
  const candidates = db
    .prepare(
      `SELECT id, confidence, source_kind, source_id, created_at, extracted_by
         FROM facts
        WHERE extracted_by != 'directive-import'
          AND confidence > 0.05
          AND datetime(created_at) < ${ageCutoff}`,
    )
    .all() as Array<{
      id: string;
      confidence: number;
      source_kind: string;
      source_id: string;
      created_at: string;
      extracted_by: string;
    }>;
  if (candidates.length === 0) {
    console.log(`[time-decay] 0 candidates older than ${decayDays} days`);
    return { decayed: 0 };
  }

  const sourceFreshnessQueries = {
    github_comment: db.prepare(
      `SELECT 1 FROM github_comments WHERE id = ? AND datetime(updated_at) >= ${ageCutoff} LIMIT 1`,
    ),
    pr: db.prepare(
      `SELECT 1 FROM github_pull_requests
        WHERE pull_request_id = CAST(substr(?, length('pr:') + 1) AS INTEGER)
          AND datetime(updated_at) >= ${ageCutoff} LIMIT 1`,
    ),
    issue: db.prepare(
      `SELECT 1 FROM github_issues
        WHERE issue_id = CAST(substr(?, length('issue:') + 1) AS INTEGER)
          AND datetime(updated_at) >= ${ageCutoff} LIMIT 1`,
    ),
    outcome: db.prepare(
      `SELECT 1 FROM session_outcomes
        WHERE id = substr(?, length('outcome:') + 1)
          AND datetime(completed_at) >= ${ageCutoff} LIMIT 1`,
    ),
  };

  const decayTargets: string[] = [];
  for (const c of candidates) {
    const checker = sourceFreshnessQueries[c.source_kind as keyof typeof sourceFreshnessQueries];
    if (checker) {
      const fresh = checker.get(c.source_id);
      if (fresh) continue;
    }
    decayTargets.push(c.id);
  }

  if (decayTargets.length === 0) {
    console.log(
      `[time-decay] ${candidates.length} candidates were all live (source updated_at within window)`,
    );
    return { decayed: 0 };
  }

  console.log(
    `[time-decay] decaying ${decayTargets.length} facts (x ${decayFactor})${dryRun ? ' (dry-run, not writing)' : ''}`,
  );
  if (!dryRun) {
    const update = db.prepare(
      `UPDATE facts SET confidence = MAX(0.05, confidence * ?) WHERE id = ?`,
    );
    const tx = db.transaction((ids: string[]) => {
      for (const id of ids) update.run(decayFactor, id);
    });
    tx(decayTargets);
  }
  return { decayed: decayTargets.length };
}

// ── Job 5 ─────────────────────────────────────────────────────────────────────

function tokensOf(text: string): Set<string> {
  const tokens = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2);
  return new Set(tokens);
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersect = 0;
  for (const t of a) if (b.has(t)) intersect += 1;
  const union = a.size + b.size - intersect;
  return union === 0 ? 0 : intersect / union;
}

function jaccardMerge(
  db: Database.Database,
  threshold: number,
  dryRun: boolean,
): { removed: number; merged: number } {
  if (threshold >= 1.0) {
    console.log('[jaccard-merge] skipped (threshold=1.0 = exact match only -- covered by Job 3)');
    return { removed: 0, merged: 0 };
  }
  const all = db
    .prepare(
      `SELECT id, kind, content, confidence
         FROM facts
        WHERE length(content) > 30`,
    )
    .all() as Array<{
      id: string;
      kind: string;
      content: string;
      confidence: number;
    }>;
  if (all.length < 2) {
    console.log('[jaccard-merge] 0 candidates (need >=2 facts)');
    return { removed: 0, merged: 0 };
  }

  const buckets = new Map<string, typeof all>();
  for (const r of all) {
    const lenBucket = Math.floor(r.content.length / 50);
    for (const b of [lenBucket - 1, lenBucket, lenBucket + 1]) {
      const key = `${r.kind}::${b}`;
      let arr = buckets.get(key);
      if (!arr) {
        arr = [];
        buckets.set(key, arr);
      }
      arr.push(r);
    }
  }

  const tokensCache = new Map<string, Set<string>>();
  const tok = (id: string, content: string): Set<string> => {
    let t = tokensCache.get(id);
    if (!t) {
      t = tokensOf(content);
      tokensCache.set(id, t);
    }
    return t;
  };

  const clusters = new Map<string, Set<string>>();
  const claimed = new Map<string, string>();
  const seen = new Set<string>();
  for (const [, rows] of buckets) {
    for (let i = 0; i < rows.length; i += 1) {
      for (let j = i + 1; j < rows.length; j += 1) {
        const a = rows[i];
        const b = rows[j];
        if (a.id === b.id) continue;
        const pairKey = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
        if (seen.has(pairKey)) continue;
        seen.add(pairKey);
        if (a.content === b.content) continue;
        const sim = jaccard(tok(a.id, a.content), tok(b.id, b.content));
        if (sim < threshold) continue;
        const winner = a.confidence >= b.confidence ? a : b;
        const loser = winner === a ? b : a;
        const winnerKeeper = claimed.get(winner.id) ?? winner.id;
        const loserKeeper = claimed.get(loser.id);
        const keeper = winnerKeeper;
        let cluster = clusters.get(keeper);
        if (!cluster) {
          cluster = new Set([keeper]);
          clusters.set(keeper, cluster);
        }
        if (loserKeeper && loserKeeper !== keeper) {
          const oldCluster = clusters.get(loserKeeper);
          if (oldCluster) {
            for (const id of oldCluster) {
              cluster.add(id);
              claimed.set(id, keeper);
            }
            clusters.delete(loserKeeper);
          }
        } else {
          cluster.add(loser.id);
          claimed.set(loser.id, keeper);
        }
        claimed.set(winner.id, keeper);
      }
    }
  }

  if (clusters.size === 0) {
    console.log(`[jaccard-merge] 0 near-dup clusters at threshold ${threshold}`);
    return { removed: 0, merged: 0 };
  }
  let toRemove = 0;
  for (const cluster of clusters.values()) toRemove += cluster.size - 1;

  if (dryRun) {
    console.log(
      `[jaccard-merge] ${clusters.size} clusters, ${toRemove} dupe rows (dry-run, not collapsing)`,
    );
    return { removed: toRemove, merged: clusters.size };
  }

  const deleteFact = db.prepare(`DELETE FROM facts WHERE id = ?`);
  const bumpConfidence = db.prepare(
    `UPDATE facts SET confidence = MIN(1.0, confidence + ?) WHERE id = ?`,
  );
  const tx = db.transaction(() => {
    for (const [keeper, cluster] of clusters) {
      const losers = [...cluster].filter((id) => id !== keeper);
      for (const id of losers) deleteFact.run(id);
      const bump = Math.min(0.03 * losers.length, 0.08);
      bumpConfidence.run(bump, keeper);
    }
  });
  tx();
  console.log(`[jaccard-merge] collapsed ${clusters.size} clusters -> removed ${toRemove} rows`);
  return { removed: toRemove, merged: clusters.size };
}

// ── Job 6 ─────────────────────────────────────────────────────────────────────

const NEGATION_MARKERS = [
  'never', 'not', 'no ', "don't", 'dont', 'avoid', 'prohibited', 'banned',
  'ban ', 'forbid', 'forbidden', 'must not', 'cannot', "can't", 'cant', 'disallow',
];
const REQUIRE_MARKERS = [
  'must', 'always', 'required', 'use ', 'should', 'enforce', 'mandatory', 'enforced',
];

function polarityOf(text: string): 'negative' | 'positive' | 'neutral' {
  const lower = text.toLowerCase();
  const hasNeg = NEGATION_MARKERS.some((m) => lower.includes(m));
  const hasPos = REQUIRE_MARKERS.some((m) => lower.includes(m));
  if (hasNeg && !hasPos) return 'negative';
  if (hasPos && !hasNeg) return 'positive';
  return 'neutral';
}

function nounishTokens(text: string): Set<string> {
  const tokens = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 4);
  return new Set(tokens);
}

function surfaceContradictions(
  db: Database.Database,
  minOverlap: number,
  reportTopN: number,
): { reported: number } {
  const all = db
    .prepare(
      `SELECT id, kind, content, confidence FROM facts
        WHERE length(content) > 30
        ORDER BY kind, confidence DESC`,
    )
    .all() as Array<{ id: string; kind: string; content: string; confidence: number }>;

  const byKind = new Map<string, typeof all>();
  for (const r of all) {
    let arr = byKind.get(r.kind);
    if (!arr) { arr = []; byKind.set(r.kind, arr); }
    arr.push(r);
  }

  const pairs: Array<{ a: string; b: string; overlap: number; aSnip: string; bSnip: string }> = [];
  for (const [, rows] of byKind) {
    if (rows.length < 2) continue;
    const tokens = rows.map((r) => nounishTokens(r.content));
    const polarities = rows.map((r) => polarityOf(r.content));
    for (let i = 0; i < rows.length; i += 1) {
      for (let j = i + 1; j < rows.length; j += 1) {
        if (polarities[i] === polarities[j]) continue;
        if (polarities[i] === 'neutral' || polarities[j] === 'neutral') continue;
        let overlap = 0;
        for (const t of tokens[i]) if (tokens[j].has(t)) overlap += 1;
        if (overlap < minOverlap) continue;
        pairs.push({
          a: rows[i].id,
          b: rows[j].id,
          overlap,
          aSnip: rows[i].content.slice(0, 90),
          bSnip: rows[j].content.slice(0, 90),
        });
      }
    }
  }

  pairs.sort((x, y) => y.overlap - x.overlap);
  if (pairs.length === 0) {
    console.log(`[contradictions] 0 candidates at min-overlap=${minOverlap}`);
    return { reported: 0 };
  }
  console.log(
    `[contradictions] ${pairs.length} candidate pairs (heuristic, min-overlap=${minOverlap}, top ${Math.min(reportTopN, pairs.length)}):`,
  );
  for (const p of pairs.slice(0, reportTopN)) {
    console.log(`  - overlap=${p.overlap}`);
    console.log(`      A[${p.a.slice(0, 8)}]: ${p.aSnip}...`);
    console.log(`      B[${p.b.slice(0, 8)}]: ${p.bSnip}...`);
  }
  if (pairs.length > reportTopN) {
    console.log(`  ... and ${pairs.length - reportTopN} more`);
  }
  return { reported: pairs.length };
}

// ── Job 7 — cosine near-dup merge (#962) ─────────────────────────────────────

function cosineSim(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

function cosineNearDupMerge(
  db: Database.Database,
  threshold: number,
  dryRun: boolean,
): { removed: number; merged: number } {
  const hasCol = (db.pragma('table_info(facts)') as Array<{ name: string }>)
    .some((c) => c.name === 'embedding');
  if (!hasCol) {
    console.log('[cosine-dedup] skipped (facts.embedding column missing — apply schema v20 first)');
    return { removed: 0, merged: 0 };
  }

  const rows = db
    .prepare(
      `SELECT id, kind, content, confidence, embedding
         FROM facts
        WHERE embedding IS NOT NULL
          AND length(content) > 30`,
    )
    .all() as Array<{
      id: string;
      kind: string;
      content: string;
      confidence: number;
      embedding: Buffer;
    }>;

  if (rows.length < 2) {
    console.log(`[cosine-dedup] skipped (${rows.length} rows have embeddings — need >=2)`);
    return { removed: 0, merged: 0 };
  }

  console.log(`[cosine-dedup] comparing ${rows.length} embedded facts at threshold ${threshold}`);

  const vecs: Float32Array[] = rows.map((r) => {
    // Copy out of better-sqlite3's shared Buffer pool: the slice's byteOffset
    // is often not 4-aligned (a direct Float32Array view throws RangeError).
    const copy = new Uint8Array(r.embedding.byteLength);
    copy.set(r.embedding);
    return new Float32Array(copy.buffer, 0, Math.floor(r.embedding.byteLength / 4));
  });

  const byKind = new Map<string, number[]>();
  for (let i = 0; i < rows.length; i++) {
    let arr = byKind.get(rows[i].kind);
    if (!arr) { arr = []; byKind.set(rows[i].kind, arr); }
    arr.push(i);
  }

  const clusters = new Map<string, Set<string>>();
  const claimed = new Map<string, string>();

  for (const [, indices] of byKind) {
    for (let ii = 0; ii < indices.length; ii++) {
      for (let jj = ii + 1; jj < indices.length; jj++) {
        const i = indices[ii];
        const j = indices[jj];
        if (rows[i].content === rows[j].content) continue;
        const sim = cosineSim(vecs[i], vecs[j]);
        if (sim < threshold) continue;

        const winner = rows[i].confidence >= rows[j].confidence ? rows[i] : rows[j];
        const loser = winner === rows[i] ? rows[j] : rows[i];
        const winnerKeeper = claimed.get(winner.id) ?? winner.id;

        let cluster = clusters.get(winnerKeeper);
        if (!cluster) {
          cluster = new Set([winnerKeeper]);
          clusters.set(winnerKeeper, cluster);
        }

        const loserKeeper = claimed.get(loser.id);
        if (loserKeeper && loserKeeper !== winnerKeeper) {
          const loserCluster = clusters.get(loserKeeper);
          if (loserCluster) {
            for (const id of loserCluster) {
              cluster.add(id);
              claimed.set(id, winnerKeeper);
            }
            clusters.delete(loserKeeper);
          }
        } else {
          cluster.add(loser.id);
          claimed.set(loser.id, winnerKeeper);
        }
        claimed.set(winner.id, winnerKeeper);
      }
    }
  }

  if (clusters.size === 0) {
    console.log(`[cosine-dedup] 0 near-dup clusters at threshold ${threshold}`);
    return { removed: 0, merged: 0 };
  }

  let toRemove = 0;
  for (const cluster of clusters.values()) toRemove += cluster.size - 1;

  if (dryRun) {
    console.log(
      `[cosine-dedup] ${clusters.size} clusters, ${toRemove} dupe rows (dry-run, not collapsing)`,
    );
    return { removed: toRemove, merged: clusters.size };
  }

  const deleteFact = db.prepare(`DELETE FROM facts WHERE id = ?`);
  const bumpConfidence = db.prepare(
    `UPDATE facts SET confidence = MIN(1.0, confidence + ?) WHERE id = ?`,
  );
  const tx = db.transaction(() => {
    for (const [keeper, cluster] of clusters) {
      const losers = [...cluster].filter((id) => id !== keeper);
      for (const id of losers) deleteFact.run(id);
      const bump = Math.min(0.03 * losers.length, 0.08);
      bumpConfidence.run(bump, keeper);
    }
  });
  tx();
  console.log(
    `[cosine-dedup] collapsed ${clusters.size} clusters -> removed ${toRemove} rows`,
  );
  return { removed: toRemove, merged: clusters.size };
}

// ── Stats ─────────────────────────────────────────────────────────────────────

export function reportStats(db: Database.Database, label: string): void {
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM facts`).get() as CountRow).n;
  const distinctContent = (db.prepare(`SELECT COUNT(DISTINCT content) AS n FROM facts`).get() as CountRow).n;
  const bySource = db
    .prepare(
      `SELECT source_kind, COUNT(*) AS n, ROUND(AVG(confidence), 2) AS avg_conf
         FROM facts GROUP BY source_kind ORDER BY n DESC`,
    )
    .all() as BySourceRow[];
  console.log('');
  console.log(`--------  ${label}  --------`);
  console.log(`  total facts      : ${total}`);
  console.log(`  distinct content : ${distinctContent}`);
  console.log(`  exact-dup excess : ${total - distinctContent}`);
  for (const r of bySource) {
    console.log(`  ${r.source_kind.padEnd(16)}: ${String(r.n).padStart(5)}  conf=${r.avg_conf}`);
  }
}

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Run all six compaction jobs on the given database connection.
 * The caller is responsible for opening and closing the DB.
 */
export function runCompaction(args: CompactionArgs, db: Database.Database): CompactionResult {
  console.log(
    `[compact-facts] mode=${args.dryRun ? 'dry-run' : 'apply'} floor=${args.confidenceFloor} decay-days=${args.decayDays} decay-factor=${args.decayFactor} jaccard=${args.jaccardThreshold}`,
  );

  reportStats(db, 'before');

  console.log('');
  const t0 = Date.now();

  const orphans = gcOrphans(db, args.dryRun);
  const lowConf = dropLowConfidence(db, args.confidenceFloor, args.dryRun);
  const dupes = collapseExactDupes(db, args.dryRun);
  const decay = args.skipDecay
    ? { decayed: 0 }
    : timeDecay(db, args.decayDays, args.decayFactor, args.dryRun);
  const jacc = args.skipJaccard
    ? { removed: 0, merged: 0 }
    : jaccardMerge(db, args.jaccardThreshold, args.dryRun);
  // Job 7 — cosine near-dup dedup (#962). Opt-in via cosineDedup. Runs AFTER
  // Jaccard so the two passes do not collide on the same clusters.
  const cosineThreshold = args.cosineThreshold ?? 0.92;
  const cosine = args.cosineDedup
    ? cosineNearDupMerge(db, cosineThreshold, args.dryRun)
    : { removed: 0, merged: 0 };
  if (!args.cosineDedup) {
    console.log('[cosine-dedup] skipped (pass --cosine-dedup to enable Job 7)');
  }
  const contradictions = args.reportContradictions
    ? surfaceContradictions(db, args.contradictionMinOverlap, 20)
    : { reported: 0 };
  if (!args.reportContradictions) {
    console.log('[contradictions] skipped (pass --report-contradictions to enable)');
  }

  const elapsedMs = Date.now() - t0;
  reportStats(db, args.dryRun ? 'after (dry-run, unchanged)' : 'after');

  console.log('');
  console.log('------------------------------------------------------------');
  console.log('[compact-facts] summary');
  console.log('------------------------------------------------------------');
  console.log(`  orphans removed       : ${orphans.removed}`);
  console.log(`  low-confidence drop   : ${lowConf.removed}`);
  console.log(`  exact-dupe collapse   : ${dupes.removed} rows in ${dupes.merged} groups`);
  console.log(`  time-decayed          : ${decay.decayed}`);
  console.log(`  jaccard near-dup      : ${jacc.removed} rows in ${jacc.merged} clusters`);
  console.log(`  cosine near-dup       : ${cosine.removed} rows in ${cosine.merged} clusters`);
  console.log(`  contradiction report  : ${contradictions.reported} candidate pairs`);
  console.log(`  elapsed               : ${(elapsedMs / 1000).toFixed(2)}s`);
  console.log(`  mode                  : ${args.dryRun ? 'dry-run (no writes)' : 'applied'}`);
  console.log('------------------------------------------------------------');

  return {
    orphansRemoved: orphans.removed,
    lowConfRemoved: lowConf.removed,
    dupesRemoved: dupes.removed,
    dupeGroupsMerged: dupes.merged,
    decayed: decay.decayed,
    jaccardRemoved: jacc.removed,
    jaccardMerged: jacc.merged,
    contradictionsReported: contradictions.reported,
    cosineRemoved: cosine.removed,
    cosineMerged: cosine.merged,
    elapsedMs,
  };
}
