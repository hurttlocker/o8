/**
 * Backfill `facts.embedding` BLOB column (#962).
 *
 * Opt-in — never runs automatically. Run explicitly when you want to enable
 * the hybrid BM25+cosine scorer (`O8_HYBRID_SCORER=1`) and have the
 * embeddings ready in the DB.
 *
 * Requires OPENAI_API_KEY. Uses `text-embedding-3-small` (1536-dim,
 * ~$0.02/1M tokens). At 10k facts the total input is ~1-3M tokens → $0.02-$0.06.
 *
 * Usage:
 *   OPENAI_API_KEY=sk-... npx tsx scripts/backfill-fact-embeddings.ts
 *   OPENAI_API_KEY=sk-... npx tsx scripts/backfill-fact-embeddings.ts --dry-run
 *   OPENAI_API_KEY=sk-... npx tsx scripts/backfill-fact-embeddings.ts --batch=50
 *   OPENAI_API_KEY=sk-... npx tsx scripts/backfill-fact-embeddings.ts --limit=500
 *
 * Flags:
 *   --dry-run      Count un-embedded rows and cost estimate, no API calls.
 *   --batch=N      Rows per OpenAI call (default 100, max 100).
 *   --limit=N      Stop after N rows (for testing).
 *   --force        Re-embed rows that already have an embedding (for model upgrades).
 */

import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

// Inline the embeddings logic here — this is a standalone script that can't
// import from @/ without the Next.js tsconfig resolution. Keep it minimal.

const OPENAI_EMBED_MODEL = 'text-embedding-3-small';
const EMBED_DIMS = 1536;
const COST_PER_1M_TOKENS = 0.02;
const AVG_CHARS_PER_FACT = 200;
const CHARS_PER_TOKEN = 4;
const BATCH_LIMIT = 100;
const TIMEOUT_MS = 30_000;

function parseArgs(): {
  dryRun: boolean;
  batchSize: number;
  limit: number | null;
  force: boolean;
} {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const force = argv.includes('--force');

  const batchArg = argv.find((a) => a.startsWith('--batch='));
  const batchSize = batchArg ? Math.min(parseInt(batchArg.split('=')[1], 10), BATCH_LIMIT) : 100;

  const limitArg = argv.find((a) => a.startsWith('--limit='));
  const limit = limitArg ? parseInt(limitArg.split('=')[1], 10) : null;

  return { dryRun, batchSize, force, limit };
}

function getDbPath(): string {
  const dataDir =
    process.env.O8_DATA_DIR ||
    process.env.CORTEX_IDE_DATA_DIR ||
    path.join(os.homedir(), '.o8');
  return path.join(dataDir, 'cortex-ide.db');
}

interface FactForEmbed {
  id: string;
  content: string;
}

async function embedBatch(
  texts: string[],
  apiKey: string,
): Promise<Float32Array[]> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let body: { data: Array<{ embedding: number[] }> };
  try {
    const response = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: OPENAI_EMBED_MODEL,
        input: texts,
        dimensions: EMBED_DIMS,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '(no body)');
      throw new Error(`OpenAI API error ${response.status}: ${errorText.slice(0, 200)}`);
    }

    body = (await response.json()) as { data: Array<{ embedding: number[] }> };
  } finally {
    clearTimeout(timeoutId);
  }

  if (!body.data || body.data.length !== texts.length) {
    throw new Error(
      `OpenAI returned ${body.data?.length ?? 0} embeddings for ${texts.length} inputs`,
    );
  }

  return body.data.map((entry) => {
    if (!Array.isArray(entry.embedding) || entry.embedding.length !== EMBED_DIMS) {
      throw new Error(
        `Unexpected embedding shape: length=${entry.embedding?.length}`,
      );
    }
    return new Float32Array(entry.embedding);
  });
}

function encodeEmbedding(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

async function main(): Promise<void> {
  const args = parseArgs();
  const dbPath = getDbPath();

  if (!existsSync(dbPath)) {
    console.error(`[backfill-embeddings] DB not found: ${dbPath}`);
    process.exit(1);
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey && !args.dryRun) {
    console.error('[backfill-embeddings] OPENAI_API_KEY is not set. Set it to embed facts.');
    process.exit(1);
  }

  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');

  // Check the embedding column exists (v20 migration must have run).
  const hasCol = (db.pragma(`table_info(facts)`) as Array<{ name: string }>)
    .some((c) => c.name === 'embedding');
  if (!hasCol) {
    console.error(
      '[backfill-embeddings] facts.embedding column missing. ' +
        'Run the app once to apply schema v20, then re-run this script.',
    );
    db.close();
    process.exit(1);
  }

  const filterSql = args.force
    ? 'SELECT id, content FROM facts ORDER BY created_at ASC'
    : 'SELECT id, content FROM facts WHERE embedding IS NULL ORDER BY created_at ASC';

  let candidates = db.prepare(filterSql).all() as FactForEmbed[];

  const total = candidates.length;
  const estimatedTokens = Math.ceil((total * AVG_CHARS_PER_FACT) / CHARS_PER_TOKEN);
  const estimatedCost = (estimatedTokens / 1_000_000) * COST_PER_1M_TOKENS;

  console.log(`[backfill-embeddings] DB: ${dbPath}`);
  console.log(`[backfill-embeddings] mode=${args.dryRun ? 'dry-run' : 'apply'}`);
  console.log(
    `[backfill-embeddings] candidates=${total} (est. tokens≈${estimatedTokens} cost≈$${estimatedCost.toFixed(4)})`,
  );

  if (args.dryRun) {
    console.log('[backfill-embeddings] dry-run: no API calls made');
    db.close();
    return;
  }

  if (args.limit !== null) {
    candidates = candidates.slice(0, args.limit);
    console.log(`[backfill-embeddings] limited to ${candidates.length} rows`);
  }

  const updateStmt = db.prepare('UPDATE facts SET embedding = ? WHERE id = ?');

  let done = 0;
  let failed = 0;
  const t0 = Date.now();

  for (let offset = 0; offset < candidates.length; offset += args.batchSize) {
    const batch = candidates.slice(offset, offset + args.batchSize);
    const texts = batch.map((r) => r.content);

    let vecs: Float32Array[];
    try {
      vecs = await embedBatch(texts, apiKey!);
    } catch (err) {
      console.error(
        `[backfill-embeddings] batch ${offset}-${offset + batch.length - 1} failed:`,
        err instanceof Error ? err.message : err,
      );
      failed += batch.length;
      // Continue with the next batch — one API failure doesn't abort the run.
      continue;
    }

    const tx = db.transaction(() => {
      for (let i = 0; i < batch.length; i++) {
        updateStmt.run(encodeEmbedding(vecs[i]), batch[i].id);
      }
    });
    tx();
    done += batch.length;

    const pct = Math.round((done / candidates.length) * 100);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`[backfill-embeddings] ${done}/${candidates.length} (${pct}%) elapsed=${elapsed}s`);
  }

  const totalElapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log('');
  console.log('────────────────────────────────────────────────────────────');
  console.log('[backfill-embeddings] summary');
  console.log('────────────────────────────────────────────────────────────');
  console.log(`  embedded : ${done}`);
  console.log(`  failed   : ${failed}`);
  console.log(`  elapsed  : ${totalElapsed}s`);
  console.log('────────────────────────────────────────────────────────────');
  console.log('');
  console.log('To use the hybrid BM25+cosine scorer, set O8_HYBRID_SCORER=1 in .env.local');

  db.close();
}

main().catch((err) => {
  console.error('[backfill-embeddings] unexpected failure:', err);
  process.exit(1);
});
