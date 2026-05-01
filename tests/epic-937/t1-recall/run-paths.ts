/**
 * t1-recall runner — runs all 3 retrieval paths for each question, writes
 * raw outputs to data/runs.json.
 *
 * Paths:
 *   (a) Brain  — askCortex via the eval-mode pipeline (Sonnet 4.6 OpenRouter)
 *   (b) Grep   — keyword grep over docs/*.md → top 5 hits → Sonnet 4.6 synthesis
 *   (c) Long   — single Sonnet 4.6 call with the full CLAUDE.md + DESIGN.md
 *                 as context (no retrieval pipeline)
 *
 * All three paths use the same final synthesis model (Sonnet 4.6 via OpenRouter)
 * so the comparison isolates the *retrieval* layer, not the model.
 *
 * Run from the worktree root (/Users/marquisehurtt/o8-validation):
 *   OPENROUTER_API_KEY=... npx tsx tests/epic-937/t1-recall/run-paths.ts
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { askCortex } from '@/lib/cortex/qa/ask';
import { callOpenRouter } from '@/lib/cortex/qa/llm/openrouter-adapter';

const execFileP = promisify(execFile);

// ── Config ───────────────────────────────────────────────────────────────────

const REPO_ROOT = '/Users/marquisehurtt/cortex-ide';
const T1_DATA = '/Users/marquisehurtt/o8-validation/tests/epic-937/t1-recall/data';
const QUESTIONS_PATH = path.join(T1_DATA, 'questions.json');
const RUNS_PATH = path.join(T1_DATA, 'runs.json');

const DOC_FILES = [
  path.join(REPO_ROOT, 'CLAUDE.md'),
  path.join(REPO_ROOT, 'README.md'),
  path.join(REPO_ROOT, 'AGENTS.md'),
  path.join(REPO_ROOT, 'DESIGN.md'),
];
// docs/*.md
const DOCS_GLOB = path.join(REPO_ROOT, 'docs');

const SONNET_MODEL = 'anthropic/claude-sonnet-4-6';

const STOPWORDS = new Set([
  'the', 'is', 'a', 'an', 'of', 'and', 'or', 'to', 'in', 'for', 'on', 'with',
  'what', 'why', 'how', 'when', 'where', 'who', 'which', 'does', 'do', 'did',
  'be', 'are', 'was', 'were', 'been', 'being', 'has', 'have', 'had', 'will',
  'would', 'could', 'should', 'can', 'may', 'might', 'must', 'this', 'that',
  'these', 'those', 'it', 'its', 'they', 'them', 'their', 'as', 'at', 'by',
  'from', 'into', 'about', 'over', 'under', 'before', 'after', 'between',
  'specific', 'concrete', 'rationale', 'change', 'value', 'approximate',
  'set', 'use', 'used', 'using', 'introduced', 'feature', 'work', 'works',
  'commands', 'command', 'sequence', 'machine', 'developers', 'developer',
  'exact', 'be', 'beyond', 'specifically', 'instead', 'apart',
]);

// ── Helpers ──────────────────────────────────────────────────────────────────

interface QuestionCase {
  id: string;
  category: string;
  favoredPath: string;
  question: string;
  referenceAnswer: string;
  groundTruthSources: string[];
}

interface PathResult {
  text: string;
  durationMs: number;
  meta?: Record<string, unknown>;
  error?: string;
}

interface RunRow {
  caseId: string;
  category: string;
  favoredPath: string;
  question: string;
  referenceAnswer: string;
  brain: PathResult;
  grep: PathResult;
  longCtx: PathResult;
}

async function loadQuestions(): Promise<QuestionCase[]> {
  const raw = await fs.readFile(QUESTIONS_PATH, 'utf-8');
  const file = JSON.parse(raw) as { cases: QuestionCase[] };
  return file.cases;
}

function tokenize(question: string): string[] {
  const tokens = question
    .toLowerCase()
    .split(/[^a-z0-9_-]+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
  return [...new Set(tokens)];
}

async function readDocFiles(): Promise<string> {
  const docFiles: string[] = [...DOC_FILES];
  // Add docs/*.md
  try {
    const entries = await fs.readdir(DOCS_GLOB, { withFileTypes: true });
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith('.md')) {
        docFiles.push(path.join(DOCS_GLOB, e.name));
      }
    }
  } catch {
    // docs dir missing — skip silently
  }
  // For path (c) we only use CLAUDE.md + DESIGN.md per the methodology spec.
  // This helper builds the concatenated text for (c).
  const claude = await fs.readFile(path.join(REPO_ROOT, 'CLAUDE.md'), 'utf-8');
  const design = await fs.readFile(path.join(REPO_ROOT, 'DESIGN.md'), 'utf-8');
  return `# CLAUDE.md\n\n${claude}\n\n# DESIGN.md\n\n${design}`;
}

// ── Path (a) Brain ───────────────────────────────────────────────────────────

async function runBrain(q: QuestionCase): Promise<PathResult> {
  // Force eval mode so the pipeline routes through OpenRouter Sonnet 4.6,
  // matching the methodology — same final synthesis model across all 3 paths.
  process.env.O8_EVAL_MODE = '1';
  const start = Date.now();
  try {
    const result = await askCortex(q.question, REPO_ROOT, { bypassCache: true });
    return {
      text: result.answer,
      durationMs: Date.now() - start,
      meta: {
        class: result.class,
        retrievalMs: result.retrievalMs,
        classifyMs: result.classifyMs,
        citations: result.citations.map((c) => ({ kind: c.kind, rowId: c.rowId, table: c.table })),
        citationCount: result.citations.length,
      },
    };
  } catch (err) {
    return {
      text: '',
      durationMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ── Path (b) Grep + LLM synthesis ─────────────────────────────────────────────

interface GrepHit {
  file: string;
  line: number;
  matchedTokens: Set<string>;
  context: string;
}

async function grepDocs(tokens: string[]): Promise<GrepHit[]> {
  const hitMap = new Map<string, GrepHit>();
  // Run grep per token across docs files
  for (const token of tokens) {
    let stdout = '';
    try {
      // Use ripgrep with line numbers + 2 lines context.
      // -i case-insensitive; -F fixed-string treats tokens as literal.
      const args = [
        '-n',
        '-i',
        '-F',
        '-A', '2',
        '-B', '1',
        '--no-heading',
        '--with-filename',
        token,
        ...DOC_FILES,
        DOCS_GLOB,
      ];
      const { stdout: out } = await execFileP('rg', args, { maxBuffer: 4 * 1024 * 1024 });
      stdout = out;
    } catch (err) {
      // rg exits non-zero when no matches found; that's fine
      const e = err as { stdout?: string; code?: number };
      if (e.stdout) stdout = e.stdout;
      else continue;
    }
    // Parse rg output — file:line:content lines, separated by --
    const blocks = stdout.split(/^--$/m);
    for (const block of blocks) {
      const lines = block.trim().split('\n');
      // The first matched line in the block; ripgrep puts the actual match
      // line as `file:line:content`, context lines as `file-line-content`.
      // Collect the whole block as the context, but find the matched line
      // for the file:line key.
      let matchedLine: { file: string; line: number } | null = null;
      const contextLines: string[] = [];
      for (const l of lines) {
        if (!l.trim()) continue;
        // match: filepath:NN:content  vs  filepath-NN-content
        const matchRe = /^([^:]+):(\d+):(.*)$/;
        const ctxRe = /^([^:]+)-(\d+)-(.*)$/;
        const m = l.match(matchRe);
        if (m) {
          if (!matchedLine) {
            matchedLine = { file: m[1], line: parseInt(m[2], 10) };
          }
          contextLines.push(`${m[1]}:${m[2]}: ${m[3]}`);
        } else {
          const c = l.match(ctxRe);
          if (c) contextLines.push(`${c[1]}:${c[2]}- ${c[3]}`);
        }
      }
      if (!matchedLine) continue;
      const key = `${matchedLine.file}:${matchedLine.line}`;
      if (!hitMap.has(key)) {
        hitMap.set(key, {
          file: matchedLine.file,
          line: matchedLine.line,
          matchedTokens: new Set([token]),
          context: contextLines.join('\n'),
        });
      } else {
        hitMap.get(key)!.matchedTokens.add(token);
      }
    }
  }
  // Rank by matchedTokens.size desc, return top 5
  const ranked = [...hitMap.values()].sort(
    (a, b) => b.matchedTokens.size - a.matchedTokens.size,
  );
  return ranked.slice(0, 5);
}

async function runGrep(q: QuestionCase): Promise<PathResult> {
  const start = Date.now();
  try {
    const tokens = tokenize(q.question);
    const hits = await grepDocs(tokens);
    if (hits.length === 0) {
      return {
        text: 'I could not find any relevant matches in the project documentation.',
        durationMs: Date.now() - start,
        meta: { tokens, hitCount: 0 },
      };
    }
    // Synthesize via Sonnet 4.6 OpenRouter
    const hitsText = hits
      .map((h, i) => {
        const tokensList = [...h.matchedTokens].join(', ');
        return `Hit ${i + 1} (${h.file}:${h.line}, matches: ${tokensList}):\n${h.context}`;
      })
      .join('\n\n');
    const prompt = `You are answering an engineering question using ONLY the provided grep hits from project documentation. Be concise and cite the file:line in [brackets] inline.

Question: ${q.question}

Top 5 grep hits:
${hitsText}

If the hits don't answer the question, say "I don't have that information yet."

Answer concisely (1-4 sentences) with [file:line] citations.`;
    const text = await callOpenRouter(prompt, {
      model: SONNET_MODEL,
      timeoutMs: 30_000,
    });
    return {
      text: text.trim(),
      durationMs: Date.now() - start,
      meta: {
        tokens,
        hitCount: hits.length,
        hits: hits.map((h) => ({ file: h.file, line: h.line, matched: [...h.matchedTokens] })),
      },
    };
  } catch (err) {
    return {
      text: '',
      durationMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ── Path (c) Long-context full docs ──────────────────────────────────────────

async function runLongCtx(q: QuestionCase, docsContent: string): Promise<PathResult> {
  const start = Date.now();
  try {
    const prompt = `You are an engineering assistant. Answer the user's question using ONLY the provided project documentation. Cite the relevant section heading or file when you can. Be concise (1-4 sentences).

Project documentation:
${docsContent}

Question: ${q.question}

If the documentation doesn't answer the question, say "I don't have that information yet."

Answer:`;
    const text = await callOpenRouter(prompt, {
      model: SONNET_MODEL,
      timeoutMs: 60_000,
    });
    return {
      text: text.trim(),
      durationMs: Date.now() - start,
      meta: { docCharLen: docsContent.length },
    };
  } catch (err) {
    return {
      text: '',
      durationMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (!process.env.OPENROUTER_API_KEY) {
    console.error('[t1-recall] OPENROUTER_API_KEY is required');
    process.exit(1);
  }

  const cases = await loadQuestions();
  console.log(`[t1-recall] loaded ${cases.length} questions`);

  const docsContent = await readDocFiles();
  console.log(`[t1-recall] CLAUDE.md+DESIGN.md context: ${docsContent.length} chars`);

  const rows: RunRow[] = [];

  for (const c of cases) {
    console.log(`\n[t1-recall] ▶ ${c.id} — ${c.question.slice(0, 80)}…`);

    // Run paths sequentially — keeps logs orderly and isolates each call.
    console.log(`[t1-recall]   (a) brain…`);
    const brain = await runBrain(c);
    console.log(`[t1-recall]   (a) brain → ${brain.error ? 'ERROR: ' + brain.error : `${brain.text.length} chars in ${brain.durationMs}ms`}`);

    console.log(`[t1-recall]   (b) grep…`);
    const grep = await runGrep(c);
    console.log(`[t1-recall]   (b) grep → ${grep.error ? 'ERROR: ' + grep.error : `${grep.text.length} chars in ${grep.durationMs}ms`}`);

    console.log(`[t1-recall]   (c) longCtx…`);
    const longCtx = await runLongCtx(c, docsContent);
    console.log(`[t1-recall]   (c) longCtx → ${longCtx.error ? 'ERROR: ' + longCtx.error : `${longCtx.text.length} chars in ${longCtx.durationMs}ms`}`);

    rows.push({
      caseId: c.id,
      category: c.category,
      favoredPath: c.favoredPath,
      question: c.question,
      referenceAnswer: c.referenceAnswer,
      brain,
      grep,
      longCtx,
    });

    // Persist incrementally so a crash doesn't lose progress.
    await fs.writeFile(RUNS_PATH, JSON.stringify({ generatedAt: new Date().toISOString(), rows }, null, 2));
  }

  console.log(`\n[t1-recall] all ${cases.length} cases complete`);
  console.log(`[t1-recall] runs.json written to ${RUNS_PATH}`);
}

main().catch((err) => {
  console.error('[t1-recall] unexpected failure:', err);
  process.exit(1);
});
