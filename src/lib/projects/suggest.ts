/**
 * #899 — AI project semantics, Stage 2 (LLM groupings).
 *
 * Reads every registered repo's Stage 1 fingerprint, asks Gemini Flash to
 * group the repos into Projects, and returns a typed list of suggestions
 * the operator can accept, edit, or dismiss.
 *
 * Cache-first: keyed by sha256(sorted repoIds + sorted fingerprint hashes),
 * persisted to `~/.o8/project-suggestions.json`. Same set of repos with
 * unchanged fingerprints → identical suggestion list, no LLM call.
 *
 * Privacy: the LLM only sees the ≤2KB fingerprint per repo (no source).
 */

import 'server-only';

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import { getDataDir } from '@/lib/data-dir-migration';
import { listRepos } from '@/lib/repos/registry';
import {
  getOrComputeFingerprint,
} from './fingerprint-cache';
import type { RepoFingerprint } from './fingerprint';
import { isDismissed } from './store';
import type { ProjectRole } from './types';

// ── Public types ──

export type SuggestionConfidence = 'confident' | 'plausible';

export type EvidenceKind =
  | 'shared-org'
  | 'cross-link'
  | 'shared-dep'
  | 'deploy-pair'
  | 'topic-overlap'
  | 'language-overlap'
  | 'naming-pattern';

export interface SuggestionEvidence {
  kind: EvidenceKind;
  repoId: string;
  snippet: string;
}

export interface ProjectSuggestion {
  /** sha256 of sorted repoIds — the dismissal key. */
  id: string;
  suggestedName: string;
  repoIds: string[];
  primaryRepoId?: string;
  evidence: SuggestionEvidence[];
  confidence: SuggestionConfidence;
  rationale: string;
  detectedRoles: Record<string, ProjectRole>;
}

export interface SuggestProjectsResult {
  suggestions: ProjectSuggestion[];
  generatedAt: number;
  cached: boolean;
}

// ── Cache file ──

const CACHE_FILE_NAME = 'project-suggestions.json';

interface CacheFileShape {
  cacheKey: string;
  generatedAt: number;
  suggestions: ProjectSuggestion[];
}

function cachePath(): string {
  return join(getDataDir(), CACHE_FILE_NAME);
}

function readCache(): CacheFileShape | null {
  try {
    const path = cachePath();
    if (!existsSync(path)) return null;
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<CacheFileShape>;
    if (!parsed || typeof parsed !== 'object') return null;
    if (typeof parsed.cacheKey !== 'string') return null;
    if (!Array.isArray(parsed.suggestions)) return null;
    if (typeof parsed.generatedAt !== 'number') return null;
    return parsed as CacheFileShape;
  } catch {
    return null;
  }
}

function writeCache(payload: CacheFileShape): void {
  try {
    mkdirSync(getDataDir(), { recursive: true });
    writeFileSync(cachePath(), JSON.stringify(payload, null, 2), 'utf-8');
  } catch (err) {
    console.warn('[project-suggest] Failed to persist cache:', err instanceof Error ? err.message : err);
  }
}

/** Internal: rewrite the cache atomically when a single suggestion is removed. */
function persistRemainingSuggestions(remaining: ProjectSuggestion[], previous: CacheFileShape | null) {
  if (!previous) return;
  writeCache({
    cacheKey: previous.cacheKey,
    generatedAt: previous.generatedAt,
    suggestions: remaining,
  });
}

/** Mutate the live cache after the operator accepts (creates a project from) or dismisses one. */
export function removeSuggestionFromCache(suggestionId: string): boolean {
  const previous = readCache();
  if (!previous) return false;
  const next = previous.suggestions.filter((s) => s.id !== suggestionId);
  if (next.length === previous.suggestions.length) return false;
  persistRemainingSuggestions(next, previous);
  return true;
}

/** Look up a suggestion in the live cache by id. */
export function getCachedSuggestion(suggestionId: string): ProjectSuggestion | null {
  const cache = readCache();
  if (!cache) return null;
  return cache.suggestions.find((s) => s.id === suggestionId) ?? null;
}

// ── Cache key + grouping id ──

function computeCacheKey(fingerprints: RepoFingerprint[]): string {
  const sortedRepoIds = fingerprints.map((fp) => fp.repoId).sort();
  const sortedHashes = fingerprints.map((fp) => fp.hash).sort();
  const seed = JSON.stringify({ repoIds: sortedRepoIds, hashes: sortedHashes });
  return createHash('sha256').update(seed, 'utf-8').digest('hex');
}

function computeGroupingId(repoIds: string[]): string {
  const sorted = [...repoIds].sort();
  return createHash('sha256').update(JSON.stringify(sorted), 'utf-8').digest('hex');
}

// ── LLM call ──

const GEMINI_MODEL = 'gemini-2.5-flash';
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
const GEMINI_TIMEOUT_MS = 30_000;

const VALID_ROLES = new Set<ProjectRole>([
  'frontend',
  'backend',
  'fullstack',
  'mobile',
  'library',
  'service',
  'infra',
  'docs',
  'site',
  'shared',
]);

const VALID_EVIDENCE_KINDS = new Set<EvidenceKind>([
  'shared-org',
  'cross-link',
  'shared-dep',
  'deploy-pair',
  'topic-overlap',
  'language-overlap',
  'naming-pattern',
]);

/**
 * Build the prompt that asks Gemini to group fingerprints into Projects.
 *
 * The model must return strict JSON matching `LlmResponseShape`. We prepend
 * a system instruction; the user message is the array of fingerprints.
 */
function buildPrompt(fingerprints: RepoFingerprint[]): {
  system: string;
  user: string;
} {
  const system = `You are an expert software architect helping an operator group repositories into Projects.

A "Project" is a set of repos that ship together as one product surface — e.g. a web app and its marketing site, a frontend and its backend API, a mobile app and its shared SDK. Repos in unrelated products do NOT belong in the same Project.

You will receive an array of repo fingerprints. Each fingerprint contains:
- repoId, github metadata (description, topics, primaryLanguage, homepage)
- manifest (package.json/Cargo.toml/etc) name + dependency NAMES (versions stripped)
- README first ~100 lines and any github.com cross-links found inside
- Top-level folders
- Deploy hints (vercel/railway/Dockerfile/.env.example KEYS)

Your job: emit grouping decisions in JSON.

Rules:
1. Only group repos that have CONCRETE shared signals: shared GitHub org, README cross-links between them, shared dependency names, matching deploy targets, overlapping topics, or matching naming patterns (e.g. "foo" + "foo-site").
2. A grouping with fewer than 2 supporting evidence items is NOT valid — drop it.
3. Each repo can appear in at most one grouping.
4. For each grouped repo, assign a role from this exact set: frontend, backend, fullstack, mobile, library, service, infra, docs, site, shared.
5. For each grouping, cite 2–6 evidence items. Each evidence item picks ONE repoId in the grouping and one kind from: shared-org, cross-link, shared-dep, deploy-pair, topic-overlap, language-overlap, naming-pattern. The "snippet" is a SHORT human-readable phrase (≤80 chars) like "shared org: hurttlocker" or "o8-site README links to o8".
6. Provide a 1–2 sentence rationale for each grouping. The rationale is shown to the operator.
7. Suggest a Project name. Prefer the dominant brand name (e.g. "o8" if the brand appears across the group) over a generic label.
8. If a single repo is the obvious primary (the app, not the docs/site), set primaryRepoId to its repoId.
9. If you find no valid groupings, return an empty groupings array.

Return ONLY valid JSON in this exact shape:
{
  "groupings": [
    {
      "suggestedName": "string",
      "repoIds": ["string", ...],
      "primaryRepoId": "string" | null,
      "rationale": "string",
      "evidence": [
        { "kind": "shared-org" | "cross-link" | "shared-dep" | "deploy-pair" | "topic-overlap" | "language-overlap" | "naming-pattern", "repoId": "string", "snippet": "string" }
      ],
      "detectedRoles": { "<repoId>": "frontend" | "backend" | "fullstack" | "mobile" | "library" | "service" | "infra" | "docs" | "site" | "shared" }
    }
  ]
}`;

  const user = `Here are the repo fingerprints. Group them into Projects per the rules above.

${JSON.stringify(fingerprints, null, 2)}`;

  return { system, user };
}

interface LlmGrouping {
  suggestedName: string;
  repoIds: string[];
  primaryRepoId?: string | null;
  rationale: string;
  evidence: SuggestionEvidence[];
  detectedRoles: Record<string, ProjectRole>;
}

interface LlmResponseShape {
  groupings: LlmGrouping[];
}

/** Resolve the Gemini API key the same way the operator route does. */
function resolveGeminiKey(): string | null {
  return (
    process.env.GOOGLE_AI_API_KEY
    || process.env.GOOGLE_GENERATIVE_AI_API_KEY
    || process.env.GEMINI_API_KEY
    || null
  );
}

/**
 * Single Gemini POST. Returns the raw HTTP response for the caller to
 * inspect — non-2xx errors are NOT thrown here; that lets the retry loop
 * decide which statuses are worth a backoff vs. fatal.
 */
async function postGeminiOnce(apiKey: string, body: unknown): Promise<globalThis.Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);

  try {
    return await fetch(GEMINI_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

const GEMINI_RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const GEMINI_MAX_ATTEMPTS = 4;

async function callGemini(fingerprints: RepoFingerprint[]): Promise<LlmResponseShape> {
  const apiKey = resolveGeminiKey();
  if (!apiKey) {
    throw new Error('No Gemini API key configured. Set GOOGLE_AI_API_KEY (or GEMINI_API_KEY) to enable AI suggestions.');
  }

  const { system, user } = buildPrompt(fingerprints);

  const body = {
    system_instruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ text: user }] }],
    generationConfig: {
      response_mime_type: 'application/json',
      temperature: 0.2,
      max_output_tokens: 4_096,
    },
  };

  let res: globalThis.Response | null = null;
  let lastErrText = '';
  for (let attempt = 1; attempt <= GEMINI_MAX_ATTEMPTS; attempt += 1) {
    try {
      res = await postGeminiOnce(apiKey, body);
    } catch (err) {
      // Network/abort error — retry with backoff.
      lastErrText = err instanceof Error ? err.message : String(err);
      res = null;
    }

    if (res && res.ok) break;

    if (res) {
      lastErrText = await res.text().catch(() => 'unknown error');
      if (!GEMINI_RETRY_STATUSES.has(res.status)) {
        throw new Error(`Gemini API ${res.status}: ${lastErrText.slice(0, 400)}`);
      }
    }

    if (attempt === GEMINI_MAX_ATTEMPTS) {
      const status = res?.status ?? 0;
      throw new Error(
        `Gemini API ${status || 'network'} after ${GEMINI_MAX_ATTEMPTS} attempts: ${lastErrText.slice(0, 400)}`,
      );
    }

    // Exponential backoff: 1s, 2s, 4s.
    const delay = 1_000 * 2 ** (attempt - 1);
    console.warn(`[project-suggest] Gemini transient ${res?.status ?? 'network'} — retrying in ${delay}ms…`);
    await new Promise((resolve) => setTimeout(resolve, delay));
  }

  if (!res) {
    // Defensive — the loop above always sets res or throws.
    throw new Error('Gemini call returned no response.');
  }

  const payload = await res.json() as {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string }> };
    }>;
  };

  const text = payload.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  if (!text.trim()) {
    return { groupings: [] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Sometimes the model wraps JSON in fences despite mime-type request — strip and retry.
    const stripped = text
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();
    try {
      parsed = JSON.parse(stripped);
    } catch (err) {
      throw new Error(`Gemini returned non-JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (!parsed || typeof parsed !== 'object') {
    return { groupings: [] };
  }
  const obj = parsed as { groupings?: unknown };
  if (!Array.isArray(obj.groupings)) return { groupings: [] };
  return { groupings: obj.groupings as LlmGrouping[] };
}

// ── Validation + post-processing ──

function isString(v: unknown): v is string {
  return typeof v === 'string';
}

function validateGrouping(
  raw: LlmGrouping,
  knownRepoIds: Set<string>,
): ProjectSuggestion | null {
  if (!raw || typeof raw !== 'object') return null;

  // suggestedName
  const suggestedName = isString(raw.suggestedName) ? raw.suggestedName.trim() : '';
  if (!suggestedName) return null;

  // repoIds — at least 2, all known.
  if (!Array.isArray(raw.repoIds)) return null;
  const repoIds = raw.repoIds.filter(isString).filter((id) => knownRepoIds.has(id));
  const dedupRepoIds = [...new Set(repoIds)];
  if (dedupRepoIds.length < 2) return null;

  // primaryRepoId — optional; must be in repoIds.
  const primaryRepoId = isString(raw.primaryRepoId) && dedupRepoIds.includes(raw.primaryRepoId)
    ? raw.primaryRepoId
    : undefined;

  // rationale — required, ≤320 chars.
  const rationale = isString(raw.rationale) ? raw.rationale.trim().slice(0, 320) : '';
  if (!rationale) return null;

  // evidence — at least 2 items, all valid kinds, repoId in the grouping.
  if (!Array.isArray(raw.evidence)) return null;
  const evidence: SuggestionEvidence[] = [];
  for (const e of raw.evidence) {
    if (!e || typeof e !== 'object') continue;
    const ev = e as Partial<SuggestionEvidence>;
    if (!isString(ev.kind) || !VALID_EVIDENCE_KINDS.has(ev.kind as EvidenceKind)) continue;
    if (!isString(ev.repoId) || !dedupRepoIds.includes(ev.repoId)) continue;
    if (!isString(ev.snippet)) continue;
    const snippet = ev.snippet.trim().slice(0, 160);
    if (!snippet) continue;
    evidence.push({
      kind: ev.kind as EvidenceKind,
      repoId: ev.repoId,
      snippet,
    });
    if (evidence.length >= 8) break;
  }
  if (evidence.length < 2) return null;

  // detectedRoles — only keep entries for repos in the grouping with valid role values.
  const detectedRoles: Record<string, ProjectRole> = {};
  if (raw.detectedRoles && typeof raw.detectedRoles === 'object') {
    for (const [rId, role] of Object.entries(raw.detectedRoles as Record<string, unknown>)) {
      if (!dedupRepoIds.includes(rId)) continue;
      if (!isString(role) || !VALID_ROLES.has(role as ProjectRole)) continue;
      detectedRoles[rId] = role as ProjectRole;
    }
  }

  // Confidence: confident iff (≥3 evidence) AND (shared-org OR shared-dep OR cross-link).
  const evidenceKinds = new Set(evidence.map((e) => e.kind));
  const hasStrongKind = evidenceKinds.has('shared-org')
    || evidenceKinds.has('shared-dep')
    || evidenceKinds.has('cross-link');
  const confidence: SuggestionConfidence = evidence.length >= 3 && hasStrongKind
    ? 'confident'
    : 'plausible';

  return {
    id: computeGroupingId(dedupRepoIds),
    suggestedName,
    repoIds: dedupRepoIds,
    ...(primaryRepoId ? { primaryRepoId } : {}),
    evidence,
    confidence,
    rationale,
    detectedRoles,
  };
}

/**
 * Each repo can appear in at most one grouping. If the LLM emits overlapping
 * groupings we keep the first one in evidence-count order — confident-strong
 * groupings beat speculative ones.
 */
function dedupeRepoOverlap(suggestions: ProjectSuggestion[]): ProjectSuggestion[] {
  const sorted = [...suggestions].sort((a, b) => {
    if (a.confidence !== b.confidence) {
      return a.confidence === 'confident' ? -1 : 1;
    }
    return b.evidence.length - a.evidence.length;
  });
  const claimed = new Set<string>();
  const out: ProjectSuggestion[] = [];
  for (const s of sorted) {
    if (s.repoIds.some((rid) => claimed.has(rid))) continue;
    s.repoIds.forEach((rid) => claimed.add(rid));
    out.push(s);
  }
  return out;
}

// ── Public entry point ──

export interface SuggestProjectsOptions {
  force?: boolean;
}

/**
 * Pull every registered repo's fingerprint, ask Gemini Flash to group them,
 * and return validated suggestions. Cache-keyed by the set of fingerprint
 * hashes — second call returns the cached payload unless `force` is true.
 */
export async function suggestProjects(opts: SuggestProjectsOptions = {}): Promise<SuggestProjectsResult> {
  const repos = await listRepos();

  // Drop repos that opted out of AI semantics. The flag isn't part of the
  // typed registry yet — read it defensively from the raw record so we
  // honor it the moment it lands.
  const eligibleRepos = repos.filter((repo) => {
    const flag = (repo as unknown as { ai_semantic_excluded?: boolean }).ai_semantic_excluded;
    return flag !== true;
  });

  if (eligibleRepos.length < 2) {
    // Need at least two repos before we can suggest a Project.
    return {
      suggestions: [],
      generatedAt: Date.now(),
      cached: false,
    };
  }

  // Pull fingerprints in parallel. github metadata isn't available here yet —
  // the fingerprint module accepts undefined and falls back to repo name +
  // disk content, which is what Stage 1 already produces.
  const fingerprints = await Promise.all(
    eligibleRepos.map((repo) => getOrComputeFingerprint(repo.id)),
  );

  const cacheKey = computeCacheKey(fingerprints);

  if (!opts.force) {
    const cached = readCache();
    if (cached && cached.cacheKey === cacheKey) {
      // Filter out anything dismissed since last write.
      const live = cached.suggestions.filter((s) => !isDismissed(s.id));
      return {
        suggestions: live,
        generatedAt: cached.generatedAt,
        cached: true,
      };
    }
  }

  // LLM call
  let llmResult: LlmResponseShape;
  try {
    llmResult = await callGemini(fingerprints);
  } catch (err) {
    console.warn('[project-suggest] Gemini call failed:', err instanceof Error ? err.message : err);
    throw err;
  }

  const knownRepoIds = new Set(fingerprints.map((fp) => fp.repoId));
  const validated = (llmResult.groupings ?? [])
    .map((g) => validateGrouping(g, knownRepoIds))
    .filter((s): s is ProjectSuggestion => s !== null);

  const deduped = dedupeRepoOverlap(validated);
  const undismissed = deduped.filter((s) => !isDismissed(s.id));

  const generatedAt = Date.now();
  writeCache({
    cacheKey,
    generatedAt,
    suggestions: undismissed,
  });

  return {
    suggestions: undismissed,
    generatedAt,
    cached: false,
  };
}
