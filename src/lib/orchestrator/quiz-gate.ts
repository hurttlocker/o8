/**
 * Quiz-gated human merge (#1491) — pure gate logic.
 *
 * The explainer carries a structured quiz; when the per-operator gate is ON and
 * the packet exceeds the changed-file threshold, the human approve button is
 * blocked until the quiz is passed. This logic lives in app code (never inside
 * the sandboxed explainer iframe) and is shared by the ReviewPane gate + tests.
 *
 * The MCP/orchestrator approve path is intentionally NOT gated — this is a
 * human-UI speed bump, not an authorization control.
 */

import type { PacketExplainerQuiz } from './types';

/** Default: gate engages only on packets touching MORE than this many files. */
export const DEFAULT_QUIZ_FILE_THRESHOLD = 5;

/** Answers keyed by question id → chosen option index. */
export type QuizAnswers = Record<string, number>;

/** Number of questions answered correctly. */
export function quizScore(quiz: PacketExplainerQuiz | null | undefined, answers: QuizAnswers): number {
  if (!quiz) return 0;
  return quiz.questions.reduce((count, question) => (
    answers[question.id] === question.answerIndex ? count + 1 : count
  ), 0);
}

/** Every question present and answered correctly. Empty/absent quiz → false. */
export function quizPassed(quiz: PacketExplainerQuiz | null | undefined, answers: QuizAnswers): boolean {
  if (!quiz || quiz.questions.length === 0) return false;
  return quizScore(quiz, answers) === quiz.questions.length;
}

export interface QuizGateParams {
  /** The per-operator O8_QUIZ_GATE setting. */
  enabled: boolean;
  /** Number of files the packet changed. */
  changedFileCount: number;
  /** Files-changed threshold; gate engages strictly ABOVE it. */
  threshold?: number;
  quiz: PacketExplainerQuiz | null | undefined;
  answers: QuizAnswers;
}

/**
 * Whether the human approve button should be BLOCKED right now.
 *
 * Fail-open by design: a disabled gate, an under-threshold packet, or a missing
 * quiz (explainer generation off/failed) never blocks — it degrades to the raw
 * diff review. Only an active gate with an unpassed quiz blocks.
 */
export function isQuizGateBlocking(params: QuizGateParams): boolean {
  const threshold = params.threshold ?? DEFAULT_QUIZ_FILE_THRESHOLD;
  if (!params.enabled) return false;
  if (params.changedFileCount <= threshold) return false;
  if (!params.quiz || params.quiz.questions.length === 0) return false;
  return !quizPassed(params.quiz, params.answers);
}
