/**
 * Referee row for approval cards (#2435, tracker #2433). ADVISORY ONLY.
 *
 * After an approval that carries a diff is created, and only when
 * `judgment.provider` is on, ask the locked diff questions and store the
 * card-visible answers on the approval. The approval is created first and the
 * call runs detached, so creation never waits on the referee. Nothing in the
 * decision path reads the result: no threshold, no auto-approve, no ordering.
 * A null answer leaves the approval exactly as it was created.
 */
import { getSqlite } from '@/lib/db';
import { askJudgment, type AskJudgmentOptions } from '@/lib/judgment/client';
import { buildDiffState, type DiffStateFileInput } from '@/lib/judgment/diff-state';
import { DIFF_QUESTIONS } from '@/lib/judgment/questions';
import { getOperatorDefaultsSync } from '@/lib/operator/defaults';
import type { ApprovalReferee } from '@/lib/approvals/types';
import { parseApprovalMetadataJson, serializeApprovalMetadata } from './referee-metadata';

export interface ApprovalRefereeInput {
  approvalId: string;
  packetId?: string | null;
  laneId?: string | null;
  files: DiffStateFileInput[];
  diffText: string;
}

const inFlight = new Map<string, Promise<ApprovalReferee | null>>();
let optionsForTests: AskJudgmentOptions | undefined;

/** Point the referee at a local fixture endpoint. Tests only. */
export function setApprovalRefereeOptionsForTests(options: AskJudgmentOptions | undefined): void {
  optionsForTests = options;
}

/** Resolves when the referee started for this approval has settled; null when none ran. */
export async function waitForApprovalReferee(approvalId: string): Promise<ApprovalReferee | null> {
  return (await inFlight.get(approvalId)) ?? null;
}

/** Write the referee into the approval's metadata bag without touching `updated_at`. */
function storeApprovalReferee(approvalId: string, referee: ApprovalReferee): boolean {
  const sqlite = getSqlite();
  const row = sqlite.prepare('SELECT metadata_json FROM approvals WHERE id = ?').get(approvalId) as { metadata_json: string | null } | undefined;
  if (!row) return false;
  // `updated_at` is the resolve compare-and-swap token; bumping it would turn
  // an operator's in-flight decision into a 409, which is a decision-path change.
  const { metadata } = parseApprovalMetadataJson(row.metadata_json);
  sqlite.prepare('UPDATE approvals SET metadata_json = ? WHERE id = ?')
    .run(serializeApprovalMetadata(metadata, referee), approvalId);
  return true;
}

async function runApprovalReferee(input: ApprovalRefereeInput): Promise<ApprovalReferee | null> {
  const built = buildDiffState(input.files, input.diffText);
  const result = await askJudgment({
    state: built.state,
    questions: DIFF_QUESTIONS,
    context: {
      packetId: input.packetId ?? null,
      laneId: input.laneId ?? null,
      approvalId: input.approvalId,
      surface: 'approval-card',
      truncated: built.truncated,
      hiddenText: built.hiddenText,
    },
  }, optionsForTests);
  if (!result) return null;
  const { answers } = result;
  // Record-only answers (scope creep, tests reach a real entry point, the
  // recommended action) stay on the receipt and never reach the approval.
  const referee: ApprovalReferee = {
    receiptId: result.receiptId,
    model: result.model,
    answers: {
      docsOnly: answers.docsOnly,
      addsTests: answers.addsTests,
      touchesMiddlewareOrAuth: answers.touchesMiddlewareOrAuth,
      containsPlaceholderOrMockData: answers.containsPlaceholderOrMockData,
      risk: answers.risk,
    },
    truncated: built.truncated,
    hiddenText: built.hiddenText,
    filesAddedFromDiff: built.filesAddedFromDiff,
    pathTouchesMiddlewareOrAuth: built.pathTouchesMiddlewareOrAuth,
    askedAt: Date.now(),
  };
  return storeApprovalReferee(input.approvalId, referee) ? referee : null;
}

/**
 * Start the referee for a freshly created approval. Returns immediately; the
 * call is bounded by the judgment client's timeout and retry budget. No-op
 * (and no diff work) when the setting is off or there is no diff.
 */
export function startApprovalReferee(input: ApprovalRefereeInput): void {
  try {
    if (getOperatorDefaultsSync().values.judgmentProvider === 'off') return;
    if (!input.diffText.trim() && input.files.length === 0) return;
  } catch {
    return;
  }
  const run = runApprovalReferee(input)
    .catch((error) => {
      console.warn('[approval-referee] referee skipped:', error instanceof Error ? error.message : 'error');
      return null;
    })
    .finally(() => {
      if (inFlight.get(input.approvalId) === run) inFlight.delete(input.approvalId);
    });
  inFlight.set(input.approvalId, run);
}
