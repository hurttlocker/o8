/**
 * Sonnet-as-judge prompt template for the Cortex Q&A eval harness.
 *
 * Epic #915 sub-issue 3 wave A. The real Sonnet call wires up in Wave B alongside
 * the live askCortex() implementation. For Wave A we ship the prompt template and
 * a typed result shape so the runner can stub the call and the contradiction
 * detector (Wave B) drops in without a refactor.
 *
 * The judge scores three dimensions on the rubric agreed in the locked architecture
 * comment on epic #915:
 *
 *   - factual_accuracy: 0.0-1.0 — does the actual answer state the expected facts?
 *   - citation_correctness: 0.0-1.0 — does the actual include the expected citations?
 *   - hallucination_count: integer — facts in actual NOT supported by citations
 *
 * The prompt deliberately tells the judge to ignore minor phrasing differences
 * and reward partial overlap on factual_accuracy — we want a regression detector,
 * not a brittle string-equality check.
 */

export interface ExpectedCitation {
  kind: 'outcome' | 'directive' | 'pr' | 'issue' | 'project' | 'project_repo';
  rowId: string;
}

export interface JudgeInput {
  question: string;
  expectedAnswer: string | null;
  expectedFacts: string[];
  expectedCitations: ExpectedCitation[];
  actualAnswer: string;
  actualCitations: ExpectedCitation[];
}

export interface JudgeResult {
  factual_accuracy: number;
  citation_correctness: number;
  hallucination_count: number;
  notes: string;
}

export const JUDGE_PROMPT = `You are evaluating an AI's answer for factual accuracy, citation correctness, and hallucinations.

Question:
{question}

Expected answer (may be null for known-gap cases — score factual_accuracy on whether the AI correctly states the data is missing):
{expectedAnswer}

Expected facts (the AI's answer should cover these — partial overlap counts):
{expectedFacts}

Expected citations (typed row references the AI should cite):
{expectedCitations}

Actual answer:
{actualAnswer}

Actual citations:
{actualCitations}

Rubric:
- factual_accuracy: 0.0-1.0 — does the actual answer state the expected facts? Reward partial overlap. Ignore minor phrasing differences. If expectedAnswer is null (known gap), reward stating the data is missing rather than inventing values.
- citation_correctness: 0.0-1.0 — does actual include the expected citations? Same {kind, rowId} pair counts as a hit. Reward partial overlap.
- hallucination_count: integer — count facts in the actual answer that are NOT supported by any citation in actualCitations. Inventing GitHub usernames, commit SHAs, or row IDs counts. Stating a known-correct general fact (e.g., 'iOS Safari' as a browser engine) does not.

Return strictly the following JSON, no prose:
{
  "factual_accuracy": <number between 0 and 1>,
  "citation_correctness": <number between 0 and 1>,
  "hallucination_count": <non-negative integer>,
  "notes": "<one or two sentences explaining the score>"
}
`;

/**
 * Render the judge prompt by substituting placeholder slots with stringified
 * inputs. Pure string templating — the model call lives elsewhere.
 */
export function renderJudgePrompt(input: JudgeInput): string {
  const expectedAnswerText =
    input.expectedAnswer === null
      ? '(null — known-gap case; score on whether the AI correctly states the data is missing)'
      : input.expectedAnswer;
  const expectedFactsText =
    input.expectedFacts.length === 0
      ? '(none specified)'
      : input.expectedFacts.map((f, i) => `  ${i + 1}. ${f}`).join('\n');
  const expectedCitationsText =
    input.expectedCitations.length === 0
      ? '(none specified)'
      : input.expectedCitations
          .map((c, i) => `  ${i + 1}. {kind: ${c.kind}, rowId: ${c.rowId}}`)
          .join('\n');
  const actualCitationsText =
    input.actualCitations.length === 0
      ? '(none returned)'
      : input.actualCitations
          .map((c, i) => `  ${i + 1}. {kind: ${c.kind}, rowId: ${c.rowId}}`)
          .join('\n');

  return JUDGE_PROMPT.replace('{question}', input.question)
    .replace('{expectedAnswer}', expectedAnswerText)
    .replace('{expectedFacts}', expectedFactsText)
    .replace('{expectedCitations}', expectedCitationsText)
    .replace('{actualAnswer}', input.actualAnswer)
    .replace('{actualCitations}', actualCitationsText);
}

/**
 * Stub judge call — Wave A only. Wave B replaces this with a real Anthropic
 * Sonnet call routed through the existing /api/v2/proxy/llm path.
 *
 * The stub is deliberately deterministic and conservative so a runner against
 * the unimplemented askCortex() doesn't produce noisy false-passes:
 *   - factual_accuracy: 0
 *   - citation_correctness: 0
 *   - hallucination_count: 0
 *   - notes: "(stub) judge not wired"
 */
export async function judgeStub(_input: JudgeInput): Promise<JudgeResult> {
  return {
    factual_accuracy: 0,
    citation_correctness: 0,
    hallucination_count: 0,
    notes: '(stub) judge not wired — askCortex + Sonnet call land in Wave B',
  };
}
