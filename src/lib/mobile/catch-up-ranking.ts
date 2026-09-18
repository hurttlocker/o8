/**
 * Catch-up ranking for the phone briefing (#2444, program #2481). ADVISORY ORDER.
 *
 * When `judgment.provider` is on, the phone Symon mint asks one locked
 * question per briefing item ("how much does this change need the operator's
 * attention?") in a single call, and the briefing sorts each section by the
 * answers before its item limit applies. There is no threshold and no gate:
 * the score only moves lines, ties keep event order, and any failure (setting
 * off, missing key, timeout, HTTP error, a missing answer) keeps event order
 * for the whole briefing. `askJudgment` writes the receipt either way.
 *
 * The state carries o8-computed facts only: kind, lane state, age, gate
 * result, the stored merge-card referee facts (#2435), whether the operator
 * gates the item, and a repo index. No title, summary, commit message, repo
 * name, or worker-written text; question ids are hashes of the item id.
 */
import { createHash } from 'node:crypto';

import type { MobileApprovalCard } from '@/lib/approvals/types';
import { askJudgment, type AskJudgmentOptions } from '@/lib/judgment/client';
import { catchUpQuestions } from '@/lib/judgment/questions';
import { isJudgmentRefereeEnabled } from '@/lib/judgment/route';
import {
  briefingApprovalId,
  briefingLaneId,
  briefingNeedsYouId,
  phoneBriefingSections,
  type PhoneBriefingInput,
} from '@/lib/mobile/symon-briefing';
import type { MobileFleetSession, MobileInboxItem } from '@/lib/mobile/types';

export const CATCH_UP_RANKING_SURFACE = 'catch-up-ranking';

/** Items asked in one call; past it the rest keep event order and the call is marked truncated. */
export const CATCH_UP_MAX_ITEMS = 120;
/**
 * One attempt, never longer than the caller's remaining budget: the operator is
 * holding the phone waiting on the voice mint, typical referee latency is
 * around 260 ms, and event order is a perfectly good answer when the referee
 * is slower than that. 1.2 s is the ceiling when no budget is passed.
 */
const PRODUCTION_TRANSPORT: AskJudgmentOptions = { timeoutMs: 1_200, maxAttempts: 1 };

export type CatchUpItemKind = 'approval_created' | 'lane_state_change' | 'failure' | 'merge' | 'watch_fired';

/** o8-computed facts about one briefing item. Nothing here is written by a worker. */
export interface CatchUpItem {
  id: string;
  kind: CatchUpItemKind;
  laneState: string | null;
  ageMs: number | null;
  gatePassed: boolean | null;
  referee: { docsOnly: number; risk: number } | null;
  operatorGated: boolean;
  /** Index into the sorted distinct repo list of this briefing; never the name. */
  repoIndex: number | null;
}

export interface CatchUpRanking {
  /** Item ids, ranked first, then any unscored items in event order. */
  order: string[];
  /** Attention score per item id; empty when the call failed or never ran. */
  scores: Record<string, number>;
  receiptId: string | null;
  truncated: boolean;
}

let transportOverride: AskJudgmentOptions | undefined;

/** Test-only: point the ranking at a local endpoint fixture. */
export function setCatchUpRankingTransportForTests(options: AskJudgmentOptions | undefined): void {
  transportOverride = options;
}

/** The transport, its timeout cut to the caller's remaining budget. */
function transportWithin(budgetMs: number | undefined): AskJudgmentOptions {
  const transport = transportOverride ?? PRODUCTION_TRANSPORT;
  if (budgetMs === undefined) return transport;
  return { ...transport, timeoutMs: Math.max(1, Math.min(transport.timeoutMs ?? budgetMs, Math.floor(budgetMs))) };
}

/** The question id an item is asked under: a hash, so no item text reaches the provider. */
export function catchUpQuestionId(itemId: string): string {
  return `c_${createHash('sha256').update(itemId).digest('hex').slice(0, 12)}`;
}

/**
 * Order the items by attention score, descending, ties in event order. One
 * call for all items. Never throws: any failure returns the input order with
 * no scores, and `askJudgment` has already recorded the failure receipt.
 */
export async function rankCatchUpItems(items: readonly CatchUpItem[], budgetMs?: number): Promise<CatchUpRanking> {
  const eventOrder: CatchUpRanking = {
    order: items.map((item) => item.id),
    scores: {},
    receiptId: null,
    truncated: items.length > CATCH_UP_MAX_ITEMS,
  };
  try {
    if (items.length === 0 || !isJudgmentRefereeEnabled()) return eventOrder;
    const asked = items.slice(0, CATCH_UP_MAX_ITEMS);
    // The raw item id stays here: the provider sees only its hash, and
    // `asked[index]` maps each state item back to the id it was asked about.
    const stateItems = asked.map(({ id, ...facts }) => ({ question: catchUpQuestionId(id), ...facts }));
    const result = await askJudgment({
      state: { items: stateItems },
      questions: catchUpQuestions(stateItems.map((item) => item.question)),
      context: {
        surface: CATCH_UP_RANKING_SURFACE,
        truncated: eventOrder.truncated,
        // Safe to carry the raw id here (#2511): selection is written only to
        // the local receipt's `selection_json`; the request payload is
        // `{ model, state, questions }`. It lets the replay tie each hashed
        // answer back to its item.
        selection: { items: stateItems.map((item, index) => ({ question: item.question, itemId: asked[index].id, kind: item.kind })) },
      },
    }, transportWithin(budgetMs));
    if (!result) return eventOrder;

    const scores: Record<string, number> = {};
    for (const [index, item] of stateItems.entries()) {
      const score = result.answers[item.question]?.noul;
      if (typeof score !== 'number') return eventOrder;
      scores[asked[index].id] = score;
    }
    const ranked = asked
      .map((item, index) => ({ id: item.id, index, score: scores[item.id] }))
      .sort((left, right) => (right.score - left.score) || (left.index - right.index))
      .map((entry) => entry.id);
    return {
      order: [...ranked, ...items.slice(CATCH_UP_MAX_ITEMS).map((item) => item.id)],
      scores,
      receiptId: result.receiptId,
      truncated: eventOrder.truncated,
    };
  } catch (error) {
    console.warn(`[${CATCH_UP_RANKING_SURFACE}] skipped:`, error instanceof Error ? error.message : 'error');
    return eventOrder;
  }
}

function ageFrom(now: number, stamp: number | string | null | undefined): number | null {
  const at = typeof stamp === 'string' ? Date.parse(stamp) : stamp;
  return typeof at === 'number' && Number.isFinite(at) && at > 0 ? Math.max(0, now - at) : null;
}

/**
 * The briefing's items as catch-up facts, in the briefing's event order
 * (section by section, snapshot order within). Reads the approval store and the
 * lane registry for the facts the snapshot does not carry; both load only here,
 * so a mint with the setting off never touches them.
 */
export async function briefingCatchUpItems(input: PhoneBriefingInput, now: number = Date.now()): Promise<CatchUpItem[]> {
  const sections = phoneBriefingSections(input);
  if (!sections) return [];
  const { getApproval } = await import('@/lib/approvals/store');
  const { findLaneBySession } = await import('@/lib/lane/registry');
  const repos = [...new Set([
    ...sections.approvals.map((approval) => approval.repoPath ?? approval.repo),
    ...[...sections.running, ...sections.blocked, ...sections.merged].map((session) => session.repoPath || session.repo),
  ].filter((repo): repo is string => Boolean(repo)))].sort();
  const repoIndex = (repo: string | null | undefined) => {
    const index = repo ? repos.indexOf(repo) : -1;
    return index === -1 ? null : index;
  };

  const approvalItem = (approval: MobileApprovalCard): CatchUpItem => {
    const record = getApproval(approval.approvalId ?? approval.id);
    const referee = record?.referee;
    return {
      id: briefingApprovalId(approval),
      kind: 'approval_created',
      laneState: approval.sessionKey ? findLaneBySession(approval.sessionKey)?.status ?? null : null,
      ageMs: ageFrom(now, approval.createdAt),
      gatePassed: approval.gateResult ? approval.gateResult.passed : null,
      referee: referee ? { docsOnly: referee.answers.docsOnly.noul, risk: referee.answers.risk.score } : null,
      operatorGated: true,
      repoIndex: repoIndex(approval.repoPath ?? approval.repo),
    };
  };
  const laneItem = (session: MobileFleetSession): CatchUpItem => ({
    id: briefingLaneId(session),
    kind: session.status === 'merged' ? 'merge' : session.status === 'failed' ? 'failure' : 'lane_state_change',
    laneState: session.status,
    ageMs: ageFrom(now, session.lastActivityAt ?? session.lastEventAt),
    gatePassed: null,
    referee: null,
    operatorGated: session.reviewAuthority === 'approval_gate' || Boolean(session.approvalId),
    repoIndex: repoIndex(session.repoPath || session.repo),
  });
  const needsYouItem = (item: MobileInboxItem): CatchUpItem => ({
    id: briefingNeedsYouId(item),
    kind: item.kind === 'run_watch' ? 'watch_fired' : item.severity === 'critical' ? 'failure' : 'lane_state_change',
    laneState: item.sessionKey ? findLaneBySession(item.sessionKey)?.status ?? null : null,
    ageMs: null,
    gatePassed: null,
    referee: null,
    operatorGated: item.kind === 'review',
    repoIndex: null,
  });

  return [
    ...sections.approvals.map(approvalItem),
    ...sections.running.map(laneItem),
    ...sections.blocked.map(laneItem),
    ...sections.needsYou.map(needsYouItem),
    ...sections.merged.map(laneItem),
  ];
}

/**
 * Rank a briefing. Null, with no store reads and no request, when the setting
 * is off or there is nothing to rank; the caller then builds the event-order
 * briefing exactly as before.
 */
export async function rankPhoneBriefing(input: PhoneBriefingInput, budgetMs?: number): Promise<CatchUpRanking | null> {
  try {
    if (!input.snapshot || !isJudgmentRefereeEnabled()) return null;
    const items = await briefingCatchUpItems(input);
    if (items.length === 0) return null;
    return await rankCatchUpItems(items, budgetMs);
  } catch (error) {
    console.warn(`[${CATCH_UP_RANKING_SURFACE}] skipped:`, error instanceof Error ? error.message : 'error');
    return null;
  }
}
