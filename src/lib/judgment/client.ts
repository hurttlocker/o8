/**
 * Typed judgment client (#2434, tracker #2433).
 *
 * `askJudgment` posts typed questions to the route `resolveJudgmentRoute`
 * picks (#2484) with a direct fetch and returns typed answers, or null. It
 * returns null without touching the network when `judgment.provider` is off,
 * and null when no credential exists or the call fails after bounded retries.
 * It never throws. Every call that reaches the credential check writes a
 * receipt (success or failure).
 */
import { performance } from 'node:perf_hooks';

import { getOperatorDefaultsSync } from '@/lib/operator/defaults';
import { recordJudgmentReceipt } from './receipts';
import { resolveJudgmentRoute, TYPESAFE_SYSTEMONE_URL } from './route';
import {
  ABSTAIN_CONFIDENCE,
  type ChoiceAnswer,
  type JudgmentAnswers,
  type JudgmentContext,
  type JudgmentError,
  type JudgmentQuestion,
  type JudgmentQuestionSet,
  type JudgmentResult,
  type JudgmentRoute,
  type JudgmentUsage,
  type NoulAnswer,
  type ScoreAnswer,
} from './types';

export { TYPESAFE_SYSTEMONE_URL };
export const TYPESAFE_MODEL = 'jev-latest';

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_BASE_MS = 500;
const MAX_RETRY_DELAY_MS = 4_000;

export interface AskJudgmentRequest<Q extends JudgmentQuestionSet> {
  state: unknown;
  questions: Q;
  context?: JudgmentContext;
}

/** Transport knobs. Production callers pass nothing; tests point at a fixture. */
export interface AskJudgmentOptions {
  /** Replaces the provider URL on the direct route only; the managed route always uses the proxy. */
  endpoint?: string;
  timeoutMs?: number;
  maxAttempts?: number;
  retryBaseMs?: number;
}

type AttemptOutcome =
  | { ok: true; body: unknown }
  | { ok: false; retryable: boolean; error: JudgmentError; retryAfterMs: number | null };

function validateQuestions(questions: JudgmentQuestionSet): string | null {
  const entries = Object.entries(questions);
  if (entries.length === 0) return 'question set is empty';
  for (const [id, question] of entries) {
    if (typeof question?.instructions !== 'string' || !question.instructions.trim()) return `${id}: instructions missing`;
    if (question.type === 'score') {
      if (!Array.isArray(question.criteria) || question.criteria.length < 2 || question.criteria.length > 10) {
        return `${id}: score criteria must list 2 to 10 levels`;
      }
    } else if (question.type === 'choice') {
      if (!question.criteria || Array.isArray(question.criteria) || Object.keys(question.criteria).length < 2) {
        return `${id}: choice criteria must map at least 2 options to descriptions`;
      }
    } else if (question.type !== 'noul') {
      return `${id}: unknown question type`;
    }
  }
  return null;
}

const isProbability = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;

const isNumberMap = (value: unknown): value is Record<string, number> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
  && Object.values(value as Record<string, unknown>).every(isProbability);

function parseAnswer(question: JudgmentQuestion, raw: unknown): unknown | null {
  if (!raw || typeof raw !== 'object') return null;
  const answer = raw as Record<string, unknown>;
  if (question.type === 'noul') {
    return isProbability(answer.noul) ? { noul: answer.noul } : null;
  }
  if (question.type === 'choice') {
    const labels = Object.keys(question.criteria);
    if (typeof answer.choice !== 'string' || !labels.includes(answer.choice)) return null;
    if (!isNumberMap(answer.probabilities) || !isProbability(answer.confidence)) return null;
    return { choice: answer.choice, probabilities: answer.probabilities, confidence: answer.confidence, abstain: answer.confidence < ABSTAIN_CONFIDENCE };
  }
  const levels = question.criteria.length;
  if (typeof answer.score !== 'number' || !Number.isFinite(answer.score) || answer.score < 0 || answer.score > levels - 1) return null;
  if (!isNumberMap(answer.probabilities) || !isProbability(answer.confidence)) return null;
  const legend = answer.legend && typeof answer.legend === 'object' && !Array.isArray(answer.legend)
    ? answer.legend as Record<string, string>
    : Object.fromEntries(question.criteria.map((text, index) => [String(index), text]));
  return { score: answer.score, legend, probabilities: answer.probabilities, confidence: answer.confidence, abstain: answer.confidence < ABSTAIN_CONFIDENCE };
}

function parseResponse<Q extends JudgmentQuestionSet>(
  questions: Q,
  body: unknown,
): { answers: JudgmentAnswers<Q>; model: string; usage: JudgmentUsage } | null {
  if (!body || typeof body !== 'object') return null;
  const { answers, model, usage } = body as { answers?: Record<string, unknown>; model?: unknown; usage?: Record<string, unknown> };
  if (!answers || typeof answers !== 'object' || typeof model !== 'string') return null;
  const parsed: Record<string, unknown> = {};
  for (const [id, question] of Object.entries(questions)) {
    const answer = parseAnswer(question, answers[id]);
    if (!answer) return null;
    parsed[id] = answer;
  }
  const inputTokens = typeof usage?.input_tokens === 'number' ? usage.input_tokens : 0;
  const outputTokens = typeof usage?.output_tokens === 'number' ? usage.output_tokens : 0;
  return { answers: parsed as JudgmentAnswers<Q>, model, usage: { inputTokens, outputTokens } };
}

function retryAfterMs(headers: Headers): number | null {
  const ms = Number(headers.get('retry-after-ms'));
  if (headers.has('retry-after-ms') && Number.isFinite(ms) && ms >= 0) return ms;
  const seconds = Number(headers.get('retry-after'));
  if (headers.has('retry-after') && Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  return null;
}

async function providerErrorType(response: Response): Promise<string | undefined> {
  try {
    const body = await response.json() as { detail?: { error_type?: unknown }; error_type?: unknown };
    const type = body?.detail?.error_type ?? body?.error_type;
    return typeof type === 'string' ? type.slice(0, 80) : undefined;
  } catch {
    return undefined;
  }
}

async function attempt(endpoint: string, key: string, payload: string, timeoutMs: number): Promise<AttemptOutcome> {
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: payload,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    const timedOut = name === 'TimeoutError' || name === 'AbortError';
    return {
      ok: false,
      retryable: true,
      retryAfterMs: null,
      error: timedOut ? { kind: 'timeout' } : { kind: 'network', message: name || 'fetch failed' },
    };
  }
  if (response.ok) {
    try {
      return { ok: true, body: await response.json() };
    } catch {
      return { ok: false, retryable: false, retryAfterMs: null, error: { kind: 'malformed', status: response.status, message: 'response is not JSON' } };
    }
  }
  const status = response.status;
  const retryable = status === 408 || status === 429 || status >= 500;
  return {
    ok: false,
    retryable,
    retryAfterMs: retryAfterMs(response.headers),
    error: { kind: 'http', status, errorType: await providerErrorType(response) },
  };
}

const sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

function stateFlag(state: unknown, override: boolean | undefined, key: 'truncated' | 'hiddenText'): boolean {
  if (typeof override === 'boolean') return override;
  return Boolean(state && typeof state === 'object' && (state as Record<string, unknown>)[key] === true);
}

/**
 * The answer a threshold may read: null for an abstain. Noul answers carry no
 * confidence and pass through.
 */
export function thresholdAnswer<A extends NoulAnswer | ChoiceAnswer | ScoreAnswer>(answer: A | null | undefined): A | null {
  if (!answer) return null;
  return 'abstain' in answer && answer.abstain ? null : answer;
}

export async function askJudgment<Q extends JudgmentQuestionSet>(
  request: AskJudgmentRequest<Q>,
  options: AskJudgmentOptions = {},
): Promise<JudgmentResult<Q> | null> {
  try {
    const provider = getOperatorDefaultsSync().values.judgmentProvider;
    if (provider !== 'typesafe' && provider !== 'managed') return null;

    const context = request.context ?? {};
    const startedAt = performance.now();
    const base = {
      provider,
      questions: request.questions,
      truncated: stateFlag(request.state, context.truncated, 'truncated'),
      hiddenText: stateFlag(request.state, context.hiddenText, 'hiddenText'),
      packetId: context.packetId ?? null,
      laneId: context.laneId ?? null,
      approvalId: context.approvalId ?? null,
      surface: context.surface ?? null,
    };
    let route: JudgmentRoute | null = provider === 'typesafe' ? 'direct' : null;
    const fail = (error: JudgmentError, attempts: number): null => {
      recordJudgmentReceipt({
        ...base,
        route,
        model: null,
        ok: false,
        answers: null,
        inputTokens: null,
        outputTokens: null,
        latencyMs: Math.round(performance.now() - startedAt),
        attempts,
        error,
      });
      console.warn(`[judgment] call failed: ${error.kind}${error.status ? ` ${error.status}` : ''}${error.errorType ? ` ${error.errorType}` : ''}`);
      return null;
    };

    const invalid = validateQuestions(request.questions);
    if (invalid) return fail({ kind: 'invalid_questions', message: invalid }, 0);
    const resolved = resolveJudgmentRoute(provider, options.endpoint);
    if (!resolved) return fail({ kind: provider === 'typesafe' ? 'missing_key' : 'missing_credential' }, 0);
    route = resolved.route;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
    const retryBaseMs = options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
    const payload = JSON.stringify({ model: TYPESAFE_MODEL, state: request.state, questions: request.questions });

    for (let attemptNumber = 1; attemptNumber <= maxAttempts; attemptNumber += 1) {
      const outcome = await attempt(resolved.url, resolved.bearer, payload, timeoutMs);
      if (outcome.ok) {
        const parsed = parseResponse(request.questions, outcome.body);
        if (!parsed) return fail({ kind: 'malformed', message: 'answers do not match the question types' }, attemptNumber);
        const latencyMs = Math.round(performance.now() - startedAt);
        const receiptId = recordJudgmentReceipt({
          ...base,
          route,
          model: parsed.model,
          ok: true,
          answers: parsed.answers as Record<string, unknown>,
          inputTokens: parsed.usage.inputTokens,
          outputTokens: parsed.usage.outputTokens,
          latencyMs,
          attempts: attemptNumber,
          error: null,
        });
        return { ...parsed, latencyMs, attempts: attemptNumber, receiptId };
      }
      if (!outcome.retryable || attemptNumber === maxAttempts) return fail(outcome.error, attemptNumber);
      const backoff = retryBaseMs * 2 ** (attemptNumber - 1);
      await sleep(Math.min(outcome.retryAfterMs ?? backoff, MAX_RETRY_DELAY_MS));
    }
    return null;
  } catch (error) {
    console.error('[judgment] unexpected failure:', error instanceof Error ? error.name : 'error');
    return null;
  }
}
