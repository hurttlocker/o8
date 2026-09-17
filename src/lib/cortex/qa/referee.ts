/**
 * Brain classifier referee tier (#2436, tracker #2433).
 *
 * When `judgment.provider` is on, the classifier asks one typed choice
 * question (Class A lookup vs Class B reasoning) before any model tier. The
 * answer is used only when it is not an abstain and its confidence is at or
 * above {@link BRAIN_CLASS_CONFIDENCE_MIN}; otherwise (setting off, call
 * failed, abstain, low confidence) this returns null and the caller runs its
 * existing tiers unchanged. The referee returns no BM25 variants, so
 * retrieval searches the raw question.
 */

import 'server-only';

import {
  askJudgment,
  BRAIN_CLASS_QUESTIONS,
  thresholdAnswer,
  type AskJudgmentOptions,
} from '@/lib/judgment';

/**
 * Minimum referee confidence for the classification to be used. Provisional:
 * the calibration replay (#2438) recalibrates it from this install's data.
 */
export const BRAIN_CLASS_CONFIDENCE_MIN = 0.6;

export const BRAIN_CLASSIFIER_SURFACE = 'brain-classifier';

export interface RefereeClassification {
  class: 'A' | 'B';
  bm25Variants: string[];
  classifier: 'referee';
  receiptId: string | null;
}

let transportOverride: AskJudgmentOptions = {};

/** Test-only: point the referee at a local endpoint fixture. */
export function setBrainRefereeTransportForTests(options: AskJudgmentOptions): void {
  transportOverride = options;
}

export async function classifyWithReferee(question: string): Promise<RefereeClassification | null> {
  const result = await askJudgment(
    {
      state: { question },
      questions: BRAIN_CLASS_QUESTIONS,
      context: { surface: BRAIN_CLASSIFIER_SURFACE },
    },
    transportOverride,
  );
  if (!result) return null;
  const answer = thresholdAnswer(result.answers.questionClass);
  if (!answer || answer.confidence < BRAIN_CLASS_CONFIDENCE_MIN) {
    console.info(`[qa][classifier] referee below threshold (confidence ${result.answers.questionClass.confidence}); falling through`);
    return null;
  }
  return {
    class: answer.choice === 'classA' ? 'A' : 'B',
    bm25Variants: [question],
    classifier: 'referee',
    receiptId: result.receiptId,
  };
}
