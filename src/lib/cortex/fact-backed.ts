import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import type {
  ContextInjection,
  CortexContextResponsePayload,
  CortexRecallItemPayload,
  CortexRecallResponsePayload,
  RecallDiagnostics,
  RecallEvidence,
  RecallFeedbackAction,
  RecallFeedbackResult,
  RecallItem,
} from './types';

const DEFAULT_CORTEX_BINARY = process.env.CORTEX_BINARY || path.join(os.homedir(), 'bin', 'cortex');
const DEFAULT_TIMEOUT_MS = 30_000;

export interface RecallCommandOptions {
  query: string;
  limit?: number;
  project?: string;
  agent?: string;
  channel?: string;
  sessionKey?: string;
  boostAgent?: string;
  boostChannel?: string;
  boostSessionKey?: string;
  after?: string;
  before?: string;
  includeSuperseded?: boolean;
  maxItems?: number;
  maxTokens?: number;
  binaryPath?: string;
  timeoutMs?: number;
}

export interface FeedbackCommandOptions {
  factId: number;
  action: RecallFeedbackAction;
  relatedFactId?: number;
  query?: string;
  reason?: string;
  binaryPath?: string;
  timeoutMs?: number;
}

function pushStringFlag(args: string[], flag: string, value?: string) {
  const normalized = value?.trim();
  if (normalized) {
    args.push(flag, normalized);
  }
}

function pushNumberFlag(args: string[], flag: string, value?: number) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    args.push(flag, String(value));
  }
}

export function buildRecallArgs(options: RecallCommandOptions): string[] {
  const query = options.query.trim();
  if (!query) {
    throw new Error('query is required');
  }

  const args = ['recall', query];
  pushNumberFlag(args, '--limit', options.limit);
  pushStringFlag(args, '--project', options.project);
  pushStringFlag(args, '--agent', options.agent);
  pushStringFlag(args, '--channel', options.channel);
  pushStringFlag(args, '--session-key', options.sessionKey);
  pushStringFlag(args, '--boost-agent', options.boostAgent);
  pushStringFlag(args, '--boost-channel', options.boostChannel);
  pushStringFlag(args, '--boost-session-key', options.boostSessionKey);
  pushStringFlag(args, '--after', options.after);
  pushStringFlag(args, '--before', options.before);
  if (options.includeSuperseded) {
    args.push('--include-superseded');
  }
  args.push('--json');
  return args;
}

export function buildContextArgs(options: RecallCommandOptions): string[] {
  const args = buildRecallArgs(options);
  args[0] = 'context';
  pushNumberFlag(args, '--max-items', options.maxItems);
  pushNumberFlag(args, '--max-tokens', options.maxTokens);
  return args;
}

export function buildFeedbackArgs(options: FeedbackCommandOptions): string[] {
  if (!Number.isFinite(options.factId) || options.factId <= 0) {
    throw new Error('factId must be a positive number');
  }

  const args = ['feedback', String(options.factId), options.action];
  if (options.action === 'supersede') {
    if (!Number.isFinite(options.relatedFactId) || (options.relatedFactId ?? 0) <= 0) {
      throw new Error('relatedFactId is required for supersede feedback');
    }
    args.push('--by', String(options.relatedFactId));
  }
  pushStringFlag(args, '--query', options.query);
  pushStringFlag(args, '--reason', options.reason);
  args.push('--json');
  return args;
}

function parseCommandError(result: ReturnType<typeof spawnSync>, commandLabel: string, binaryPath: string) {
  if (result.error) {
    throw new Error(`${commandLabel} failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = `${result.stdout || ''}\n${result.stderr || ''}`.trim();
    if (detail.includes(`Unknown command: ${argsFromCommandLabel(commandLabel)}`)) {
      throw new Error(
        `Installed Cortex binary at ${binaryPath} is too old for ${commandLabel}. ` +
        `Upgrade to a build that exposes \`${argsFromCommandLabel(commandLabel)}\` and retry.`,
      );
    }
    throw new Error(detail || `${commandLabel} failed with exit code ${result.status ?? 'unknown'}`);
  }
}

function argsFromCommandLabel(commandLabel: string) {
  const parts = commandLabel.trim().split(/\s+/);
  return parts[1] || parts[0] || "cortex";
}

function runCortexJson<T>(args: string[], options?: { binaryPath?: string; timeoutMs?: number }): T {
  const binaryPath = options?.binaryPath || DEFAULT_CORTEX_BINARY;
  const result = spawnSync(binaryPath, args, {
    encoding: 'utf-8',
    timeout: options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    env: { ...process.env, NO_COLOR: '1' },
  });
  parseCommandError(result, `cortex ${args[0]}`, binaryPath);
  const stdout = `${result.stdout || ''}`.trim();
  if (!stdout) {
    throw new Error(`cortex ${args[0]} returned empty output`);
  }
  try {
    return JSON.parse(stdout) as T;
  } catch (error) {
    throw new Error(
      `cortex ${args[0]} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function mapRecallDiagnostics(
  diagnostics?: CortexRecallResponsePayload['diagnostics'],
): RecallDiagnostics {
  return {
    searched: typeof diagnostics?.searched === 'number' ? diagnostics.searched : 0,
    factBacked: typeof diagnostics?.fact_backed === 'number' ? diagnostics.fact_backed : 0,
    journalOnly: typeof diagnostics?.journal_only === 'number' ? diagnostics.journal_only : 0,
    droppedByPolicy: typeof diagnostics?.dropped_by_policy === 'number' ? diagnostics.dropped_by_policy : 0,
  };
}

export function mapRecallEvidence(
  evidence?: CortexRecallItemPayload['evidence'],
): RecallEvidence[] {
  if (!Array.isArray(evidence)) return [];
  return evidence
    .filter((item) => item && typeof item === 'object')
    .map((item) => ({
      memoryId: typeof item.memory_id === 'number' ? item.memory_id : 0,
      sourceFile: typeof item.source_file === 'string' ? item.source_file : '',
      sourceLine: typeof item.source_line === 'number' ? item.source_line : undefined,
      quote: typeof item.quote === 'string' ? item.quote : undefined,
    }))
    .filter((item) => item.memoryId > 0 || item.sourceFile || item.quote);
}

export function mapRecallItem(item: CortexRecallItemPayload): RecallItem {
  const id = typeof item?.id === 'number' ? item.id : 0;
  const factId = typeof item?.fact_id === 'number' ? item.fact_id : id;
  const memoryId = typeof item?.memory_id === 'number' ? item.memory_id : 0;

  return {
    id,
    factId,
    memoryId,
    text: typeof item?.text === 'string' ? item.text : '',
    factType: typeof item?.fact_type === 'string' ? item.fact_type : 'state',
    factState: typeof item?.fact_state === 'string' ? item.fact_state : 'active',
    confidence: typeof item?.confidence === 'number' ? item.confidence : 0,
    relevance: typeof item?.relevance === 'number' ? item.relevance : 0,
    qualityScore: typeof item?.quality_score === 'number' ? item.quality_score : 0,
    sourceTier: typeof item?.source_tier === 'string' ? item.source_tier : 'journal',
    memoryKind: typeof item?.memory_kind === 'string' ? item.memory_kind : 'journal',
    retrievalVisibility: typeof item?.retrieval_visibility === 'string'
      ? item.retrieval_visibility
      : 'evidence_only',
    evidenceCount: typeof item?.evidence_count === 'number'
      ? item.evidence_count
      : Array.isArray(item?.evidence) ? item.evidence.length : 0,
    evidence: mapRecallEvidence(item?.evidence),
    reasons: Array.isArray(item?.reasons)
      ? item.reasons.filter((reason: unknown): reason is string => typeof reason === 'string')
      : [],
    promptEligible: item?.prompt_eligible === true,
  };
}

export function mapRecallResponse(payload: CortexRecallResponsePayload) {
  const items = Array.isArray(payload.items) ? payload.items.map(mapRecallItem) : [];
  return {
    items,
    diagnostics: mapRecallDiagnostics(payload.diagnostics),
  };
}

export function mapContextResponse(payload: CortexContextResponsePayload): ContextInjection {
  const mapped = mapRecallResponse(payload);
  const structuredBlock = typeof payload.structured_block === 'string' ? payload.structured_block : '';
  return {
    facts: mapped.items,
    contextBlock: structuredBlock,
    structuredBlock,
    factCount: mapped.items.length,
    tokenCount: typeof payload.token_count === 'number' ? payload.token_count : 0,
    diagnostics: mapped.diagnostics,
  };
}

export function runCortexRecall(options: RecallCommandOptions) {
  const raw = runCortexJson<CortexRecallResponsePayload>(buildRecallArgs(options), options);
  return mapRecallResponse(raw);
}

export function runCortexContext(options: RecallCommandOptions) {
  const raw = runCortexJson<CortexContextResponsePayload>(buildContextArgs(options), options);
  return mapContextResponse(raw);
}

export function runCortexFeedback(options: FeedbackCommandOptions): RecallFeedbackResult {
  const raw = runCortexJson<Record<string, unknown>>(buildFeedbackArgs(options), options);
  return {
    factId: typeof raw.fact_id === 'number' ? raw.fact_id : options.factId,
    action: typeof raw.action === 'string' ? raw.action as RecallFeedbackAction : options.action,
    status: typeof raw.status === 'string' ? raw.status : 'ok',
    relatedFactId: typeof raw.related_fact_id === 'number' ? raw.related_fact_id : undefined,
    query: typeof raw.query === 'string' ? raw.query : undefined,
    reason: typeof raw.reason === 'string' ? raw.reason : undefined,
  };
}
