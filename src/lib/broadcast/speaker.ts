import 'server-only';

import type Database from 'better-sqlite3';

import { getSqlite } from '@/lib/db';
import { apiFetch } from '@/lib/mcp/operator-handlers/shared';
import { getOperatorDefaultsSync } from '@/lib/operator/defaults';
import { broadcastEventSpecifics } from './commentary-prompt';
import { buildBroadcastSnapshot } from './snapshot';
import { broadcastGeneratedLinesSince } from './director';
import { listBroadcastEvents } from './events';
import { speakBroadcastWithNativeTts } from './native-tts';
import { appendBroadcastEvent, BROADCAST_TEXT_MAX_LENGTH } from './post';
import type { BroadcastEvent } from './types';

const SPEAKER_TICK_MS = 1_000;
const MAX_QUEUE_DEPTH = 3;
const COMMENTARY_PAGE_LIMIT = 100;
const MOMENT_COALESCE_MS = 1_000;
const REPETITION_WINDOW_MS = 30_000;

export interface BroadcastVoiceSettings {
  broadcastVoice: 'off' | 'on';
  lullMinutes: number;
  maxPerHour: number;
}

export interface BroadcastSpeechLine {
  id: string;
  actor: string;
  text: string;
  timestamp: string;
  priority?: boolean;
  suppressed?: boolean;
  factKeys?: string[];
}

interface CommentaryPage {
  commentary: BroadcastSpeechLine[];
  cursor: string | null;
  hasMore: boolean;
}

interface QueueEntry extends BroadcastSpeechLine {
  priority: boolean;
  order: number;
  representedIds: string[];
  representedTexts: string[];
}

export type BroadcastSpeechRunner = (text: string) => Promise<void>;
export type BroadcastCommentaryLoader = (cursor: string | null) => Promise<CommentaryPage>;

export interface BroadcastSpeakerTickResult {
  status: 'processed' | 'skipped';
  reason: 'processed' | 'in_flight';
  cursor: string | null;
  queued: number;
  generated: string[];
}

function voiceSettings(): BroadcastVoiceSettings {
  const values = getOperatorDefaultsSync().values;
  return {
    broadcastVoice: values.broadcastVoice,
    lullMinutes: values.broadcastVoiceLullMinutes,
    maxPerHour: values.broadcastCommentaryMaxPerHour,
  };
}

async function loadCommentary(cursor: string | null): Promise<CommentaryPage> {
  const suffix = cursor ? `?since=${encodeURIComponent(cursor)}&limit=${COMMENTARY_PAGE_LIMIT}` : `?limit=${COMMENTARY_PAGE_LIMIT}`;
  const response = await apiFetch(`/api/broadcast/commentary${suffix}`) as Partial<CommentaryPage>;
  if (!Array.isArray(response.commentary) || typeof response.hasMore !== 'boolean') {
    throw new Error('Broadcast commentary endpoint returned an invalid page.');
  }
  return {
    commentary: response.commentary as BroadcastSpeechLine[],
    cursor: typeof response.cursor === 'string' ? response.cursor : null,
    hasMore: response.hasMore,
  };
}

function subject(event: BroadcastEvent): string {
  const separator = event.title.indexOf(' · ');
  return separator >= 0 ? event.title.slice(separator + 3) : 'the current packet';
}

function stringSpecific(specifics: Record<string, unknown>, key: string): string | null {
  const value = specifics[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function numberSpecific(specifics: Record<string, unknown>, key: string): number | null {
  const value = specifics[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function payloadText(event: BroadcastEvent, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = event.payload[key];
    if (typeof value === 'string' && value.trim()) return value.trim().replace(/\s+/g, ' ');
  }
  return null;
}

function packetLabel(event: BroadcastEvent, specifics = broadcastEventSpecifics(event, null)): string {
  const issue = specifics.issue;
  const title = subject(event);
  if (typeof issue === 'number' || typeof issue === 'string') return `issue #${issue}, ${title}`;
  if (title !== 'the current packet') return title;
  return event.packetId ? `packet ${event.packetId}` : event.laneId ? `lane ${event.laneId}` : title;
}

function listPhrase(items: string[]): string {
  if (items.length < 2) return items[0] ?? '';
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items.at(-1)}`;
}

function countPhrase(count: number, singular: string): string {
  return `${count} ${count === 1 ? singular : `${singular}s`}`;
}

function formatUsd(value: number): string {
  return `$${value.toFixed(value < 1 ? 2 : 0)}`;
}

function momentFactKey(event: BroadcastEvent): string {
  const specifics = broadcastEventSpecifics(event, null);
  const identity = event.packetId ?? event.laneId ?? String(specifics.issue ?? packetLabel(event, specifics));
  if (event.kind === 'review_verdict') return `review:${identity}:${String(specifics.approved)}`;
  if (event.kind === 'approval') return `approval:${identity}:${String(event.payload.status ?? '')}:${event.detail ?? ''}`;
  if (event.kind === 'spend_cap') {
    return `spend:${identity}:${String(specifics.costUsd ?? specifics.inputTokens ?? '')}`;
  }
  if (event.kind === 'lease_timeout') return `lease_timeout:${identity}:${String(specifics.resource ?? event.detail ?? '')}`;
  return `${event.kind}:${identity}`;
}

function mergeLine(events: BroadcastEvent[]): string {
  if (events.length === 0) return '';
  const details = events.map((event) => {
    const specifics = broadcastEventSpecifics(event, null);
    const commitSubject = stringSpecific(specifics, 'commitSubject');
    const changedFileCount = numberSpecific(specifics, 'changedFileCount');
    const sha = stringSpecific(specifics, 'mergeSha');
    const change = commitSubject
      ? `“${commitSubject}”${changedFileCount !== null ? ` changed ${countPhrase(changedFileCount, 'file')}` : ''}${sha ? ` at commit ${sha}` : ''}`
      : changedFileCount !== null
        ? `${countPhrase(changedFileCount, 'file')} changed${sha ? ` at commit ${sha}` : ''}`
        : sha ? `commit ${sha} is the recorded change` : null;
    return change
      ? `${packetLabel(event, specifics)}: ${change}`
      : `${packetLabel(event, specifics)} has no commit detail in the feed`;
  });
  const state = events.length === 1 ? 'The merge landed.' : 'Both merges landed.';
  return `${listPhrase(details)}. ${state}`;
}

function approvalLine(events: BroadcastEvent[]): string {
  if (events.length === 0) return '';
  const details = events.map((event) => {
    const action = event.detail || payloadText(event, 'summary', 'command', 'description') || 'an operator decision';
    const label = packetLabel(event);
    return label.toLowerCase() === action.toLowerCase() ? action : `${label}: ${action}`;
  });
  return `${listPhrase(details)}. ${events.length === 1 ? 'Approval is pending.' : `${events.length} approvals are pending.`}`;
}

function reviewLine(events: BroadcastEvent[]): string {
  if (events.length === 0) return '';
  return events.map((event) => {
    const specifics = broadcastEventSpecifics(event, null);
    const approved = specifics.approved === true;
    const findingsCount = numberSpecific(specifics, 'findingsCount');
    const firstFinding = specifics.firstFinding && typeof specifics.firstFinding === 'object'
      ? specifics.firstFinding as { file?: unknown; description?: unknown }
      : null;
    const finding = firstFinding
      ? [firstFinding.file, firstFinding.description].filter((value): value is string => typeof value === 'string' && Boolean(value)).join(': ').replace(/[.!?]+$/, '')
      : null;
    const evidence = findingsCount !== null
      ? `${countPhrase(findingsCount, 'finding')}${finding ? `, first at ${finding}` : ''}`
      : event.detail || 'no finding count in the feed';
    return `Review for ${packetLabel(event, specifics)} has ${evidence}. ${approved ? 'The verdict is approved.' : 'Changes are requested.'}`;
  }).join(' ');
}

function failureLine(events: BroadcastEvent[]): string {
  if (events.length === 0) return '';
  return events.map((event) => {
    const specifics = broadcastEventSpecifics(event, null);
    const elapsed = stringSpecific(specifics, 'elapsedInPreviousStatus');
    const reason = event.detail || payloadText(event, 'reason', 'message', 'error');
    const evidence = [elapsed ? `after ${elapsed}` : null, reason].filter((value): value is string => value !== null);
    return `${packetLabel(event, specifics)} ${evidence.length > 0 ? evidence.join(': ') : 'has no failure reason in the feed'}. The packet failed and needs attention.`;
  }).join(' ');
}

function spendLine(events: BroadcastEvent[]): string {
  if (events.length === 0) return '';
  return events.map((event) => {
    const specifics = broadcastEventSpecifics(event, null);
    const cost = numberSpecific(specifics, 'costUsd');
    const costCap = numberSpecific(specifics, 'costCapUsd');
    const tokens = numberSpecific(specifics, 'inputTokens');
    const tokenCap = numberSpecific(specifics, 'inputTokenCap');
    const amount = cost !== null
      ? `${formatUsd(cost)}${costCap !== null ? ` against a ${formatUsd(costCap)} cap` : ''}`
      : tokens !== null ? `${tokens.toLocaleString()} tokens${tokenCap !== null ? ` against a ${tokenCap.toLocaleString()} token cap` : ''}` : 'an unspecified amount';
    return `${packetLabel(event, specifics)} reached ${amount}. The spend cap is holding the work.`;
  }).join(' ');
}

function leaseTimeoutLine(events: BroadcastEvent[]): string {
  if (events.length === 0) return '';
  return events.map((event) => {
    const specifics = broadcastEventSpecifics(event, null);
    const resource = stringSpecific(specifics, 'resource') || event.detail || 'an unnamed resource';
    return `${packetLabel(event, specifics)} waited for ${resource}. The lease timed out.`;
  }).join(' ');
}

function isMomentEvent(event: BroadcastEvent): boolean {
  return event.kind === 'merge'
    || (event.kind === 'approval' && event.payload.status === 'pending')
    || event.kind === 'review_verdict'
    || event.kind === 'packet_failed'
    || event.kind === 'spend_cap'
    || event.kind === 'lease_timeout';
}

export function broadcastMomentLine(input: BroadcastEvent | BroadcastEvent[]): string | null {
  const events = (Array.isArray(input) ? input : [input]).filter(isMomentEvent);
  if (events.length === 0) return null;
  const reviewPackets = new Set(events.filter((event) => event.kind === 'review_verdict').map((event) => event.packetId).filter(Boolean));
  const relevant = events.filter((event) => !(
    event.kind === 'approval'
    && event.packetId
    && reviewPackets.has(event.packetId)
    && /review/i.test(event.detail ?? '')
  ));
  const groups = [
    mergeLine(relevant.filter((event) => event.kind === 'merge')),
    approvalLine(relevant.filter((event) => event.kind === 'approval')),
    reviewLine(relevant.filter((event) => event.kind === 'review_verdict')),
    failureLine(relevant.filter((event) => event.kind === 'packet_failed')),
    spendLine(relevant.filter((event) => event.kind === 'spend_cap')),
    leaseTimeoutLine(relevant.filter((event) => event.kind === 'lease_timeout')),
  ].filter(Boolean);
  return groups.join(' ').slice(0, BROADCAST_TEXT_MAX_LENGTH).trim() || null;
}

function lullLine(sqlite: Database.Database): string | null {
  const snapshot = buildBroadcastSnapshot(20, sqlite);
  if (!snapshot.focus) return null;
  const running = snapshot.lanes.filter((lane) => (
    lane.status === 'running' || lane.status === 'launching' || lane.status === 'awaiting_orchestrator'
  )).length;
  const waiting = snapshot.pendingApprovals.count > 0
    || snapshot.lanes.some((lane) => lane.status === 'reviewing');
  const lanePhrase = `${running} ${running === 1 ? 'lane' : 'lanes'} running`;
  const latest = [...snapshot.recentEvents].reverse().find((event) => (
    event.kind !== 'commentary' && event.kind !== 'conversation' && event.kind !== 'focus'
  ));
  const latestMoment = latest ? broadcastMomentLine(latest) : null;
  const latestDetail = latestMoment || (latest?.detail ? `Latest update for ${packetLabel(latest)}: ${latest.detail}.` : null);
  const focus = `${snapshot.focus.issue ? `issue #${snapshot.focus.issue}, ` : ''}${snapshot.focus.title}`;
  const goal = snapshot.focus.goal ? ` The goal is ${snapshot.focus.goal}.` : '';
  return `${latestDetail ? `${latestDetail} ` : ''}Still on ${focus}.${goal} ${lanePhrase}${waiting ? ', with review pending' : ''}.`;
}

export class BroadcastSpeaker {
  private cursor: string | null = null;
  private eventCursor: string | null = null;
  private queue: QueueEntry[] = [];
  private seen = new Set<string>();
  private recentFacts = new Map<string, number>();
  private recentTexts = new Map<string, number>();
  private pendingMoments: BroadcastEvent[] = [];
  private order = 0;
  private tickInFlight = false;
  private commentaryInitialized = false;
  private eventsInitialized = false;
  private drainPromise: Promise<void> | null = null;
  private lastFeedEventAt: number | null = null;
  private lullAnnounced = false;

  constructor(
    private readonly options: {
      sqlite?: Database.Database;
      speak?: BroadcastSpeechRunner;
      loadCommentary?: BroadcastCommentaryLoader;
      includeExisting?: boolean;
    } = {},
  ) {}

  state(): { cursor: string | null; queued: number; speaking: boolean } {
    return { cursor: this.cursor, queued: this.queue.length, speaking: this.drainPromise !== null };
  }

  async flush(): Promise<void> {
    await this.drainPromise;
  }

  private pruneRecent(nowMs: number): void {
    for (const [key, timestamp] of this.recentFacts) {
      if (nowMs - timestamp >= REPETITION_WINDOW_MS) this.recentFacts.delete(key);
    }
    for (const [key, timestamp] of this.recentTexts) {
      if (nowMs - timestamp >= REPETITION_WINDOW_MS) this.recentTexts.delete(key);
    }
  }

  private textKey(text: string): string {
    return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  }

  private queueSummary(texts: string[]): string {
    const unique = [...new Set(texts.map((text) => text.trim()).filter(Boolean))];
    let output = 'Queued updates condensed:';
    for (let index = 0; index < unique.length; index += 1) {
      const candidate = `${output} ${unique[index]}`;
      if (candidate.length <= BROADCAST_TEXT_MAX_LENGTH) {
        output = candidate;
      } else {
        output += ` ${unique.length - index} more queued ${unique.length - index === 1 ? 'update is' : 'updates are'} included.`;
        break;
      }
    }
    return output.slice(0, BROADCAST_TEXT_MAX_LENGTH);
  }

  private collapseOverflow(sqlite: Database.Database): void {
    while (this.queue.length > MAX_QUEUE_DEPTH) {
      const ordered = [...this.queue].sort((left, right) => Number(left.priority) - Number(right.priority) || left.order - right.order);
      const pair = ordered.slice(0, 2);
      const representedIds = pair.flatMap((entry) => entry.representedIds);
      const representedTexts = pair.flatMap((entry) => entry.representedTexts);
      const factKeys = [...new Set(pair.flatMap((entry) => entry.factKeys ?? []))];
      this.queue = this.queue.filter((entry) => !pair.includes(entry));
      const summary: QueueEntry = {
        id: `queue-summary:${representedIds.join(':')}`,
        actor: 'symon',
        text: this.queueSummary(representedTexts),
        timestamp: pair[0].timestamp,
        priority: pair.some((entry) => entry.priority),
        order: Math.min(...pair.map((entry) => entry.order)),
        factKeys,
        representedIds,
        representedTexts,
      };
      this.queue.push(summary);
      appendBroadcastEvent({ kind: 'commentary', actor: 'symon', text: summary.text }, {
        sqlite,
        metadata: { speakerQueueSummary: true, speechSuppressed: true, representedEventIds: representedIds },
      });
    }
  }

  private enqueue(line: BroadcastSpeechLine, sqlite: Database.Database, nowMs: number): void {
    if (this.seen.has(line.id) || line.suppressed || !line.text.trim()) return;
    this.pruneRecent(nowMs);
    const textKey = this.textKey(line.text);
    if (this.recentTexts.has(textKey) || this.queue.some((entry) => this.textKey(entry.text) === textKey)) return;
    this.seen.add(line.id);
    const entry: QueueEntry = {
      ...line,
      priority: line.priority === true,
      order: this.order++,
      representedIds: [line.id],
      representedTexts: [line.text],
    };
    this.queue.push(entry);
    this.collapseOverflow(sqlite);
    this.queue.sort((left, right) => (
      Number(right.priority) - Number(left.priority) || left.order - right.order
    ));
  }

  private startDrain(): void {
    if (this.drainPromise || this.queue.length === 0) return;
    const speak = this.options.speak ?? speakBroadcastWithNativeTts;
    this.drainPromise = (async () => {
      while (this.queue.length > 0) {
        const line = this.queue.shift();
        if (!line) break;
        try {
          const spokenAt = Date.now();
          for (const text of line.representedTexts) this.recentTexts.set(this.textKey(text), spokenAt);
          for (const fact of line.factKeys ?? []) this.recentFacts.set(fact, spokenAt);
          await speak(line.text);
        } catch (error) {
          console.warn(`[broadcast-speaker] ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    })().finally(() => {
      this.drainPromise = null;
      if (this.queue.length > 0) this.startDrain();
    });
  }

  private generatedLine(
    text: string,
    trigger: 'lull' | 'moment',
    sourceEventIds: string[],
    now: Date,
    sqlite: Database.Database,
  ): BroadcastSpeechLine {
    const event = appendBroadcastEvent({ kind: 'commentary', actor: 'symon', text }, {
      sqlite,
      now,
      metadata: {
        voiceTrigger: trigger,
        sourceEventId: sourceEventIds[0] ?? null,
        sourceEventIds,
        hourlyCapped: true,
      },
    });
    return {
      id: `broadcast:${event.id}`,
      actor: event.actor,
      text,
      timestamp: event.timestamp,
      priority: false,
    };
  }

  async tick(options: { now?: Date; settings?: BroadcastVoiceSettings } = {}): Promise<BroadcastSpeakerTickResult> {
    if (this.tickInFlight) {
      return { status: 'skipped', reason: 'in_flight', cursor: this.cursor, queued: this.queue.length, generated: [] };
    }
    this.tickInFlight = true;
    const sqlite = this.options.sqlite ?? getSqlite();
    const now = options.now ?? new Date();
    const settings = options.settings ?? voiceSettings();
    const generated: string[] = [];
    try {
      const loader = this.options.loadCommentary ?? loadCommentary;
      const initialPoll = !this.commentaryInitialized;
      let hasMore = true;
      while (hasMore) {
        const page = await loader(this.cursor);
        this.cursor = page.cursor;
        hasMore = page.hasMore;
        for (const line of page.commentary) {
          const normalSpeechEnabled = settings.broadcastVoice === 'on'
            && (!initialPoll || this.options.includeExisting === true);
          if (normalSpeechEnabled || line.priority) this.enqueue(line, sqlite, now.getTime());
        }
      }
      this.commentaryInitialized = true;

      const initialEventPoll = !this.eventsInitialized;
      const feedEvents: BroadcastEvent[] = [];
      let eventHasMore = true;
      while (eventHasMore) {
        const page = listBroadcastEvents({ cursor: this.eventCursor, limit: COMMENTARY_PAGE_LIMIT }, sqlite);
        this.eventCursor = page.cursor;
        eventHasMore = page.hasMore;
        feedEvents.push(...page.events);
      }
      this.eventsInitialized = true;
      const externalEvents = feedEvents.filter((event) => (
        !(event.kind === 'commentary' && (
          event.payload.voiceTrigger || event.payload.speakerQueueDrop || event.payload.speakerQueueSummary
        ))
      ));
      if (externalEvents.length > 0) {
        this.lastFeedEventAt = Math.max(...externalEvents.map((event) => Date.parse(event.timestamp)));
        this.lullAnnounced = false;
      } else if (this.lastFeedEventAt === null) {
        this.lastFeedEventAt = now.getTime();
      }

      if (settings.broadcastVoice === 'on') {
        const momentEvents = (initialEventPoll && this.options.includeExisting !== true ? [] : feedEvents)
          .filter(isMomentEvent);
        const pendingIds = new Set(this.pendingMoments.map((event) => event.id));
        this.pendingMoments.push(...momentEvents.filter((event) => !pendingIds.has(event.id)));
        const firstMomentAt = this.pendingMoments.length > 0 ? Date.parse(this.pendingMoments[0].timestamp) : Number.NaN;
        if (this.pendingMoments.length > 0 && (!Number.isFinite(firstMomentAt) || now.getTime() - firstMomentAt >= MOMENT_COALESCE_MS)) {
          this.pruneRecent(now.getTime());
          const burstFacts = new Set<string>();
          const queuedFacts = new Set(this.queue.flatMap((entry) => entry.factKeys ?? []));
          const unsaid = this.pendingMoments.filter((event) => {
            const fact = momentFactKey(event);
            if (this.recentFacts.has(fact) || queuedFacts.has(fact) || burstFacts.has(fact)) return false;
            burstFacts.add(fact);
            return true;
          });
          this.pendingMoments = [];
          const text = broadcastMomentLine(unsaid);
          if (text && broadcastGeneratedLinesSince(sqlite, new Date(now.getTime() - 60 * 60_000).toISOString()) < settings.maxPerHour) {
            const line = this.generatedLine(text, 'moment', unsaid.map((event) => event.id), now, sqlite);
            line.factKeys = [...burstFacts];
            generated.push(line.id);
            this.enqueue(line, sqlite, now.getTime());
          }
        }

        const lullAt = (this.lastFeedEventAt ?? now.getTime()) + settings.lullMinutes * 60_000;
        if (!this.lullAnnounced && now.getTime() >= lullAt
          && broadcastGeneratedLinesSince(sqlite, new Date(now.getTime() - 60 * 60_000).toISOString()) < settings.maxPerHour) {
          const text = lullLine(sqlite);
          if (text) {
            const line = this.generatedLine(text, 'lull', [], now, sqlite);
            generated.push(line.id);
            this.enqueue(line, sqlite, now.getTime());
            this.lullAnnounced = true;
          }
        }
      }
      this.startDrain();
      return { status: 'processed', reason: 'processed', cursor: this.cursor, queued: this.queue.length, generated };
    } finally {
      this.tickInFlight = false;
    }
  }
}

let speakerTimer: NodeJS.Timeout | null = null;
let loopSpeaker: BroadcastSpeaker | null = null;

export function startBroadcastSpeakerLoop(): () => void {
  if (speakerTimer) return () => undefined;
  loopSpeaker = new BroadcastSpeaker();
  const tick = () => {
    void loopSpeaker?.tick().catch((error) => {
      console.warn(`[broadcast-speaker] ${error instanceof Error ? error.message : String(error)}`);
    });
  };
  tick();
  speakerTimer = setInterval(tick, SPEAKER_TICK_MS);
  speakerTimer.unref();
  return () => {
    if (speakerTimer) clearInterval(speakerTimer);
    speakerTimer = null;
    loopSpeaker = null;
  };
}
