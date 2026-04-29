/**
 * #743 — Dispatch context injection.
 *
 * Builds a `<context>...</context>` block to prepend to every packet body
 * we hand to a runtime adapter (Codex / Gemini / opencode). The block is
 * the same data the Recall Card (#742) shows the operator — directives,
 * recent outcomes, and a small symbol-graph snippet — formatted for an
 * agent rather than a human eye.
 *
 * Format:
 *   <context>
 *   ## Project Directives
 *   - [title] [scope]: [body, single-line]
 *
 *   ## Recent Outcomes (last N)
 *   - [PASS] feat: ... (codex, 8m)
 *
 *   ## Symbol Graph
 *   - `Symbol` defined at path/file.ts; calls/called by: A, B, C
 *   </context>
 *
 *   [original packet body follows]
 *
 * Failure policy:
 *   - codebase-memory binary missing → skip Symbol Graph section, keep the
 *     other two. The recall card already treats this as a quiet fallback.
 *   - Drizzle DB unavailable → skip Recent Outcomes.
 *   - Directive dir missing → skip Project Directives.
 *   - Helper never throws. If everything resolves empty, returns the
 *     original body unchanged so callers can drop in safely.
 *
 * Token budget — issue #743 caps the injected block at 4000 chars and
 * truncates the symbol graph first (the most variable / least operator-
 * authored section).
 */

import 'server-only';

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { and, desc, eq } from 'drizzle-orm';

import { getDb, sessionOutcomes } from '@/lib/db';
import { getDataDir } from '@/lib/data-dir-migration';
import { liveOutcomeFilter } from '@/lib/cortex/decay';
import { withTiming } from '@/lib/cortex/diagnostics';
import { readRepoPathRegistry } from '@/lib/repos/repo-path-registry';

import { extractGraphResolvedSymbols, type SymbolEdge } from './client';

const MAX_BLOCK_CHARS = 4000;
const MAX_DIRECTIVES = 5;
const MAX_OUTCOMES = 5;
const MAX_SYMBOLS = 3;
const DIRECTIVE_BODY_CHARS = 240;
const OUTCOME_SUMMARY_CHARS = 160;
const NEIGHBOUR_LIMIT = 4;

const FRONT_MATTER_BOUNDARY = /^---\s*$/m;

interface DirectiveEntry {
  id: string;
  title: string;
  scope: string;
  repoName: string | null;
  priority: number | null;
  body: string;
}

interface OutcomeRow {
  outcome: 'succeeded' | 'failed' | 'partial' | 'interrupted';
  summary: string;
  runtime: string;
  branch: string | null;
  durationMs: number | null;
  reviewApproved: boolean | null;
}

interface BuildContextBlockInput {
  /** Repo root the packet targets — used to scope outcomes + directives. */
  repoPath: string;
  /** The packet body / summary we'll mine for symbols. */
  packetBody: string;
}

function parseDirectiveFile(raw: string, fallbackId: string): DirectiveEntry | null {
  const text = raw.replace(/\r\n/g, '\n').trim();
  if (!text.startsWith('---')) return null;

  const afterFirst = text.slice(3).trimStart();
  const closingIndex = afterFirst.search(FRONT_MATTER_BOUNDARY);
  if (closingIndex < 0) return null;

  const front = afterFirst.slice(0, closingIndex);
  const body = afterFirst.slice(closingIndex).replace(FRONT_MATTER_BOUNDARY, '').trim();

  const meta: Record<string, string> = {};
  for (const line of front.split('\n')) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key) meta[key] = value;
  }

  const priorityRaw = meta.priority;
  const priorityNum = priorityRaw ? Number.parseInt(priorityRaw, 10) : NaN;

  return {
    id: meta.id?.trim() || fallbackId,
    title: meta.title?.trim() || fallbackId,
    scope: meta.scope?.trim() || 'global',
    repoName: meta.repoName?.trim() || null,
    priority: Number.isFinite(priorityNum) ? priorityNum : null,
    body,
  };
}

function readDirectives(): DirectiveEntry[] {
  try {
    const dir = join(getDataDir(), 'directives');
    if (!existsSync(dir)) return [];

    const entries = readdirSync(dir).filter((name) => name.endsWith('.md'));
    const directives: DirectiveEntry[] = [];
    for (const name of entries) {
      try {
        const raw = readFileSync(join(dir, name), 'utf-8');
        const parsed = parseDirectiveFile(raw, name.replace(/\.md$/, ''));
        if (parsed) directives.push(parsed);
      } catch {
        // Skip unreadable files — never block dispatch on a directive parse error.
      }
    }
    return directives;
  } catch {
    return [];
  }
}

/**
 * #849 — guard against global-directive leakage into unrelated repo packets.
 *
 * Global directives are by definition broad, but the semantic contract is
 * "speak about a known repo". When the caller hands us a repoPath we don't
 * recognize (typo, fixture path, fake `/tmp/...`), we shouldn't speak for it.
 * Returns true when the path matches a registered repo OR equals the
 * orchestrator's own `process.cwd()` (the canonical self-host case).
 *
 * Falls back to "trust it" if the registry is unreadable, so registry I/O
 * errors don't silently kill the directives leg for legitimate repos.
 */
async function isKnownRepoPath(repoPath: string): Promise<boolean> {
  const normalized = resolve(repoPath.trim());
  if (!normalized) return false;

  // Self-host case: o8 dispatching against its own checkout.
  try {
    if (resolve(process.cwd()) === normalized) return true;
  } catch {
    // resolve() never throws in practice, but keep the helper non-throwing.
  }

  const registry = await readRepoPathRegistry();
  if (!registry.ok) {
    // Registry unreadable — don't penalize legitimate dispatches.
    return true;
  }
  return registry.repos.some((entry) => entry.path === normalized);
}

/** Filter directives by repo (global + matching repo name). */
function filterDirectivesForRepo(directives: DirectiveEntry[], repoPath: string): DirectiveEntry[] {
  const repoName = basename(repoPath).toLowerCase();
  return directives
    .filter((d) => {
      const scope = d.scope.toLowerCase();
      if (scope === 'global' || scope === '') return true;
      // Repo-scoped: match either explicit repoName field or scope===repoName
      const declaredRepo = (d.repoName ?? '').toLowerCase();
      if (declaredRepo && declaredRepo === repoName) return true;
      if (scope === repoName) return true;
      return false;
    })
    .sort((a, b) => {
      const ap = a.priority ?? 0;
      const bp = b.priority ?? 0;
      if (ap !== bp) return bp - ap;
      return a.title.localeCompare(b.title);
    })
    .slice(0, MAX_DIRECTIVES);
}

async function readRecentOutcomes(repoPath: string): Promise<OutcomeRow[]> {
  try {
    const db = getDb();
    if (!db) return [];
    const rows = await db
      .select({
        outcome: sessionOutcomes.outcome,
        summary: sessionOutcomes.summary,
        runtime: sessionOutcomes.runtime,
        branch: sessionOutcomes.branch,
        durationMs: sessionOutcomes.durationMs,
        reviewApproved: sessionOutcomes.reviewApproved,
      })
      .from(sessionOutcomes)
      .where(and(eq(sessionOutcomes.repoPath, repoPath), liveOutcomeFilter()))
      .orderBy(desc(sessionOutcomes.completedAt))
      .limit(MAX_OUTCOMES);
    return rows;
  } catch {
    return [];
  }
}

function formatDuration(ms: number | null): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '';
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return '<1m';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  return rem > 0 ? `${hours}h${rem}m` : `${hours}h`;
}

function outcomeBadge(row: OutcomeRow): string {
  switch (row.outcome) {
    case 'succeeded':
      return row.reviewApproved === false ? '[REJECTED]' : '[PASS]';
    case 'failed':
      return '[FAIL]';
    case 'partial':
      return '[PARTIAL]';
    case 'interrupted':
      return '[INTERRUPTED]';
    default:
      return '[?]';
  }
}

function clampLine(text: string, maxLen: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= maxLen) return flat;
  return `${flat.slice(0, maxLen - 1)}…`;
}

function renderDirectivesSection(rows: DirectiveEntry[]): string[] {
  if (rows.length === 0) return [];
  const lines = ['## Project Directives'];
  for (const d of rows) {
    const scopeTag = d.scope ? `[${d.scope}]` : '';
    const title = d.title.trim() || d.id;
    const body = clampLine(d.body || '(no body)', DIRECTIVE_BODY_CHARS);
    lines.push(`- ${title} ${scopeTag}: ${body}`);
  }
  return lines;
}

function renderOutcomesSection(rows: OutcomeRow[]): string[] {
  if (rows.length === 0) return [];
  const lines = [`## Recent Outcomes (last ${rows.length})`];
  for (const row of rows) {
    const badge = outcomeBadge(row);
    const summary = clampLine(row.summary, OUTCOME_SUMMARY_CHARS);
    const dur = formatDuration(row.durationMs);
    const tail = [row.runtime, dur].filter(Boolean).join(', ');
    lines.push(`- ${badge} ${summary}${tail ? ` (${tail})` : ''}`);
  }
  return lines;
}

function renderSymbolGraphSection(edges: SymbolEdge[]): string[] {
  const useful = edges.filter((e) => e.neighbours.length > 0 || e.file);
  if (useful.length === 0) return [];

  const lines = ['## Symbol Graph'];
  for (const edge of useful) {
    const where = edge.file
      ? `defined at ${edge.file}${typeof edge.line === 'number' ? `:${edge.line}` : ''}`
      : 'no definition recorded';
    const neighbours = edge.neighbours.slice(0, NEIGHBOUR_LIMIT);
    const linked = neighbours.length > 0
      ? `; linked to ${neighbours.join(', ')}`
      : '';
    lines.push(`- \`${edge.symbol}\` — ${where}${linked}`);
  }
  return lines;
}

/**
 * Truncate the rendered block from the bottom (Symbol Graph first, then
 * Outcomes, then Directives) until it fits inside MAX_BLOCK_CHARS. The
 * `<context>` wrapper is included in the budget.
 */
function fitWithinBudget(sections: { heading: 'directives' | 'outcomes' | 'symbols'; lines: string[] }[]): string {
  const order: typeof sections[number]['heading'][] = ['symbols', 'outcomes', 'directives'];
  const drop: Set<typeof sections[number]['heading']> = new Set();

  const render = () => {
    const inner = sections
      .filter((s) => !drop.has(s.heading))
      .map((s) => s.lines.join('\n'))
      .filter(Boolean)
      .join('\n\n');
    return inner ? `<context>\n${inner}\n</context>` : '';
  };

  let rendered = render();
  if (rendered.length <= MAX_BLOCK_CHARS) return rendered;

  // Drop sections in priority order until we fit.
  for (const heading of order) {
    drop.add(heading);
    rendered = render();
    if (rendered.length <= MAX_BLOCK_CHARS) return rendered;
  }
  return '';
}

/**
 * Build the `<context>` block. Returns an empty string when nothing useful
 * resolved (binary missing AND no directives AND no outcomes) so callers
 * can prepend unconditionally without inserting empty wrappers.
 */
export async function buildContextBlock({
  repoPath,
  packetBody,
}: BuildContextBlockInput): Promise<string> {
  if (!repoPath?.trim()) return '';

  // #849 — when the path doesn't match a registered repo (and isn't our own
  // checkout), drop the directives leg. Global directives are intentionally
  // global, but injecting them into a packet for an unknown repo claims
  // authority we don't have. Outcomes/symbols still resolve naturally to
  // empty for unknown paths since they key off repoPath in the DB.
  const repoIsKnown = await isKnownRepoPath(repoPath);
  const directives = repoIsKnown
    ? filterDirectivesForRepo(readDirectives(), repoPath)
    : [];
  const outcomes = await readRecentOutcomes(repoPath);

  // Symbol graph is best-effort — `extractGraphResolvedSymbols` traces a
  // wider candidate set and keeps only the symbols that actually have a
  // graph entry, so a TS interface name with no edges doesn't burn a slot.
  // Returns `unavailable: true` when the binary isn't on disk; never throws.
  let edges: SymbolEdge[] = [];
  try {
    const resolved = await withTiming(
      'recall.symbol-graph',
      () => extractGraphResolvedSymbols(packetBody, repoPath, MAX_SYMBOLS),
    );
    if (!resolved.unavailable) edges = resolved.edges;
  } catch {
    // swallow — never block dispatch on the symbol graph
  }

  return fitWithinBudget([
    { heading: 'directives', lines: renderDirectivesSection(directives) },
    { heading: 'outcomes', lines: renderOutcomesSection(outcomes) },
    { heading: 'symbols', lines: renderSymbolGraphSection(edges) },
  ]);
}

/**
 * Convenience helper: prepend the `<context>` block to a packet body,
 * collapsing to the original body when the helper resolves empty (binary
 * missing, no data, etc.). Never throws.
 */
export async function prependContextBlock(input: BuildContextBlockInput): Promise<string> {
  try {
    const block = await buildContextBlock(input);
    if (!block) return input.packetBody;
    return `${block}\n\n${input.packetBody}`;
  } catch (error) {
    console.warn('[context-injection] prepend failed:', error);
    return input.packetBody;
  }
}
