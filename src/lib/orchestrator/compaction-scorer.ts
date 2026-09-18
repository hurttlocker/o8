/**
 * Judgment-scored compaction (#2465, program #2481). RECORD-ONLY.
 *
 * When `judgment.provider` is on, auto-compaction asks one locked question per
 * compacted entry ("is this entry needed to continue the current task?") in a
 * single call, alongside the summarizer. The state is o8-computed facts only:
 * entry id, kind, role, approximate tokens, tool names, and the text the
 * summarizer already sees. A text above the per-entry budget is sent as head
 * plus tail plus its size, never dropped.
 *
 * The scores and provisional keep / drop / summarize buckets are written to
 * the compaction entry (`compaction.scorer`) and the archive JSON. Nothing
 * reads them: the segment, the summary, and the resume prelude are unchanged.
 * The calibration replay (`scripts/judgment-replay.mjs --label compaction`)
 * scores them against what later turns actually referenced.
 */
import { askJudgment, type AskJudgmentOptions } from '@/lib/judgment/client';
import { compactionQuestions } from '@/lib/judgment/questions';
import { isJudgmentRefereeEnabled } from '@/lib/judgment/route';
import { ABSTAIN_CONFIDENCE } from '@/lib/judgment/types';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';

export const COMPACTION_SCORER_SURFACE = 'compaction-scorer';

/** Entry text above this many chars goes as head + tail + size. */
export const ENTRY_TEXT_BUDGET = 2_000;
const HEAD_CHARS = 800;
const TAIL_CHARS = 800;
/** Total text chars across the state; entries past the cap carry no text. */
const STATE_TEXT_CAP = 60_000;
/** Question count cap for one call; entries past it are left out and the call is marked truncated. */
const MAX_SCORED_ENTRIES = 300;
/** Production transport: one bounded attempt, so compaction never waits on retries. */
const PRODUCTION_TRANSPORT: AskJudgmentOptions = { timeoutMs: 8_000, maxAttempts: 1 };

export interface CompactionStateEntry {
  /** The question id that asks about this entry. */
  question: string;
  id: string;
  kind: string;
  role: MobileTranscriptEntry['role'];
  approxTokens: number;
  tools: string[];
  text: string | null;
  /** Present when the text is above the budget: `text` is head + marker + tail. */
  clipped?: { chars: number; headChars: number; tailChars: number };
}

export interface CompactionScorerRecord {
  receiptId: string | null;
  /** Probability the entry is needed to continue, per entry id. */
  scores: Record<string, number>;
  /** PROVISIONAL bands; nothing acts on them. */
  buckets: { keep: string[]; drop: string[]; summarize: string[] };
  latencyMs: number;
  truncated: boolean;
}

let transportOverride: AskJudgmentOptions | undefined;

/** Test-only: point the scorer at a local endpoint fixture. */
export function setCompactionScorerTransportForTests(options: AskJudgmentOptions | undefined): void {
  transportOverride = options;
}

const approxTokens = (value: string) => Math.max(0, Math.ceil(value.length / 4));
const stripCompactionTags = (value: string) => value.replace(/<\/?compacted_context\b[^>]*>/gi, '').trim();

/** The entry text before the summarizer's own 1400-char cut. */
function entryText(entry: MobileTranscriptEntry): string {
  return entry.type === 'compaction' ? stripCompactionTags(entry.compaction?.summary ?? entry.text) : entry.text.trim();
}

export const questionIdFor = (entryId: string) => `entry_${entryId}`;

/** The state sent to the provider. Pure; exported for the state-shape tests. */
export function buildCompactionState(entries: readonly MobileTranscriptEntry[]): { state: { entries: CompactionStateEntry[] }; truncated: boolean } {
  let truncated = entries.length > MAX_SCORED_ENTRIES;
  let used = 0;
  const stateEntries = entries.slice(0, MAX_SCORED_ENTRIES).map((entry): CompactionStateEntry => {
    const full = entryText(entry);
    const base = {
      question: questionIdFor(entry.id),
      id: entry.id,
      kind: entry.type ?? 'message',
      role: entry.role,
      approxTokens: approxTokens(full),
      tools: entry.toolCalls?.map((tool) => tool.name).filter(Boolean) ?? [],
    };
    const clipped = full.length > ENTRY_TEXT_BUDGET;
    const text = clipped
      ? `${full.slice(0, HEAD_CHARS)}\n[... ${full.length - HEAD_CHARS - TAIL_CHARS} chars omitted of ${full.length} ...]\n${full.slice(-TAIL_CHARS)}`
      : full;
    if (used + text.length > STATE_TEXT_CAP) {
      truncated = true;
      return { ...base, text: null };
    }
    used += text.length;
    return clipped
      ? { ...base, text, clipped: { chars: full.length, headChars: HEAD_CHARS, tailChars: TAIL_CHARS } }
      : { ...base, text };
  });
  return { state: { entries: stateEntries }, truncated };
}

/** keep at or above 1 - ABSTAIN_CONFIDENCE, drop at or below ABSTAIN_CONFIDENCE, summarize between. PROVISIONAL. */
export function bucketScores(scores: Record<string, number>): CompactionScorerRecord['buckets'] {
  const buckets: CompactionScorerRecord['buckets'] = { keep: [], drop: [], summarize: [] };
  for (const [id, p] of Object.entries(scores)) {
    if (p >= 1 - ABSTAIN_CONFIDENCE) buckets.keep.push(id);
    else if (p <= ABSTAIN_CONFIDENCE) buckets.drop.push(id);
    else buckets.summarize.push(id);
  }
  return buckets;
}

/**
 * Score a compaction segment. Resolves null (with no request) when the
 * setting is off or the segment is empty, and null when the call fails.
 * Never throws.
 */
export async function scoreCompactionSegment(entries: readonly MobileTranscriptEntry[]): Promise<CompactionScorerRecord | null> {
  try {
    if (entries.length === 0 || !isJudgmentRefereeEnabled()) return null;
    const { state, truncated } = buildCompactionState(entries);
    const questions = compactionQuestions(state.entries.map((entry) => entry.question));
    const result = await askJudgment({
      state,
      questions,
      context: { surface: COMPACTION_SCORER_SURFACE, truncated },
    }, transportOverride ?? PRODUCTION_TRANSPORT);
    if (!result) return null;
    const scores: Record<string, number> = {};
    for (const entry of state.entries) scores[entry.id] = result.answers[entry.question].noul;
    return { receiptId: result.receiptId, scores, buckets: bucketScores(scores), latencyMs: result.latencyMs, truncated };
  } catch (error) {
    console.warn('[compaction-scorer] skipped:', error instanceof Error ? error.message : 'error');
    return null;
  }
}
