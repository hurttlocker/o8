/**
 * The phone's projection of a Symon standing watch.
 *
 * `symonWatchRecord` is the desktop/tool shape: it carries the session id, the
 * source checkpoint fields, and the whole saved `then` body. The phone renders
 * one row per standing intent and a cancel control, so this narrows the record
 * to what that row shows and names the states an operator reads rather than the
 * engine's internal enabled/parked flags.
 *
 * Nothing here queries — the caller hands in records from `listSymonWatches` or
 * `cancelSymonWatch`, which keeps one source for what a watch IS.
 */
import type { SymonWatchRecord } from '@/lib/automations/symon-watch';

export type MobileSymonWatchState = 'active' | 'parked' | 'fired' | 'expired' | 'cancelled';

export interface MobileSymonWatch {
  id: string;
  /** The operator's own wording of the condition. */
  condition: string;
  then: 'report' | 'plan' | null;
  /** What Symon will say when it fires, plus the saved step names for a plan. */
  summary: string;
  /** Epoch ms, or null for a watch with no deadline row. */
  deadline: number | null;
  state: MobileSymonWatchState;
  parked: boolean;
  /** Epoch ms the parked watch was announced, or null while it is still quiet. */
  nudgedAt: number | null;
  lastLedgerEvent: SymonWatchRecord['lastLedgerEvent'];
}

const SUMMARY_LIMIT = 240;

function spokenSummary(record: SymonWatchRecord): string {
  const say = (record.say ?? '').trim();
  const body = record.then === 'plan' && record.steps.length > 0
    ? `${say} Then: ${record.steps.join(', ')}.`.trim()
    : say;
  const characters = [...body];
  if (characters.length <= SUMMARY_LIMIT) return body;
  return `${characters.slice(0, SUMMARY_LIMIT).join('')}…`;
}

/**
 * `symonWatchRecord.state` collapses every settled watch to `closed`, which the
 * phone cannot render: "it fired" and "you cancelled it" are different rows. The
 * ledger tail is what tells them apart — it is the watch's own durable receipt,
 * written by the same call that closed the row.
 */
function watchState(record: SymonWatchRecord): MobileSymonWatchState {
  if (record.state === 'watching') return 'active';
  if (record.state === 'parked') return 'parked';
  if (record.state === 'expired') return 'expired';
  const phase = record.lastLedgerEvent?.phase;
  if (phase === 'watch_cancelled') return 'cancelled';
  if (phase === 'watch_expired') return 'expired';
  return 'fired';
}

export function mobileSymonWatch(record: SymonWatchRecord): MobileSymonWatch {
  return {
    id: record.id,
    condition: record.condition,
    then: record.then,
    summary: spokenSummary(record),
    deadline: record.deadline ?? null,
    state: watchState(record),
    parked: record.parkedAt != null,
    nudgedAt: record.announcedAt ?? null,
    lastLedgerEvent: record.lastLedgerEvent,
  };
}
