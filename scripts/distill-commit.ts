/**
 * Engineering Brain — post-commit fact distiller (#963).
 *
 * Called by the .git/hooks/post-commit hook in background mode. Extracts
 * structured facts from the latest commit (message + changed file paths) and
 * writes them to the `facts` table with:
 *   source_kind = 'commit'
 *   source_id   = <full SHA>
 *   source_authority = 0.92   (between merged-PR 0.95 and outcome 0.9)
 *
 * Idempotency: checks for an existing fact row with source_kind='commit' and
 * source_id=<SHA> before calling the LLM. If any fact for that SHA already
 * exists, exits cleanly.
 *
 * CLI: source_kind='commit' facts are tagged with extracted_by='commit-distill'.
 *
 * Usage (from repo root, background):
 *   npx tsx scripts/distill-commit.ts <sha> <message> <file1> [<file2> ...]
 *
 * The hook passes all args — SHA is argv[2], message is argv[3],
 * remaining args are the changed file paths (one per arg).
 */

import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// ── DB bootstrap (mirrors compact-facts.ts: direct better-sqlite3, no Drizzle) ─

function getDbPath(): string {
  const dataDir =
    process.env.O8_DATA_DIR ||
    process.env.CORTEX_IDE_DATA_DIR ||
    path.join(os.homedir(), '.o8');
  return path.join(dataDir, 'cortex-ide.db');
}

// ── Claude Haiku CLI invocation ───────────────────────────────────────────────

const HAIKU_MODEL = 'claude-haiku-4-5-20251001';
const CLI_TIMEOUT_MS = 30_000;

/**
 * Resolve the `claude` binary via env override → which → login-shell probe.
 * Returns null if not found.
 */
async function resolveClaudeBin(): Promise<string | null> {
  for (const envKey of ['O8_CLAUDE_CODE_BIN', 'CLAUDE_BIN']) {
    const val = process.env[envKey];
    if (val) return val;
  }

  try {
    const { stdout } = await execFileAsync('which', ['claude'], { timeout: 3_000 });
    const found = stdout.trim();
    if (found) return found;
  } catch {
    // not on PATH — try login shell
  }

  const userShell = process.env.SHELL ?? 'zsh';
  for (const sh of [userShell, 'zsh', 'bash', 'sh']) {
    try {
      const { stdout } = await execFileAsync(sh, ['-l', '-c', 'command -v claude'], {
        timeout: 10_000,
        env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
      });
      const found = stdout.trim();
      if (found) return found;
    } catch {
      // shell not available
    }
  }
  return null;
}

function extractResultText(output: string): string {
  const lines = output.split('\n').filter(Boolean);
  for (const line of lines) {
    try {
      const evt = JSON.parse(line) as Record<string, unknown>;
      if (evt['type'] === 'result' && typeof evt['result'] === 'string') {
        return evt['result'];
      }
    } catch {
      // not JSON
    }
  }
  // Fallback: stitch assistant text blocks.
  const parts: string[] = [];
  for (const line of lines) {
    try {
      const evt = JSON.parse(line) as Record<string, unknown>;
      if (
        evt['type'] === 'assistant' &&
        typeof evt['message'] === 'object' &&
        evt['message'] !== null
      ) {
        const content = (evt['message'] as Record<string, unknown>)['content'];
        if (Array.isArray(content)) {
          for (const block of content) {
            if (
              typeof block === 'object' &&
              block !== null &&
              (block as Record<string, unknown>)['type'] === 'text' &&
              typeof (block as Record<string, unknown>)['text'] === 'string'
            ) {
              parts.push((block as Record<string, unknown>)['text'] as string);
            }
          }
        }
      }
    } catch {
      // not JSON
    }
  }
  return parts.join('');
}

async function callHaikuCli(claudeBin: string, prompt: string): Promise<string> {
  const cliArgs = [
    '--print',
    '--verbose',
    '--dangerously-skip-permissions',
    '--output-format', 'stream-json',
    '--model', HAIKU_MODEL,
  ];

  const cwd = os.tmpdir();
  const env = { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' };

  return new Promise<string>((resolve, reject) => {
    const child = spawn(claudeBin, cliArgs, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    child.stdin!.write(prompt, 'utf-8');
    child.stdin!.end();

    let outBuf = '';
    let errBuf = '';
    child.stdout!.on('data', (chunk: Buffer) => { outBuf += chunk.toString(); });
    child.stderr!.on('data', (chunk: Buffer) => { errBuf += chunk.toString(); });

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`[commit-distill] CLI timed out after ${CLI_TIMEOUT_MS}ms`));
    }, CLI_TIMEOUT_MS);

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`[commit-distill] CLI spawn error: ${err.message}`));
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 && outBuf.trim() === '') {
        reject(new Error(`[commit-distill] CLI exited ${code}: ${errBuf.slice(0, 400)}`));
      } else {
        resolve(outBuf);
      }
    });
  });
}

// ── Prompt ───────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT =
  'You extract structured engineering facts from git commits. Output strict JSON only. No prose, no fences, no preamble.';

function buildPrompt(sha: string, message: string, files: string[]): string {
  const fileSummary =
    files.length === 0
      ? '(no changed files listed)'
      : files.slice(0, 40).join('\n') + (files.length > 40 ? `\n…and ${files.length - 40} more` : '');

  return `You are extracting structured facts from a single git commit.

Read the COMMIT below and emit a JSON array of facts. Each fact is one self-contained piece of engineering knowledge: a decision, spec, process change, architecture note, or directive. If the commit message is purely mechanical ("fix typo", "bump version", "merge", "chore"), emit an empty array [].

Output format — STRICT JSON, no prose, no code fences:

[
  {
    "kind": "decision" | "spec" | "process" | "incident" | "ownership" | "cross_repo" | "directive" | "other",
    "content": "<1-2 sentences, self-contained, concrete, max 400 chars>",
    "source_excerpt": "<verbatim substring of the COMMIT MESSAGE below, max 150 chars>",
    "confidence": <number 0.0-1.0; 1.0 = explicit statement, 0.7 = clear inference>
  }
]

Hard rules — violating these will silently reject the fact:
- source_excerpt MUST be a verbatim, case-sensitive, character-for-character substring of the COMMIT MESSAGE.
- content must be self-contained — readable without seeing the commit.
- content must NOT invent information not present in the commit message.
- Confidence below 0.6 will be dropped, so don't emit facts you're not sure about.

Kind selector:
- decision   — "chose X over Y", "locked on X", "rejected Z"
- spec       — schemas, file conventions, command syntax, numeric thresholds
- process    — workflow steps, build/release steps, review rules
- incident   — "broke when Y", failure modes, postmortem notes
- ownership  — who owns what, what component contains what
- cross_repo — invariants across multiple repos
- directive  — "must always do X", "never Y", explicit project rules
- other      — factual engineering content that doesn't fit above

COMMIT SHA: ${sha}

COMMIT MESSAGE:
<<<
${message.slice(0, 4000)}
>>>

CHANGED FILES (context only — do not hallucinate facts from filenames alone):
${fileSummary}

Output JSON array only:`;
}

// ── Fact validation ──────────────────────────────────────────────────────────

const ALLOWED_KINDS = [
  'decision', 'spec', 'process', 'incident',
  'ownership', 'cross_repo', 'directive', 'other',
] as const;
type FactKind = (typeof ALLOWED_KINDS)[number];

interface ValidFact {
  kind: FactKind;
  content: string;
  source_excerpt: string;
  confidence: number;
}

function validateFact(
  raw: Record<string, unknown>,
  message: string,
): ValidFact | null {
  const kind =
    typeof raw['kind'] === 'string' ? raw['kind'].trim().toLowerCase() : '';
  if (!ALLOWED_KINDS.includes(kind as FactKind)) return null;

  const content =
    typeof raw['content'] === 'string' ? raw['content'].trim() : '';
  if (content.length === 0 || content.length > 400) return null;

  const excerpt =
    typeof raw['source_excerpt'] === 'string' ? raw['source_excerpt'] : '';
  if (excerpt.length === 0 || excerpt.length > 150) return null;
  if (!message.includes(excerpt)) return null;

  let confidence =
    typeof raw['confidence'] === 'number' ? raw['confidence'] : 0.7;
  if (!Number.isFinite(confidence)) confidence = 0.7;
  confidence = Math.max(0, Math.min(1, confidence));
  if (confidence < 0.6) return null;

  return { kind: kind as FactKind, content, source_excerpt: excerpt, confidence };
}

function parseFactsJson(raw: string): Record<string, unknown>[] {
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();
  const first = text.indexOf('[');
  const last = text.lastIndexOf(']');
  if (first === -1 || last <= first) return [];
  try {
    const parsed = JSON.parse(text.slice(first, last + 1));
    if (!Array.isArray(parsed)) return [];
    return parsed as Record<string, unknown>[];
  } catch {
    return [];
  }
}

// ── Fingerprint (mirrors existing pattern) ───────────────────────────────────

function fingerprintOf(content: string, sourceId: string): string {
  return createHash('sha256')
    .update(`commit:${sourceId}\n${content}`)
    .digest('hex');
}

// ── Main ─────────────────────────────────────────────────────────────────────

const COMMIT_SOURCE_AUTHORITY = 0.92;
const EXTRACTED_BY = 'commit-distill';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.error('[commit-distill] usage: distill-commit.ts <sha> <message> [<file>...]');
    process.exit(1);
  }

  const sha = args[0].trim();
  const message = args[1].trim();
  const files = args.slice(2);

  if (!sha || sha.length < 7) {
    console.error('[commit-distill] invalid SHA:', sha);
    process.exit(1);
  }

  // ── 1. Check if claude CLI is available ──────────────────────────────────
  const claudeBin = await resolveClaudeBin();
  if (!claudeBin) {
    // Silent exit — hook must not block or error if no CLI installed.
    process.exit(0);
  }

  // ── 2. Open DB and check idempotency ──────────────────────────────────────
  const dbPath = getDbPath();
  let Database: typeof import('better-sqlite3');
  try {
    // Dynamic import so the script fails gracefully if better-sqlite3 is absent.
    ({ default: Database } = await import('better-sqlite3'));
  } catch {
    console.error('[commit-distill] better-sqlite3 not available — skipping');
    process.exit(0);
  }

  let db: InstanceType<typeof Database>;
  try {
    db = new Database(dbPath, { readonly: false });
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = OFF');
  } catch {
    // DB not yet created (first boot before Next starts). Skip silently.
    process.exit(0);
  }

  // Idempotency check: any existing fact for this commit SHA.
  const existing = db
    .prepare(
      `SELECT id FROM facts WHERE source_kind = 'commit' AND source_id = ? LIMIT 1`,
    )
    .get(sha);
  if (existing) {
    db.close();
    process.exit(0);
  }

  // ── 3. Call Haiku CLI ────────────────────────────────────────────────────
  const prompt = buildPrompt(sha, message, files);
  let rawOutput: string;
  try {
    rawOutput = await callHaikuCli(claudeBin, prompt);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[commit-distill] CLI call failed:', msg.slice(0, 300));
    db.close();
    process.exit(0);
  }

  // ── 4. Validate + write facts ─────────────────────────────────────────────
  const rawFacts = parseFactsJson(rawOutput);
  if (rawFacts.length === 0) {
    db.close();
    process.exit(0);
  }

  const validated: ValidFact[] = [];
  for (const raw of rawFacts) {
    const fact = validateFact(raw, message);
    if (fact) validated.push(fact);
  }

  if (validated.length === 0) {
    db.close();
    process.exit(0);
  }

  const insert = db.prepare(
    `INSERT INTO facts (
       id, kind, content, source_kind, source_id, source_excerpt,
       repo_path, confidence, fingerprint, extracted_by, source_authority
     )
     VALUES (?, ?, ?, 'commit', ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(fingerprint) DO UPDATE SET
       kind = excluded.kind,
       content = excluded.content,
       source_excerpt = excluded.source_excerpt,
       confidence = excluded.confidence,
       extracted_by = excluded.extracted_by,
       source_authority = excluded.source_authority`,
  );

  // Detect repo_path from cwd (passed by hook as CWD env, or just process.cwd()).
  const repoPath = process.env.GIT_DIR
    ? path.resolve(process.env.GIT_DIR, '..')
    : process.cwd();

  const tx = db.transaction((facts: ValidFact[]) => {
    for (const fact of facts) {
      const fingerprint = fingerprintOf(fact.content, sha);
      insert.run(
        randomUUID(),
        fact.kind,
        fact.content,
        sha,
        fact.source_excerpt,
        repoPath,
        fact.confidence,
        fingerprint,
        EXTRACTED_BY,
        COMMIT_SOURCE_AUTHORITY,
      );
    }
  });
  tx(validated);

  console.log(
    `[commit-distill] sha=${sha.slice(0, 8)} wrote ${validated.length} fact${validated.length === 1 ? '' : 's'}`,
  );

  db.close();
}

main().catch((err) => {
  console.error('[commit-distill] FAIL', err instanceof Error ? err.message : err);
  process.exit(0); // always exit 0 — hook must never block commits
});
