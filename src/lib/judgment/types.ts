/**
 * Typed judgment questions and answers (#2434).
 *
 * A question is asked by id; the provider answers each id with the matching
 * answer shape. Only per-question answers feed decisions: callers never act
 * on a "recommended action" answer on its own (tracker #2433 design rules).
 */

/** Yes/no question. The answer is the probability of yes, 0..1. */
export interface NoulQuestion {
  type: 'noul';
  instructions: string;
  criteria?: { true?: string; false?: string };
}

/** Pick one label. `criteria` maps each label to its description. */
export interface ChoiceQuestion<L extends string = string> {
  type: 'choice';
  instructions: string;
  criteria: Record<L, string>;
}

/** Ordered rubric. `criteria[i]` describes score i; 2..10 levels. */
export interface ScoreQuestion {
  type: 'score';
  instructions: string;
  criteria: readonly string[];
}

export type JudgmentQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion;
export type JudgmentQuestionSet = Record<string, JudgmentQuestion>;

export interface NoulAnswer {
  noul: number;
}

/**
 * Reported confidence below this is an abstain. Rerun agreement was 1.000 at
 * 0.4 and up (n=314) and 0.733 below (n=60); above it, do not weight by it.
 */
export const ABSTAIN_CONFIDENCE = 0.4;

export interface ChoiceAnswer<L extends string = string> {
  choice: L;
  probabilities: Record<L, number>;
  confidence: number;
  /** Confidence under {@link ABSTAIN_CONFIDENCE}: treat as no answer for any threshold. */
  abstain: boolean;
}

export interface ScoreAnswer {
  /** Expected score on the 0..(levels-1) scale. */
  score: number;
  /** Score index (as a string key) to its rubric description. */
  legend: Record<string, string>;
  probabilities: Record<string, number>;
  confidence: number;
  /** Confidence under {@link ABSTAIN_CONFIDENCE}: treat as no answer for any threshold. */
  abstain: boolean;
}

export type AnswerFor<Q> =
  Q extends NoulQuestion ? NoulAnswer
    : Q extends ChoiceQuestion<infer L> ? ChoiceAnswer<L>
      : Q extends ScoreQuestion ? ScoreAnswer
        : never;

export type JudgmentAnswers<Q extends JudgmentQuestionSet> = { [K in keyof Q]: AnswerFor<Q[K]> };

/** Where the call came from. Recorded on the receipt; `laneId` picks the store. */
export interface JudgmentContext {
  packetId?: string | null;
  laneId?: string | null;
  approvalId?: string | null;
  /** Caller surface, e.g. `approval-card`, `brain-classifier`. */
  surface?: string | null;
  /** Set when the state was cut to fit the token budget. */
  truncated?: boolean;
  /** Set when the scan found zero-width, bidi, mixed-script, or mixed line-ending text. */
  hiddenText?: boolean;
}

export interface JudgmentUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface JudgmentResult<Q extends JudgmentQuestionSet> {
  answers: JudgmentAnswers<Q>;
  model: string;
  usage: JudgmentUsage;
  latencyMs: number;
  attempts: number;
  receiptId: string | null;
}

export interface JudgmentError {
  /** `http` (non-2xx), `timeout`, `network`, `malformed`, `missing_key`, `invalid_questions`. */
  kind: string;
  status?: number;
  /** Provider error type from the body, e.g. `max_tokens_exceeded`. */
  errorType?: string;
  message?: string;
}

export interface JudgmentReceipt {
  id: string;
  provider: string;
  model: string | null;
  ok: boolean;
  questions: JudgmentQuestionSet;
  answers: Record<string, unknown> | null;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number;
  attempts: number;
  truncated: boolean;
  hiddenText: boolean;
  error: JudgmentError | null;
  packetId: string | null;
  laneId: string | null;
  approvalId: string | null;
  surface: string | null;
  createdAt: string;
}
