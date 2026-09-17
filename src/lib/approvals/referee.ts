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
import { createHash } from 'node:crypto';

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

interface RefereeRun {
  generation: number;
  promise: Promise<ApprovalReferee | null>;
}

const inFlight = new Map<string, RefereeRun>();
/** Latest generation started per approval; an older run never writes. Generations are unique process-wide. */
const generations = new Map<string, number>();
let lastGeneration = 0;
let optionsForTests: AskJudgmentOptions | undefined;

/** sha256 over the diff text and the sorted changed-file paths. */
export function approvalDiffFingerprint(diffText: string, paths: readonly string[]): string {
  const hash = createHash('sha256');
  hash.update(diffText);
  for (const path of [...paths].sort()) hash.update(`\0${path}`);
  return hash.digest('hex');
}

function rowDiffFingerprint(diffJson: string | null): string | null {
  if (!diffJson) return null;
  try {
    const diff = JSON.parse(diffJson) as { after?: unknown; files?: Array<{ path?: unknown }> };
    const paths = (diff.files ?? []).map((file) => String(file.path ?? ''));
    return approvalDiffFingerprint(typeof diff.after === 'string' ? diff.after : '', paths);
  } catch {
    return null;
  }
}

/** Point the referee at a local fixture endpoint. Tests only. */
export function setApprovalRefereeOptionsForTests(options: AskJudgmentOptions | undefined): void {
  optionsForTests = options;
}

/** Resolves when the referee started for this approval has settled; null when none ran. */
export async function waitForApprovalReferee(approvalId: string): Promise<ApprovalReferee | null> {
  return (await inFlight.get(approvalId)?.promise) ?? null;
}

/**
 * Write the referee into the approval's metadata bag without touching
 * `updated_at`. Skipped when a newer run started for the approval, or when the
 * row's diff is no longer the diff the referee read (a reused approval).
 */
function storeApprovalReferee(approvalId: string, referee: ApprovalReferee, generation: number): boolean {
  if (generations.get(approvalId) !== generation) {
    console.info(`[approval-referee] skipped a superseded referee write for ${approvalId}`);
    return false;
  }
  const sqlite = getSqlite();
  const row = sqlite.prepare('SELECT metadata_json, diff_json FROM approvals WHERE id = ?').get(approvalId) as { metadata_json: string | null; diff_json: string | null } | undefined;
  if (!row) return false;
  if (rowDiffFingerprint(row.diff_json) !== referee.diffFingerprint) {
    console.info(`[approval-referee] skipped a referee write for ${approvalId}: the approval diff changed`);
    return false;
  }
  // `updated_at` is the resolve compare-and-swap token; bumping it would turn
  // an operator's in-flight decision into a 409, which is a decision-path change.
  const { metadata } = parseApprovalMetadataJson(row.metadata_json);
  sqlite.prepare('UPDATE approvals SET metadata_json = ? WHERE id = ?')
    .run(serializeApprovalMetadata(metadata, referee), approvalId);
  return true;
}

async function runApprovalReferee(input: ApprovalRefereeInput, generation: number): Promise<ApprovalReferee | null> {
  const diffFingerprint = approvalDiffFingerprint(input.diffText, input.files.map((file) => file.path));
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
    diffFingerprint,
    askedAt: Date.now(),
  };
  return storeApprovalReferee(input.approvalId, referee, generation) ? referee : null;
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
  lastGeneration += 1;
  const generation = lastGeneration;
  generations.set(input.approvalId, generation);
  const promise = runApprovalReferee(input, generation)
    .catch((error) => {
      console.warn('[approval-referee] referee skipped:', error instanceof Error ? error.message : 'error');
      return null;
    })
    .finally(() => {
      if (inFlight.get(input.approvalId)?.generation !== generation) return;
      inFlight.delete(input.approvalId);
      generations.delete(input.approvalId);
    });
  inFlight.set(input.approvalId, { generation, promise });
}
