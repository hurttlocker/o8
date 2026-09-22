/**
 * A bounded, advisory review-order overlay for the deterministic architecture map.
 *
 * The provider sees module paths and graph facts, never source bodies or generated prose.
 * Results may annotate and order review suggestions, but never hide evidence or gate work.
 */
import 'server-only';

import { createHash } from 'node:crypto';

import {
  askJudgment,
  thresholdAnswer,
  TYPESAFE_MODEL,
  type AskJudgmentOptions,
} from '@/lib/judgment/client';
import { isJudgmentRefereeEnabled } from '@/lib/judgment/route';
import type { ChoiceQuestion, JudgmentQuestionSet, ScoreQuestion } from '@/lib/judgment/types';
import type { ArchitectureDeltaResult } from './architecture-delta-types';
import type {
  ArchitectureAttentionItem,
  ArchitectureAttentionResult,
  ArchitectureReviewLens,
} from './architecture-attention-types';

export const ARCHITECTURE_ATTENTION_SURFACE = 'architecture-attention';
export const ARCHITECTURE_ATTENTION_MAX_MODULES = 20;
export const ARCHITECTURE_ATTENTION_QUESTION_VERSION = 'architecture-attention-v1';

const PRODUCTION_TRANSPORT: AskJudgmentOptions = { timeoutMs: 1_200, maxAttempts: 1 };
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX_ENTRIES = 32;

const LENS_CRITERIA: Record<ArchitectureReviewLens, string> = {
  auth_trust: 'Authentication, authorization, identity, trust boundaries, secrets, or permissions are the clearest review lens.',
  state_persistence: 'Stored state, database access, serialization, cache consistency, migrations, or recovery are the clearest review lens.',
  async_lifecycle: 'Concurrency, ordering, retries, cancellation, queues, long-running work, or lifecycle cleanup are the clearest review lens.',
  interface_contract: 'API boundaries, schemas, protocol contracts, imports, exports, adapters, or cross-module compatibility are the clearest review lens.',
  ui_behavior: 'User-visible interface state, interaction, accessibility, rendering, or navigation are the clearest review lens.',
  tests_docs: 'Tests, fixtures, documentation, examples, or verification coverage are the clearest review lens.',
  general: 'No more specific lens is clearly supported by the supplied path and topology facts.',
};

const ATTENTION_CRITERIA = [
  'Review later: the supplied topology facts show a narrow or mostly isolated change.',
  'Review normally: the module touches a meaningful boundary or several relationships.',
  'Review early: the module is central, cyclic, removes a relationship, or changes a high-consequence boundary.',
] as const;

interface Candidate {
  path: string;
  reviewPath: string;
  state: 'added' | 'removed' | 'changed';
  incoming: number;
  outgoing: number;
  addedRelationships: number;
  removedRelationships: number;
  crossDirectoryRelationships: number;
  inLiveCycle: boolean;
  neighborPaths: string[];
  deterministicPriority: number;
  signals: string[];
}

interface CachedResult {
  expiresAt: number;
  result: ArchitectureAttentionResult;
}

const cache = new Map<string, CachedResult>();
let transportOverride: AskJudgmentOptions | undefined;

export function setArchitectureAttentionTransportForTests(options: AskJudgmentOptions | undefined): void {
  transportOverride = options;
}

function baseResult(
  status: ArchitectureAttentionResult['status'],
  reason: string | null,
  analysisId: string | null,
): ArchitectureAttentionResult {
  return {
    ok: true,
    status,
    reason,
    analysisId,
    items: [],
    model: null,
    latencyMs: null,
    receiptId: null,
    cached: false,
    generatedAt: new Date().toISOString(),
  };
}

function directoryOf(filePath: string) {
  const separator = filePath.lastIndexOf('/');
  return separator === -1 ? '.' : filePath.slice(0, separator);
}

function liveCyclicPaths(result: ArchitectureDeltaResult) {
  const ids = result.nodes.map((node) => node.path);
  const adjacency = new Map(ids.map((id) => [id, [] as string[]]));
  for (const edge of result.edges) {
    if (edge.state !== 'removed') adjacency.get(edge.from)?.push(edge.to);
  }
  let index = 0;
  const stack: string[] = [];
  const onStack = new Set<string>();
  const indices = new Map<string, number>();
  const lowLinks = new Map<string, number>();
  const cyclic = new Set<string>();
  const visit = (id: string) => {
    indices.set(id, index);
    lowLinks.set(id, index);
    index += 1;
    stack.push(id);
    onStack.add(id);
    for (const target of adjacency.get(id) ?? []) {
      if (!indices.has(target)) {
        visit(target);
        lowLinks.set(id, Math.min(lowLinks.get(id) ?? 0, lowLinks.get(target) ?? 0));
      } else if (onStack.has(target)) {
        lowLinks.set(id, Math.min(lowLinks.get(id) ?? 0, indices.get(target) ?? 0));
      }
    }
    if (lowLinks.get(id) !== indices.get(id)) return;
    const component: string[] = [];
    let member: string | undefined;
    do {
      member = stack.pop();
      if (!member) break;
      onStack.delete(member);
      component.push(member);
    } while (member !== id);
    if (component.length > 1 || (adjacency.get(id) ?? []).includes(id)) {
      component.forEach((path) => cyclic.add(path));
    }
  };
  ids.forEach((id) => { if (!indices.has(id)) visit(id); });
  return cyclic;
}

function candidatesFor(result: ArchitectureDeltaResult): Candidate[] {
  const cyclic = liveCyclicPaths(result);
  return result.nodes.flatMap((node): Candidate[] => {
    if (node.state === 'context') return [];
    const touching = result.edges.filter((edge) => edge.from === node.path || edge.to === node.path);
    const neighborPaths = [...new Set(touching.map((edge) => (
      edge.from === node.path ? edge.to : edge.from
    )))].sort().slice(0, 12);
    const addedRelationships = touching.filter((edge) => edge.state === 'added').length;
    const removedRelationships = touching.filter((edge) => edge.state === 'removed').length;
    const crossDirectoryRelationships = touching.filter((edge) => directoryOf(edge.from) !== directoryOf(edge.to)).length;
    const inLiveCycle = cyclic.has(node.path);
    const incoming = touching.filter((edge) => edge.to === node.path).length;
    const outgoing = touching.filter((edge) => edge.from === node.path).length;
    const signals = [
      ...(inLiveCycle ? ['live cycle'] : []),
      ...(removedRelationships ? [`${removedRelationships} removed relationship${removedRelationships === 1 ? '' : 's'}`] : []),
      ...(addedRelationships ? [`${addedRelationships} added relationship${addedRelationships === 1 ? '' : 's'}`] : []),
      ...(crossDirectoryRelationships ? [`${crossDirectoryRelationships} cross-directory relationship${crossDirectoryRelationships === 1 ? '' : 's'}`] : []),
    ];
    const deterministicPriority = (inLiveCycle ? 100 : 0)
      + removedRelationships * 12
      + addedRelationships * 8
      + crossDirectoryRelationships * 5
      + incoming * 2
      + outgoing
      + (node.state === 'removed' ? 4 : node.state === 'added' ? 2 : 0);
    return [{
      path: node.path,
      reviewPath: node.focusPath ?? node.path,
      state: node.state,
      incoming,
      outgoing,
      addedRelationships,
      removedRelationships,
      crossDirectoryRelationships,
      inLiveCycle,
      neighborPaths,
      deterministicPriority,
      signals: signals.length ? signals : ['changed module'],
    }];
  }).sort((left, right) => (
    right.deterministicPriority - left.deterministicPriority || left.path.localeCompare(right.path)
  )).slice(0, ARCHITECTURE_ATTENTION_MAX_MODULES);
}

function questionsFor(candidates: Candidate[]): JudgmentQuestionSet {
  const questions: JudgmentQuestionSet = {};
  candidates.forEach((_candidate, index) => {
    questions[`attention_${index}`] = {
      type: 'score',
      instructions: `Evaluate exactly state.modules[${index}]. Using only that module's path and topology facts, how early should it be reviewed? This is advisory ordering, not a risk verdict.`,
      criteria: ATTENTION_CRITERIA,
    } satisfies ScoreQuestion;
    questions[`lens_${index}`] = {
      type: 'choice',
      instructions: `Evaluate exactly state.modules[${index}]. Using only that module's path and topology facts, choose the single most useful fixed review lens. Choose general when no specific lens is clearly supported.`,
      criteria: LENS_CRITERIA,
    } satisfies ChoiceQuestion<ArchitectureReviewLens>;
  });
  return questions;
}

function cacheKey(result: ArchitectureDeltaResult, context: { laneId?: string | null; repoPath: string }) {
  const evidence = result.analysisId ?? createHash('sha256').update(JSON.stringify({
    nodes: result.nodes,
    edges: result.edges,
    truncated: result.truncated,
  })).digest('hex').slice(0, 20);
  const scope = createHash('sha256').update(JSON.stringify({ nodes: result.nodes, edges: result.edges })).digest('hex').slice(0, 16);
  const source = createHash('sha256').update(JSON.stringify({
    laneId: context.laneId ?? null,
    repoPath: context.repoPath,
  })).digest('hex').slice(0, 20);
  return `${ARCHITECTURE_ATTENTION_QUESTION_VERSION}:${TYPESAFE_MODEL}:${source}:${evidence}:${scope}`;
}

function readCache(key: string) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }
  cache.delete(key);
  cache.set(key, entry);
  return { ...entry.result, cached: true };
}

function writeCache(key: string, result: ArchitectureAttentionResult) {
  cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, result });
  while (cache.size > CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value as string | undefined;
    if (!oldest) break;
    cache.delete(oldest);
  }
}

export async function rankArchitectureAttention(
  result: ArchitectureDeltaResult,
  context: { laneId?: string | null; repoPath: string },
): Promise<ArchitectureAttentionResult> {
  if (!isJudgmentRefereeEnabled()) {
    return baseResult('disabled', 'Advisory review lenses are off.', result.analysisId ?? null);
  }
  if (result.status !== 'ready' || result.nodes.length === 0) {
    return baseResult('unavailable', result.reason ?? 'No architecture evidence is available.', result.analysisId ?? null);
  }
  if (result.truncated || result.omittedPaths.length > 0 || result.resolutionWarnings.length > 0) {
    return baseResult('incomplete', 'Advisory ranking paused because the architecture evidence is incomplete.', result.analysisId ?? null);
  }
  const candidates = candidatesFor(result);
  if (candidates.length === 0) {
    return baseResult('unavailable', 'No changed modules are available to rank.', result.analysisId ?? null);
  }
  const key = cacheKey(result, context);
  const cached = readCache(key);
  if (cached) return cached;

  const state = {
    questionVersion: ARCHITECTURE_ATTENTION_QUESTION_VERSION,
    modules: candidates.map(({ deterministicPriority: _priority, signals: _signals, ...candidate }, questionIndex) => ({
      questionIndex,
      ...candidate,
    })),
  };
  const judgment = await askJudgment({
    state,
    questions: questionsFor(candidates),
    context: {
      laneId: context.laneId ?? null,
      surface: ARCHITECTURE_ATTENTION_SURFACE,
      truncated: result.nodes.filter((node) => node.state !== 'context').length > candidates.length,
      selection: {
        questionVersion: ARCHITECTURE_ATTENTION_QUESTION_VERSION,
        analysisId: result.analysisId ?? null,
        paths: candidates.map((candidate) => candidate.path),
      },
    },
  }, transportOverride ?? PRODUCTION_TRANSPORT);
  if (!judgment) {
    return baseResult('unavailable', 'Advisory ranking is unavailable; the architecture map is unchanged.', result.analysisId ?? null);
  }

  const scored = candidates.map((candidate, index) => {
    const attention = thresholdAnswer(judgment.answers[`attention_${index}`] as never) as {
      score: number;
      confidence: number;
    } | null;
    const lensAnswer = thresholdAnswer(judgment.answers[`lens_${index}`] as never) as {
      choice: ArchitectureReviewLens;
      confidence: number;
    } | null;
    return {
      candidate,
      attentionScore: attention?.score ?? null,
      attentionConfidence: attention?.confidence ?? null,
      lens: lensAnswer?.choice ?? 'general' as ArchitectureReviewLens,
      lensConfidence: lensAnswer?.confidence ?? null,
    };
  }).sort((left, right) => (
    Number(right.attentionScore !== null) - Number(left.attentionScore !== null)
    || (right.attentionScore ?? 0) - (left.attentionScore ?? 0)
    || right.candidate.deterministicPriority - left.candidate.deterministicPriority
    || left.candidate.path.localeCompare(right.candidate.path)
  ));
  const items: ArchitectureAttentionItem[] = scored.map((entry, index) => ({
    path: entry.candidate.path,
    reviewPath: entry.candidate.reviewPath,
    rank: index + 1,
    attentionScore: entry.attentionScore,
    attentionConfidence: entry.attentionConfidence,
    lens: entry.lens,
    lensConfidence: entry.lensConfidence,
    signals: entry.candidate.signals,
  }));
  const response: ArchitectureAttentionResult = {
    ok: true,
    status: 'ready',
    reason: null,
    analysisId: result.analysisId ?? null,
    items,
    model: judgment.model,
    latencyMs: judgment.latencyMs,
    receiptId: judgment.receiptId,
    cached: false,
    generatedAt: new Date().toISOString(),
  };
  writeCache(key, response);
  return response;
}
