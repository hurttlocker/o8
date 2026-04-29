/**
 * #748 — Cross-repo learning.
 *
 * When a directive lands in repo A and ≥ 2 other registered repos share a
 * stack signature with A (Jaccard overlap ≥ 0.8), surface a yellow
 * proposal row in those target repos' orchestrator views. The operator
 * accepts (duplicates the directive scoped to the target) or dismisses
 * (snoozes the (target, directive) pair for 30 days). Always human-gated.
 *
 * The proposer never writes a directive itself. Accept text drives the
 * orchestrator chat composer; the orchestrator's existing memory tools
 * handle the actual markdown write — this matches #746's flow.
 *
 * Storage:
 *   ~/.o8/stack-signatures.json — cached signatures (owned by stack-signature.ts)
 *   ~/.o8/cross-repo-snooze.json — append-only ledger of dismissed (target, directive) pairs
 *
 * Proposal id: sha1(`${targetRepoId}::${directiveId}`).slice(0,16) — stable
 * across ticks so dismiss survives recomputes.
 */

import 'server-only';

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import { getDataDir } from '@/lib/data-dir-migration';
import { listRepos } from '@/lib/repos/registry';
import type { RepoRegistryEntry } from '@/lib/repos/types';
import { readOrComputeSignatures } from '@/lib/cortex/stack-signature';

const SIMILARITY_THRESHOLD = 0.8;
const MIN_SIMILAR_REPOS = 2;
const SNOOZE_DAYS = 30;
const MAX_CANDIDATES = 12;
const SNOOZE_FILE = 'cross-repo-snooze.json';

// ── directive read (same parser shape as cortex/directives/route.ts) ──────

const FRONT_MATTER_BOUNDARY = /^---\s*$/m;

interface DirectiveSummary {
  id: string;
  title: string;
  scope: string;
  repoName: string | null;
  priority: number | null;
  body: string;
}

function parseDirectiveFile(raw: string, fallbackId: string): DirectiveSummary | null {
  const text = raw.replace(/\r\n/g, '\n').trim();
  if (!text.startsWith('---')) return null;

  const afterFirst = text.slice(3).trimStart();
  const closingIndex = afterFirst.search(FRONT_MATTER_BOUNDARY);
  if (closingIndex < 0) return null;

  const front = afterFirst.slice(0, closingIndex);
  const rawBody = afterFirst.slice(closingIndex).replace(FRONT_MATTER_BOUNDARY, '').trim();
  const body = rawBody.replace(/\n*##\s+Recent Merges\b[\s\S]*$/, '').trim();

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

function listDirectiveFiles(): { name: string; path: string }[] {
  try {
    const dir = join(getDataDir(), 'directives');
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((name) => name.endsWith('.md'))
      .map((name) => ({ name, path: join(dir, name) }));
  } catch {
    return [];
  }
}

function readAllDirectives(): DirectiveSummary[] {
  const files = listDirectiveFiles();
  const out: DirectiveSummary[] = [];
  for (const file of files) {
    try {
      const raw = readFileSync(file.path, 'utf-8');
      const fallbackId = file.name.replace(/\.md$/, '');
      const parsed = parseDirectiveFile(raw, fallbackId);
      if (parsed) out.push(parsed);
    } catch {
      // skip unreadable
    }
  }
  return out;
}

// ── snooze ledger ─────────────────────────────────────────────────────────

interface SnoozeEntry {
  /** Composite proposal id — `sha1(targetRepoId::directiveId).slice(0,16)`. */
  id: string;
  targetRepoId: string;
  directiveId: string;
  snoozedUntil: string; // ISO-8601
}

interface SnoozeLedger {
  version: 1;
  entries: SnoozeEntry[];
}

function snoozeFilePath(): string {
  return join(getDataDir(), SNOOZE_FILE);
}

function readSnoozeLedger(): SnoozeLedger {
  const path = snoozeFilePath();
  if (!existsSync(path)) return { version: 1, entries: [] };
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<SnoozeLedger>;
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.entries)) {
      return { version: 1, entries: [] };
    }
    const entries = parsed.entries.filter(
      (e): e is SnoozeEntry =>
        !!e &&
        typeof e === 'object' &&
        typeof e.id === 'string' &&
        typeof e.targetRepoId === 'string' &&
        typeof e.directiveId === 'string' &&
        typeof e.snoozedUntil === 'string',
    );
    return { version: 1, entries };
  } catch (err) {
    console.warn('[cross-repo-proposer] Failed to parse snooze ledger:', err instanceof Error ? err.message : err);
    return { version: 1, entries: [] };
  }
}

function writeSnoozeLedger(ledger: SnoozeLedger): void {
  try {
    writeFileSync(snoozeFilePath(), JSON.stringify(ledger, null, 2), 'utf-8');
  } catch (err) {
    console.warn('[cross-repo-proposer] Failed to write snooze ledger:', err instanceof Error ? err.message : err);
  }
}

function activeSnoozedIds(now: Date): Set<string> {
  const ledger = readSnoozeLedger();
  const out = new Set<string>();
  for (const entry of ledger.entries) {
    const until = Date.parse(entry.snoozedUntil);
    if (Number.isFinite(until) && until > now.getTime()) {
      out.add(entry.id);
    }
  }
  return out;
}

/**
 * Append-only snooze. Stale entries pile up but are filtered at read time;
 * matches #746's pattern.
 */
export function snoozeCrossRepoProposal(input: {
  targetRepoId: string;
  directiveId: string;
}): SnoozeEntry {
  const id = makeProposalId(input.targetRepoId, input.directiveId);
  const snoozedUntil = new Date(Date.now() + SNOOZE_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const entry: SnoozeEntry = {
    id,
    targetRepoId: input.targetRepoId,
    directiveId: input.directiveId,
    snoozedUntil,
  };
  const ledger = readSnoozeLedger();
  ledger.entries.push(entry);
  writeSnoozeLedger(ledger);
  return entry;
}

// ── proposal id + similarity ──────────────────────────────────────────────

function makeProposalId(targetRepoId: string, directiveId: string): string {
  return createHash('sha1')
    .update(`${targetRepoId}::${directiveId}`, 'utf-8')
    .digest('hex')
    .slice(0, 16);
}

function jaccard(aDeps: string[], bDeps: string[]): number {
  if (aDeps.length === 0 && bDeps.length === 0) return 0;
  const setA = new Set(aDeps);
  const setB = new Set(bDeps);
  let intersect = 0;
  for (const dep of setA) {
    if (setB.has(dep)) intersect += 1;
  }
  const union = setA.size + setB.size - intersect;
  if (union === 0) return 0;
  return intersect / union;
}

// ── source-repo resolution for a directive ───────────────────────────────

function findSourceRepo(
  directive: DirectiveSummary,
  repos: RepoRegistryEntry[],
): RepoRegistryEntry | null {
  // Repo-scoped directive: front matter `repoName: <name>` or `scope: <name>`.
  const declared = (directive.repoName || directive.scope || '').toLowerCase();
  if (declared && declared !== 'global' && declared !== 'repo') {
    const match = repos.find((r) => r.name.toLowerCase() === declared);
    if (match) return match;
  }
  // Some directives use `scope: repo` + `repoName:` — handled by the branch above.
  // `scope: global` directives never propose cross-repo (they already apply
  // everywhere); return null so the caller skips them.
  return null;
}

// ── public surface ────────────────────────────────────────────────────────

export interface CrossRepoProposalCandidate {
  /**
   * Discriminator so `DirectiveProposalRow` can render both auto rows and
   * cross-repo rows from a shared list. Always `'cross-repo'` here.
   */
  source: 'cross-repo';
  id: string;
  /** Repo the operator will see this proposal in. */
  targetRepoId: string;
  targetRepoName: string;
  /** Repo the directive originated from. */
  sourceRepoId: string;
  sourceRepoName: string;
  /** Directive payload. */
  directiveId: string;
  directiveTitle: string;
  directiveBody: string;
  directivePriority: number | null;
  /** Jaccard similarity between source and target (0..1). */
  similarity: number;
  /** Pre-rendered draft text the chat composer fills with on Accept. */
  draftDirective: string;
}

export interface ProposeAcrossReposOutput {
  /**
   * Map of directive id → list of target repo IDs that meet the similarity
   * threshold (and aren't snoozed). Useful for callers that just need to
   * know "who to fan this out to".
   */
  byDirective: Record<string, string[]>;
  /** Flat list — what the API surface returns. */
  candidates: CrossRepoProposalCandidate[];
}

interface ProposeOptions {
  /** Override "now" for tests. */
  now?: Date;
  /** Cap on candidates returned. */
  limit?: number;
}

function buildDraft(directive: DirectiveSummary, target: RepoRegistryEntry): string {
  // Re-emit the directive body with target repo metadata patched in. The
  // operator edits before saving — this is a starting point, not a final
  // form. Keeping the existing body verbatim avoids "lossy translation"
  // surprises.
  return [
    `# ${directive.title}`,
    '',
    `Imported from \`${directive.repoName ?? '(source repo)'}\` for \`${target.name}\`.`,
    '',
    'Original rule:',
    '',
    directive.body || '_(empty body — the source directive has no description)_',
  ].join('\n');
}

/**
 * Compute proposals for every registered repo. Synchronous read of cached
 * signatures + the directives dir + snooze ledger.
 *
 * Returns an empty result when:
 *   - signatures haven't been computed yet (caller should kick boot tick)
 *   - fewer than 3 repos are registered (the issue specifies ≥ 3 sharing a stack)
 *   - no repo-scoped directives exist
 */
export async function proposeAcrossRepos(
  options: ProposeOptions = {},
): Promise<ProposeAcrossReposOutput> {
  const limit = options.limit ?? MAX_CANDIDATES;
  const now = options.now ?? new Date();

  let repos: RepoRegistryEntry[] = [];
  try {
    repos = await listRepos();
  } catch {
    return { byDirective: {}, candidates: [] };
  }
  if (repos.length < 3) return { byDirective: {}, candidates: [] };

  const signatureStore = await readOrComputeSignatures();
  const sigByRepoId = new Map<string, string[]>();
  for (const sig of signatureStore.signatures) {
    sigByRepoId.set(sig.repoId, sig.deps);
  }

  const directives = readAllDirectives();
  if (directives.length === 0) return { byDirective: {}, candidates: [] };

  const snoozed = activeSnoozedIds(now);
  const candidates: CrossRepoProposalCandidate[] = [];
  const byDirective: Record<string, string[]> = {};

  for (const directive of directives) {
    const sourceRepo = findSourceRepo(directive, repos);
    if (!sourceRepo) continue;

    const sourceDeps = sigByRepoId.get(sourceRepo.id);
    // No signature recorded yet — skip (boot tick will fix it on next pass).
    if (!sourceDeps || sourceDeps.length === 0) continue;

    // Find every other repo with similarity ≥ threshold.
    const similarRepos: { repo: RepoRegistryEntry; similarity: number }[] = [];
    for (const target of repos) {
      if (target.id === sourceRepo.id) continue;
      const targetDeps = sigByRepoId.get(target.id);
      if (!targetDeps || targetDeps.length === 0) continue;
      const sim = jaccard(sourceDeps, targetDeps);
      if (sim >= SIMILARITY_THRESHOLD) {
        similarRepos.push({ repo: target, similarity: sim });
      }
    }

    // Issue spec: only fire when ≥ 2 similar repos exist (3 total counting
    // source). One similar peer isn't a "stack" worth fanning out to.
    if (similarRepos.length < MIN_SIMILAR_REPOS) continue;

    byDirective[directive.id] = similarRepos.map((s) => s.repo.id);
    for (const { repo: target, similarity } of similarRepos) {
      const id = makeProposalId(target.id, directive.id);
      if (snoozed.has(id)) continue;
      candidates.push({
        source: 'cross-repo',
        id,
        targetRepoId: target.id,
        targetRepoName: target.name,
        sourceRepoId: sourceRepo.id,
        sourceRepoName: sourceRepo.name,
        directiveId: directive.id,
        directiveTitle: directive.title,
        directiveBody: directive.body,
        directivePriority: directive.priority,
        similarity,
        draftDirective: buildDraft(directive, target),
      });
    }
  }

  // Sort by similarity (highest match first), then alphabetically by target
  // name so output stays stable across recomputes.
  candidates.sort((a, b) => {
    if (b.similarity !== a.similarity) return b.similarity - a.similarity;
    if (a.targetRepoName !== b.targetRepoName) return a.targetRepoName.localeCompare(b.targetRepoName);
    return a.directiveTitle.localeCompare(b.directiveTitle);
  });

  return {
    byDirective,
    candidates: candidates.slice(0, limit),
  };
}

// ── boot tick wiring ──────────────────────────────────────────────────────

let bootTickFired = false;
let lastTickAt = 0;
const TICK_INTERVAL_MS = 30 * 60 * 1000;

let cachedCandidates: CrossRepoProposalCandidate[] = [];
let cachedAt = 0;

async function runTick(): Promise<void> {
  try {
    const result = await proposeAcrossRepos();
    cachedCandidates = result.candidates;
    cachedAt = Date.now();
    lastTickAt = cachedAt;
  } catch (err) {
    console.warn('[cross-repo-proposer] tick threw:', err instanceof Error ? err.message : err);
  }
}

/** Idempotent boot hook — same shape as `ensureProposerBootTick`. */
export function ensureCrossRepoProposerBootTick(): void {
  if (bootTickFired) return;
  bootTickFired = true;
  setImmediate(() => {
    void runTick();
  });
  const interval = setInterval(() => {
    if (Date.now() - lastTickAt < TICK_INTERVAL_MS - 5_000) return;
    void runTick();
  }, TICK_INTERVAL_MS);
  if (typeof interval.unref === 'function') interval.unref();
}

export async function readCachedCrossRepoProposals(): Promise<{
  candidates: CrossRepoProposalCandidate[];
  computedAt: number;
}> {
  if (cachedAt === 0) {
    await runTick();
  }
  return { candidates: cachedCandidates, computedAt: cachedAt };
}
