/**
 * Claim versus evidence on a worker's final report (#2447, program #2481).
 * RECORD-ONLY, ADVISORY.
 *
 * When a completion writes a new `session_outcomes` row, and only when
 * `judgment.provider` is on, ask the locked report questions over three
 * pieces of state: the worker's final report (the one place worker-written
 * text is allowed, because its claims are the object of the question), the
 * changed-file list git derives from the packet diff, and the command output
 * the runtime transcript recorded. The packet title and the orchestrator's
 * brief never reach the state; any copy of the title inside the report or the
 * output is replaced before the call.
 *
 * The call runs detached after the outcome row is written, like the approval
 * referee. Every call writes a receipt; a `claim_unbacked` lane event is added
 * only when the report claims a test run the output does not show, or
 * describes files the diff does not touch. Nothing reads the event for a
 * packet's outcome, gate, or ordering.
 */
import { createHash } from 'node:crypto';

import { approvalDiffFingerprint } from '@/lib/approvals/referee';
import { getSqlite } from '@/lib/db';
import { askJudgment, type AskJudgmentOptions } from '@/lib/judgment/client';
import { REPORT_QUESTIONS } from '@/lib/judgment/questions';
import { isJudgmentRefereeEnabled } from '@/lib/judgment/route';
import { anyTextFlag, normalizeForJudgment, scanText, type TextScanFlags } from '@/lib/judgment/text-scan';
import { ABSTAIN_CONFIDENCE, type JudgmentAnswers } from '@/lib/judgment/types';
import type { Lane } from '@/lib/lane/types';
import type { RuntimeTranscriptEntry } from '@/lib/runtimes/types';

export const REPORT_CLAIM_CHECK_SURFACE = 'report-claim-check';

/** Which report claim the evidence does not back. */
export type UnbackedClaimKind = 'tests' | 'files';

const REPORT_CHAR_LIMIT = 8_000;
const OUTPUT_TAIL_CHAR_LIMIT = 6_000;
const CHANGED_FILE_LIMIT = 200;
const TITLE_MARKER = '[packet title]';

/** Payload of the `claim_unbacked` lane event. */
export interface ClaimUnbacked {
  receiptId: string | null;
  packetId: string;
  claims: UnbackedClaimKind[];
  answers: Record<keyof typeof REPORT_QUESTIONS, number>;
  verificationOutputPresent: boolean;
  reportFlags: TextScanFlags;
  outputFlags: TextScanFlags | null;
  reportTruncated: boolean;
  outputTruncated: boolean;
  changedFileCount: number;
  /** sha256 over the diff text and the sorted changed-file paths. */
  diffFingerprint: string;
  /** sha256 over the report text as sent. */
  reportFingerprint: string;
}

export interface ReportClaimCheckInput {
  lane: Pick<Lane, 'id' | 'packetId' | 'label' | 'baseBranch' | 'worktreePath' | 'repoPath'>;
  packetId: string;
  transcript: readonly RuntimeTranscriptEntry[];
}

let transportOverride: AskJudgmentOptions | undefined;
const inFlight = new Map<string, Promise<ClaimUnbacked | null>>();

/** Test-only: point the check at a local endpoint fixture. */
export function setReportClaimCheckTransportForTests(options: AskJudgmentOptions | undefined): void {
  transportOverride = options;
}

/** Resolves when the check started for this packet has settled; null when none ran or nothing was unbacked. */
export async function waitForReportClaimCheck(packetId: string): Promise<ClaimUnbacked | null> {
  return (await inFlight.get(packetId)) ?? null;
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function redactTitles(text: string, titles: readonly string[]): string {
  return titles.reduce((current, title) => current.replace(new RegExp(escapeRegExp(title), 'gi'), TITLE_MARKER), text);
}

async function packetTitles(lane: ReportClaimCheckInput['lane'], packetId: string): Promise<string[]> {
  const titles = new Set<string>();
  if (lane.label?.trim()) titles.add(lane.label.trim());
  try {
    const { readOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
    const title = readOrchestratorControlPlaneState().packets.find((packet) => packet.id === packetId)?.title?.trim();
    if (title) titles.add(title);
  } catch { /* no control plane: the lane label is the title we know */ }
  return [...titles].filter((title) => title.length >= 4).sort((a, b) => b.length - a.length);
}

/** The worker's final report: the last assistant entry with text. */
function finalReport(transcript: readonly RuntimeTranscriptEntry[]): string {
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const entry = transcript[index];
    if (entry.role === 'assistant' && entry.type !== 'compaction' && entry.text.trim()) return entry.text;
  }
  return '';
}

/** Command output the transcript recorded: tool and tool-output entries, newest last. */
function recordedOutput(transcript: readonly RuntimeTranscriptEntry[]): string {
  return transcript
    .filter((entry) => (entry.role === 'tool' || entry.role === 'system') && entry.type !== 'compaction' && entry.text.trim())
    .map((entry) => entry.text.trim())
    .join('\n');
}

export interface ReportClaimState {
  state: {
    report: { text: string; truncated: boolean };
    changedFiles: string[];
    verification: { outputPresent: boolean; tail: string | null; truncated: boolean };
  };
  reportFlags: TextScanFlags;
  outputFlags: TextScanFlags | null;
  hiddenText: boolean;
}

/** The state sent to the provider. Pure; exported for the state-shape tests. */
export function buildReportClaimState(
  transcript: readonly RuntimeTranscriptEntry[],
  changedFiles: readonly string[],
  titles: readonly string[],
): ReportClaimState {
  const rawReport = finalReport(transcript);
  const reportFlags = scanText(rawReport);
  const report = redactTitles(normalizeForJudgment(rawReport), titles);
  const rawOutput = recordedOutput(transcript);
  const outputPresent = rawOutput.length > 0;
  const outputFlags = outputPresent ? scanText(rawOutput) : null;
  const output = outputPresent ? redactTitles(normalizeForJudgment(rawOutput), titles) : '';
  return {
    state: {
      report: { text: report.slice(0, REPORT_CHAR_LIMIT), truncated: report.length > REPORT_CHAR_LIMIT },
      changedFiles: changedFiles.slice(0, CHANGED_FILE_LIMIT),
      verification: {
        outputPresent,
        tail: outputPresent ? output.slice(-OUTPUT_TAIL_CHAR_LIMIT) : null,
        truncated: output.length > OUTPUT_TAIL_CHAR_LIMIT,
      },
    },
    reportFlags,
    outputFlags,
    hiddenText: anyTextFlag(reportFlags) || Boolean(outputFlags && anyTextFlag(outputFlags)),
  };
}

/**
 * A yes/no answer counts only outside the abstain band: yes at or above
 * 1 - ABSTAIN_CONFIDENCE, no at or below ABSTAIN_CONFIDENCE. PROVISIONAL.
 */
const isYes = (p: number) => p >= 1 - ABSTAIN_CONFIDENCE;
const isNo = (p: number) => p <= ABSTAIN_CONFIDENCE;

export function unbackedClaims(answers: JudgmentAnswers<typeof REPORT_QUESTIONS>): UnbackedClaimKind[] {
  const claims: UnbackedClaimKind[] = [];
  if (isYes(answers.claimsTestsRun.noul) && isNo(answers.evidenceShowsTestsRun.noul)) claims.push('tests');
  if (isYes(answers.claimsFilesNotInDiff.noul)) claims.push('files');
  return claims;
}

async function runReportClaimCheck(input: ReportClaimCheckInput): Promise<ClaimUnbacked | null> {
  const { lane, packetId } = input;
  const { getDiffForLane } = await import('@/lib/lane/commands-approval');
  const { parseGitDiff } = await import('@/lib/worktree/diff-parser');
  const diffText = await getDiffForLane(lane);
  const paths = parseGitDiff(diffText).map((file) => file.path);
  const built = buildReportClaimState(input.transcript, paths, await packetTitles(lane, packetId));
  if (!built.state.report.text.trim()) return null;

  const result = await askJudgment({
    state: built.state,
    questions: REPORT_QUESTIONS,
    context: {
      packetId,
      laneId: lane.id,
      surface: REPORT_CLAIM_CHECK_SURFACE,
      truncated: built.state.report.truncated || built.state.verification.truncated,
      hiddenText: built.hiddenText,
    },
  }, transportOverride);
  if (!result) return null;
  const claims = unbackedClaims(result.answers);
  if (claims.length === 0) return null;

  const event: ClaimUnbacked = {
    receiptId: result.receiptId,
    packetId,
    claims,
    answers: {
      claimsTestsRun: result.answers.claimsTestsRun.noul,
      evidenceShowsTestsRun: result.answers.evidenceShowsTestsRun.noul,
      claimsFilesNotInDiff: result.answers.claimsFilesNotInDiff.noul,
      claimsVerifiedRealPath: result.answers.claimsVerifiedRealPath.noul,
    },
    verificationOutputPresent: built.state.verification.outputPresent,
    reportFlags: built.reportFlags,
    outputFlags: built.outputFlags,
    reportTruncated: built.state.report.truncated,
    outputTruncated: built.state.verification.truncated,
    changedFileCount: paths.length,
    diffFingerprint: approvalDiffFingerprint(diffText, paths),
    reportFingerprint: createHash('sha256').update(built.state.report.text).digest('hex'),
  };
  const { recordLaneEvent } = await import('@/lib/lane/events');
  recordLaneEvent(lane.id, 'claim_unbacked', 'system', { ...event });
  return event;
}

/**
 * Start the check for a completion whose outcome row was just written.
 * Returns immediately and never throws. No-op (no git, no network) when the
 * setting is off.
 */
export function startReportClaimCheck(input: ReportClaimCheckInput): void {
  try {
    if (!input.packetId.trim()) return;
    if (!isJudgmentRefereeEnabled()) return;
  } catch {
    return;
  }
  const promise = runReportClaimCheck(input)
    .catch((error) => {
      console.warn('[report-claim-check] skipped:', error instanceof Error ? error.message : 'error');
      return null;
    })
    .finally(() => {
      if (inFlight.get(input.packetId) === promise) inFlight.delete(input.packetId);
    });
  inFlight.set(input.packetId, promise);
}

/**
 * The lane's latest `claim_unbacked` event, only when it belongs to the
 * lane's latest report check: a later check with matching claims clears it.
 */
export function readLatestClaimUnbacked(laneId: string): ClaimUnbacked | null {
  const rows = getSqlite().prepare(`
    SELECT verb, payload_json FROM lane_events
    WHERE lane_id = ? AND verb IN ('judgment', 'claim_unbacked')
    ORDER BY rowid DESC LIMIT 200
  `).all(laneId) as Array<{ verb: string; payload_json: string }>;
  let claim: ClaimUnbacked | null = null;
  for (const row of rows) {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(row.payload_json) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (row.verb === 'claim_unbacked') {
      claim ??= payload as unknown as ClaimUnbacked;
    } else if (payload.surface === REPORT_CLAIM_CHECK_SURFACE) {
      return claim && claim.receiptId === payload.receiptId ? claim : null;
    }
  }
  return null;
}
