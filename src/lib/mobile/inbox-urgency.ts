/**
 * Referee-ordered mobile inbox (#2440, tracker #2445). ADVISORY ORDERING ONLY.
 *
 * The desktop asks the referee one locked urgency question per inbox item and
 * ships the phone the resulting order plus each item's score. The phone never
 * calls the referee and no key leaves the desktop. Nothing decides anything
 * here: the answers move rows in a list and are read by no threshold, gate, or
 * auto-decision.
 *
 * The inbox response never waits on the provider. Scores are read from a cache
 * keyed by an item fingerprint (item id, lane state, age bucket); a miss
 * schedules a detached refresh, so a slow or dead provider costs the response
 * nothing and the next poll picks the score up. An unscored item — setting off,
 * failed call, abstain, or a score that has not arrived yet — ranks 0 and keeps
 * today's order among the other unscored items.
 *
 * The state carries o8-computed facts only: kind, lane state, age in minutes,
 * the rule risk word, whether a lane is blocked on the item, and the stored
 * merge-card referee facts (#2435). No card title, no summary, no
 * worker-written text; question ids are hashes of the item id.
 */
import { createHash } from 'node:crypto';

import { getApproval } from '@/lib/approvals/store';
import type { ApprovalRecord } from '@/lib/approvals/types';
import { askJudgment, thresholdAnswer, type AskJudgmentOptions } from '@/lib/judgment/client';
import { INBOX_QUESTIONS } from '@/lib/judgment/questions';
import type { ScoreAnswer, ScoreQuestion } from '@/lib/judgment/types';
import { findLaneBySession, getLane } from '@/lib/lane/registry';
import type { Lane, LaneStatus } from '@/lib/lane/types';
import type { MobileInboxItem, MobileInboxSnapshot, MobileInboxUrgency } from '@/lib/mobile/types';
import { isJudgmentRefereeEnabled } from '@/lib/judgment/route';

export const INBOX_URGENCY_SURFACE = 'mobile-inbox';

/**
 * Items asked in one call. Every item adds a full question to the set, so this
 * bounds both a call's payload and how many items one failed call can cost.
 */
export const INBOX_URGENCY_ITEMS_PER_CALL = 8;

/** Fingerprints move with age, so the cache is pruned by age of insertion, not by TTL. */
const URGENCY_CACHE_LIMIT = 500;

const LANE_BLOCKED_STATES = new Set<LaneStatus>([
  'awaiting_input',
  'awaiting_human',
  'awaiting_orchestrator',
  'recovering',
  'failed',
]);

/** o8-computed facts about one item. Everything here is derived by o8, never written by a worker. */
interface InboxItemFacts {
  /** Hash of the item id: the matching question's id, and the join key back to the item. */
  id: string;
  kind: MobileInboxItem['kind'];
  laneState: LaneStatus | 'none';
  ageMinutes: number | null;
  riskWord: ApprovalRecord['risk'] | 'none';
  laneBlocked: boolean;
  /** Present only on a merge card that already carries a stored referee read (#2435). */
  mergeCardReferee?: { docsOnly: number; risk: number };
}

interface UrgencyEntry {
  item: MobileInboxItem;
  index: number;
  facts: InboxItemFacts;
  fingerprint: string;
  cached: CachedUrgency | null;
}

interface CachedUrgency {
  answer: ScoreAnswer;
  receiptId: string | null;
}

const scoreCache = new Map<string, CachedUrgency>();
const inFlight = new Map<string, Promise<void>>();
/** Tail of the serial refresh queue: batches wait on it so only one call is open at a time. */
let refreshChain: Promise<void> = Promise.resolve();
let transportForTests: AskJudgmentOptions | undefined;

/** Test-only: point the urgency calls at a local endpoint fixture. */
export function setInboxUrgencyTransportForTests(options: AskJudgmentOptions | undefined): void {
  transportForTests = options;
}

/** Test-only: drop every cached score and in-flight refresh. */
export function clearInboxUrgencyCacheForTests(): void {
  scoreCache.clear();
  inFlight.clear();
  refreshChain = Promise.resolve();
}

/** Resolves once every scheduled refresh has settled. */
export async function waitForInboxUrgency(): Promise<void> {
  while (inFlight.size > 0) {
    await Promise.allSettled([...inFlight.values()]);
  }
}

/** Whether the referee may run: the same `judgment.provider` check `askJudgment` makes. */
export function isInboxUrgencyEnabled(): boolean {
  return isJudgmentRefereeEnabled();
}

/** The question id an item is asked under: a hash, so no item text reaches the provider. */
export function inboxUrgencyQuestionId(itemId: string): string {
  return `q_${createHash('sha256').update(itemId).digest('hex').slice(0, 12)}`;
}

function laneForItem(approval: ApprovalRecord | null, sessionKey: string | undefined): Lane | null {
  if (approval?.continuation?.kind === 'lane') {
    const lane = getLane(approval.continuation.laneId);
    if (lane) return lane;
  }
  const key = approval?.sessionKey ?? sessionKey;
  return key ? findLaneBySession(key) : null;
}

function itemStartedAt(approval: ApprovalRecord | null, lane: Lane | null): number | null {
  if (approval) return approval.createdAt;
  const stamp = lane?.lastEventAt ?? lane?.updatedAt ?? null;
  const parsed = stamp ? Date.parse(stamp) : Number.NaN;
  return Number.isNaN(parsed) ? null : parsed;
}

function factsForItem(item: MobileInboxItem, now: number): InboxItemFacts {
  const approval = item.approvalId ? getApproval(item.approvalId) : null;
  const lane = laneForItem(approval, item.sessionKey);
  const startedAt = itemStartedAt(approval, lane);
  const referee = approval?.referee;
  return {
    id: inboxUrgencyQuestionId(item.id),
    kind: item.kind,
    laneState: lane?.status ?? 'none',
    ageMinutes: startedAt === null ? null : Math.max(0, Math.round((now - startedAt) / 60_000)),
    riskWord: approval?.risk ?? 'none',
    // A lane continuation is literally held by this card; otherwise the lane's own state says it.
    laneBlocked: approval?.continuation?.kind === 'lane'
      || (lane ? LANE_BLOCKED_STATES.has(lane.status) : false),
    ...(referee
      ? { mergeCardReferee: { docsOnly: referee.answers.docsOnly.noul, risk: referee.answers.risk.score } }
      : {}),
  };
}

/** Coarse enough that a card keeps its score while it ages, sharp enough to re-ask as it gets old. */
function ageBucket(ageMinutes: number | null): string {
  if (ageMinutes === null) return 'unknown';
  if (ageMinutes < 5) return '0-5';
  if (ageMinutes < 15) return '5-15';
  if (ageMinutes < 60) return '15-60';
  if (ageMinutes < 240) return '60-240';
  return '240+';
}

/** The merge-card referee lands after creation (#2435); a score asked without its facts is re-asked once they exist. */
function refereeFingerprint(referee: InboxItemFacts['mergeCardReferee']): string {
  return referee ? `${referee.docsOnly.toFixed(2)}:${referee.risk.toFixed(2)}` : 'none';
}

function urgencyFingerprint(itemId: string, facts: InboxItemFacts): string {
  return [itemId, facts.laneState, ageBucket(facts.ageMinutes), refereeFingerprint(facts.mergeCardReferee)].join('\u0000');
}

function rememberScore(fingerprint: string, value: CachedUrgency): void {
  scoreCache.set(fingerprint, value);
  while (scoreCache.size > URGENCY_CACHE_LIMIT) {
    const oldest = scoreCache.keys().next();
    if (oldest.done) break;
    scoreCache.delete(oldest.value);
  }
}

async function askUrgencyBatch(batch: UrgencyEntry[]): Promise<void> {
  const questions: Record<string, ScoreQuestion> = {};
  for (const entry of batch) questions[entry.facts.id] = INBOX_QUESTIONS.urgency;
  const result = await askJudgment(
    {
      state: { items: batch.map((entry) => entry.facts) },
      questions,
      context: { surface: INBOX_URGENCY_SURFACE },
    },
    transportForTests,
  );
  if (!result) return;
  for (const entry of batch) {
    const answer = result.answers[entry.facts.id];
    if (answer) rememberScore(entry.fingerprint, { answer, receiptId: result.receiptId });
  }
}

/**
 * Start the missing scores in the background. Returns immediately; nothing
 * awaits these. Batches run one at a time: a long inbox must never fan out
 * concurrent provider calls from a poll the operator did not ask for.
 */
function scheduleRefresh(missing: UrgencyEntry[]): void {
  const pending = missing.filter((entry) => !inFlight.has(entry.fingerprint));
  for (let index = 0; index < pending.length; index += INBOX_URGENCY_ITEMS_PER_CALL) {
    const batch = pending.slice(index, index + INBOX_URGENCY_ITEMS_PER_CALL);
    const run: Promise<void> = refreshChain
      .then(() => askUrgencyBatch(batch))
      .catch((error) => {
        console.warn('[mobile-inbox-urgency] scoring skipped:', error instanceof Error ? error.message : 'error');
      })
      .finally(() => {
        for (const entry of batch) {
          if (inFlight.get(entry.fingerprint) === run) inFlight.delete(entry.fingerprint);
        }
      });
    refreshChain = run;
    for (const entry of batch) inFlight.set(entry.fingerprint, run);
  }
}

/**
 * Attach cached urgency scores and reorder: score descending, then today's
 * order. An unscored or abstaining item ranks 0, so with the setting off — or
 * before any score arrives — the items come back exactly as they were built.
 */
export function applyInboxUrgency(snapshot: MobileInboxSnapshot): MobileInboxSnapshot {
  if (!isInboxUrgencyEnabled() || snapshot.items.length === 0) return snapshot;
  try {
    const now = Date.now();
    const entries: UrgencyEntry[] = snapshot.items.map((item, index) => {
      const facts = factsForItem(item, now);
      const fingerprint = urgencyFingerprint(item.id, facts);
      return { item, index, facts, fingerprint, cached: scoreCache.get(fingerprint) ?? null };
    });
    scheduleRefresh(entries.filter((entry) => !entry.cached));

    const ranked = entries.map((entry) => {
      if (!entry.cached) return { index: entry.index, rank: 0, item: entry.item };
      const { answer, receiptId } = entry.cached;
      const urgency: MobileInboxUrgency = {
        score: answer.score,
        confidence: answer.confidence,
        abstain: answer.abstain,
        receiptId,
      };
      return {
        index: entry.index,
        rank: thresholdAnswer(answer)?.score ?? 0,
        item: { ...entry.item, urgency },
      };
    });
    ranked.sort((left, right) => (right.rank - left.rank) || (left.index - right.index));
    return { ...snapshot, items: ranked.map((entry) => entry.item) };
  } catch (error) {
    console.warn('[mobile-inbox-urgency] ordering skipped:', error instanceof Error ? error.message : 'error');
    return snapshot;
  }
}
