import 'server-only';

import type Database from 'better-sqlite3';

import { getSqlite } from '@/lib/db';
import { apiFetch } from '@/lib/mcp/operator-handlers/shared';
import { getOperatorDefaultsSync } from '@/lib/operator/defaults';
import { buildBroadcastSnapshot } from './snapshot';
import { broadcastGeneratedLinesSince } from './director';
import { listBroadcastEvents } from './events';
import { speakBroadcastWithNativeTts } from './native-tts';
import { appendBroadcastEvent, appendBroadcastSpeakerQueueDrop } from './post';
import type { BroadcastEvent } from './types';

const SPEAKER_TICK_MS = 1_000;
const MAX_QUEUE_DEPTH = 3;
const COMMENTARY_PAGE_LIMIT = 100;

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
}

interface CommentaryPage {
  commentary: BroadcastSpeechLine[];
  cursor: string | null;
  hasMore: boolean;
}

interface QueueEntry extends BroadcastSpeechLine {
  priority: boolean;
  order: number;
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

export function broadcastMomentLine(event: BroadcastEvent): string | null {
  if (event.kind === 'merge') return `Merge landed for ${subject(event)}.`;
  if (event.kind === 'approval' && event.payload.status === 'pending') {
    return `Approval needed for ${subject(event)}.`;
  }
  if (event.kind === 'packet_failed') return `${subject(event)} failed and needs attention.`;
  if (event.kind === 'spend_cap') return `Spend cap hit for ${subject(event)}; work is held.`;
  return null;
}

function lullLine(sqlite: Database.Database): string | null {
  const snapshot = buildBroadcastSnapshot(1, sqlite);
  if (!snapshot.focus) return null;
  const running = snapshot.lanes.filter((lane) => (
    lane.status === 'running' || lane.status === 'launching' || lane.status === 'awaiting_orchestrator'
  )).length;
  const waiting = snapshot.pendingApprovals.count > 0
    || snapshot.lanes.some((lane) => lane.status === 'reviewing');
  const lanePhrase = `${running} ${running === 1 ? 'lane' : 'lanes'} running`;
  return `Still on ${snapshot.focus.title}; ${lanePhrase}${waiting ? ', waiting on review' : ''}.`;
}

export class BroadcastSpeaker {
  private cursor: string | null = null;
  private eventCursor: string | null = null;
  private queue: QueueEntry[] = [];
  private seen = new Set<string>();
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

  private enqueue(line: BroadcastSpeechLine, sqlite: Database.Database): void {
    if (this.seen.has(line.id) || line.suppressed || !line.text.trim()) return;
    this.seen.add(line.id);
    const entry: QueueEntry = { ...line, priority: line.priority === true, order: this.order++ };
    this.queue.push(entry);
    if (this.queue.length > MAX_QUEUE_DEPTH) {
      let oldest = 0;
      for (let index = 1; index < this.queue.length; index += 1) {
        if (this.queue[index].order < this.queue[oldest].order) oldest = index;
      }
      const [dropped] = this.queue.splice(oldest, 1);
      appendBroadcastSpeakerQueueDrop(dropped.id, { sqlite });
    }
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
    sourceEventId: string | null,
    now: Date,
    sqlite: Database.Database,
  ): BroadcastSpeechLine {
    const event = appendBroadcastEvent({ kind: 'commentary', actor: 'symon', text }, {
      sqlite,
      now,
      metadata: { voiceTrigger: trigger, sourceEventId, hourlyCapped: true },
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
          if (normalSpeechEnabled || line.priority) this.enqueue(line, sqlite);
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
        !(event.kind === 'commentary' && (event.payload.voiceTrigger || event.payload.speakerQueueDrop))
      ));
      if (externalEvents.length > 0) {
        this.lastFeedEventAt = Math.max(...externalEvents.map((event) => Date.parse(event.timestamp)));
        this.lullAnnounced = false;
      } else if (this.lastFeedEventAt === null) {
        this.lastFeedEventAt = now.getTime();
      }

      if (settings.broadcastVoice === 'on') {
        const momentEvents = initialEventPoll && this.options.includeExisting !== true ? [] : feedEvents;
        for (const event of momentEvents) {
          const text = broadcastMomentLine(event);
          if (!text) continue;
          if (broadcastGeneratedLinesSince(sqlite, new Date(now.getTime() - 60 * 60_000).toISOString()) >= settings.maxPerHour) break;
          const line = this.generatedLine(text, 'moment', event.id, now, sqlite);
          generated.push(line.id);
          this.enqueue(line, sqlite);
        }

        const lullAt = (this.lastFeedEventAt ?? now.getTime()) + settings.lullMinutes * 60_000;
        if (!this.lullAnnounced && now.getTime() >= lullAt
          && broadcastGeneratedLinesSince(sqlite, new Date(now.getTime() - 60 * 60_000).toISOString()) < settings.maxPerHour) {
          const text = lullLine(sqlite);
          if (text) {
            const line = this.generatedLine(text, 'lull', null, now, sqlite);
            generated.push(line.id);
            this.enqueue(line, sqlite);
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
