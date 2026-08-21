'use client';

import { motion } from 'framer-motion';

import type {
  BroadcastAgentSnapshot,
  BroadcastEvent,
  BroadcastFocusSnapshot,
  BroadcastLaneSnapshot,
  BroadcastSnapshot,
} from '@/lib/broadcast/types';

export type BroadcastConnectionState = 'booting' | 'live' | 'missing-token' | 'forbidden' | 'offline';

const DEAD_AIR_MS = 90_000;

function formatTime(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(parsed);
}

function formatElapsed(nowMs: number, value: string | null): string {
  if (!value) return 'no events yet';
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return 'time unavailable';
  const elapsedSeconds = Math.max(0, Math.floor((nowMs - parsed) / 1_000));
  if (elapsedSeconds < 60) return `${elapsedSeconds}s since last event`;
  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  if (elapsedMinutes < 60) return `${elapsedMinutes}m since last event`;
  return `${Math.floor(elapsedMinutes / 60)}h since last event`;
}

function formatFocusElapsed(nowMs: number, startedAt: string): string {
  const parsed = Date.parse(startedAt);
  if (Number.isNaN(parsed)) return '00:00';
  const elapsedSeconds = Math.max(0, Math.floor((nowMs - parsed) / 1_000));
  if (elapsedSeconds < 3_600) {
    const minutes = Math.floor(elapsedSeconds / 60).toString().padStart(2, '0');
    const seconds = (elapsedSeconds % 60).toString().padStart(2, '0');
    return `${minutes}:${seconds}`;
  }
  const hours = Math.floor(elapsedSeconds / 3_600);
  const minutes = Math.floor((elapsedSeconds % 3_600) / 60).toString().padStart(2, '0');
  return `${hours}:${minutes}`;
}

function kindLabel(kind: string): string {
  return kind.replaceAll('_', ' ').toUpperCase();
}

function eventDotIsFilled(kind: string): boolean {
  return kind === 'session_launched'
    || kind === 'progress'
    || kind === 'brain_consulted'
    || kind === 'lease_acquired'
    || kind === 'approval'
    || kind === 'message'
    || kind === 'commentary'
    || kind === 'conversation'
    || kind === 'focus';
}

export function StatusDot({ filled, size = 6 }: { filled: boolean; size?: number }) {
  return (
    <span
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        minWidth: size,
        borderRadius: '50%',
        border: '1px solid var(--t-accent)',
        background: filled ? 'var(--t-accent)' : 'transparent',
        boxSizing: 'border-box',
        display: 'inline-block',
      }}
    />
  );
}

function SectionLabel({ children }: { children: string }) {
  return (
    <div
      style={{
        color: 'var(--t-text-faint)',
        fontSize: 13,
        fontWeight: 300,
        letterSpacing: '0.04em',
        lineHeight: '18px',
      }}
    >
      {children}
    </div>
  );
}

const cardStyle = {
  minWidth: 0,
  border: '1px solid var(--t-panel-border)',
  borderRadius: 14,
  background: 'var(--t-panel)',
  overflowX: 'hidden' as const,
};

function FocusCard({ focus, nowMs }: { focus: BroadcastFocusSnapshot; nowMs: number }) {
  return (
    <section aria-label="Now building" style={{ ...cardStyle, paddingTop: 20, paddingRight: 22, paddingBottom: 22, paddingLeft: 22 }}>
      <SectionLabel>NOW BUILDING</SectionLabel>
      <div
        style={{
          marginTop: 12,
          color: 'var(--t-text-strong)',
          fontSize: 30,
          fontWeight: 400,
          letterSpacing: '-0.2px',
          lineHeight: 1.2,
          overflowWrap: 'anywhere',
        }}
      >
        {focus.title}
      </div>
      {focus.goal ? (
        <div style={{ marginTop: 10, color: 'var(--t-text-secondary)', fontSize: 18, fontWeight: 300, lineHeight: 1.45, overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}>
          {focus.goal}
        </div>
      ) : null}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 14, color: 'var(--t-text-faint)', fontSize: 14, fontWeight: 260, letterSpacing: '-0.4px', lineHeight: 1.25 }}>
        {focus.issue ? <span>#{focus.issue}</span> : null}
        <time aria-label="Focus elapsed time" dateTime={focus.startedAt}>
          {formatFocusElapsed(nowMs, focus.startedAt)}
        </time>
      </div>
    </section>
  );
}

function OnAirLane({ agent, lane, nowMs }: {
  agent: BroadcastAgentSnapshot;
  lane: BroadcastLaneSnapshot | undefined;
  nowMs: number;
}) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '14px minmax(0, 1fr)',
        columnGap: 10,
        minWidth: 0,
        paddingTop: 14,
        paddingRight: 0,
        paddingBottom: 14,
        paddingLeft: 0,
        borderBottom: '1px solid var(--t-divider-subtle)',
      }}
    >
      <span style={{ paddingTop: 7, display: 'flex', justifyContent: 'center' }}>
        <StatusDot filled />
      </span>
      <div style={{ minWidth: 0 }}>
        <div
          style={{
            color: 'var(--t-text)',
            fontSize: 18,
            fontWeight: 300,
            letterSpacing: '-0.1px',
            lineHeight: 1.25,
            overflowWrap: 'anywhere',
          }}
        >
          {agent.label}
        </div>
        <div
          style={{
            marginTop: 4,
            color: 'var(--t-text-faint)',
            fontSize: 14,
            fontWeight: 260,
            letterSpacing: '-0.4px',
            lineHeight: 1.25,
            overflowWrap: 'anywhere',
          }}
        >
          {agent.repo} · {agent.status} · {formatElapsed(nowMs, lane?.lastEventAt ?? null)}
        </div>
      </div>
    </div>
  );
}

// Only lanes with a live process belong on air. Finished lanes waiting on
// review or a human sit in the ledger for days and would read as stuck.
const ON_AIR_STATUSES = new Set(['launching', 'running', 'recovering']);

function OnAirCard({ snapshot, nowMs }: { snapshot: BroadcastSnapshot | null; nowMs: number }) {
  const agents = (snapshot?.activeAgents ?? []).filter((agent) => ON_AIR_STATUSES.has(agent.status));
  const lanesById = new Map((snapshot?.lanes ?? []).map((lane) => [lane.id, lane]));
  return (
    <section aria-label="Lanes on air" style={{ ...cardStyle, paddingTop: 18, paddingRight: 20, paddingBottom: 4, paddingLeft: 20 }}>
      <SectionLabel>ON AIR</SectionLabel>
      {agents.length ? agents.map((agent) => (
        <OnAirLane key={agent.laneId} agent={agent} lane={lanesById.get(agent.laneId)} nowMs={nowMs} />
      )) : (
        <div style={{ paddingTop: 18, paddingRight: 0, paddingBottom: 18, paddingLeft: 0, color: 'var(--t-text-muted)', fontSize: 18, fontWeight: 300 }}>
          No lanes on air
        </div>
      )}
    </section>
  );
}

function ApprovalCard({ count }: { count: number }) {
  return (
    <section aria-label="Pending approvals" style={{ ...cardStyle, paddingTop: 18, paddingRight: 20, paddingBottom: 18, paddingLeft: 20 }}>
      <SectionLabel>PENDING APPROVALS</SectionLabel>
      <div
        style={{
          marginTop: 8,
          color: 'var(--t-text)',
          fontSize: 28,
          fontWeight: 400,
          letterSpacing: '-0.2px',
          lineHeight: 1.25,
        }}
      >
        {count}
      </div>
    </section>
  );
}

function isCommentaryEvent(event: BroadcastEvent): boolean {
  const kind = String(event.kind);
  return kind === 'commentary' || kind === 'conversation';
}

function CommentaryCard({ events }: { events: BroadcastEvent[] }) {
  const event = [...events].reverse().find(isCommentaryEvent);
  return (
    <section aria-label="Latest commentary or conversation" style={{ ...cardStyle, paddingTop: 20, paddingRight: 22, paddingBottom: 22, paddingLeft: 22 }}>
      <SectionLabel>LATEST COMMENTARY / CONVERSATION</SectionLabel>
      {event ? (
        <>
          <div
            style={{
              marginTop: 14,
              color: 'var(--t-text)',
              fontSize: 28,
              fontWeight: 300,
              letterSpacing: '-0.2px',
              lineHeight: 1.3,
              overflowWrap: 'anywhere',
              whiteSpace: 'pre-wrap',
            }}
          >
            {event.detail || event.title}
          </div>
          {event.detail ? (
            <div style={{ marginTop: 10, color: 'var(--t-text-secondary)', fontSize: 18, fontWeight: 300, lineHeight: 1.45, overflowWrap: 'anywhere' }}>
              {event.title}
            </div>
          ) : null}
          <div style={{ marginTop: 12, color: 'var(--t-text-faint)', fontSize: 14, fontWeight: 260, letterSpacing: '-0.4px', lineHeight: 1.25 }}>
            {kindLabel(String(event.kind))} · {formatTime(event.timestamp)}
          </div>
        </>
      ) : (
        <div style={{ marginTop: 14, color: 'var(--t-text-muted)', fontSize: 18, fontWeight: 300, lineHeight: 1.5 }}>
          No commentary has been broadcast yet.
        </div>
      )}
    </section>
  );
}

export function BroadcastSidebar({ snapshot, events, nowMs }: {
  snapshot: BroadcastSnapshot | null;
  events: BroadcastEvent[];
  nowMs: number;
}) {
  return (
    <aside aria-label="Broadcast sidebar" style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0, gridArea: 'sidebar' }}>
      {snapshot?.focus ? <FocusCard focus={snapshot.focus} nowMs={nowMs} /> : null}
      <OnAirCard snapshot={snapshot} nowMs={nowMs} />
      <ApprovalCard count={snapshot?.pendingApprovals.count ?? 0} />
      <CommentaryCard events={events} />
    </aside>
  );
}

function newestLane(lanes: BroadcastLaneSnapshot[]): BroadcastLaneSnapshot | undefined {
  return [...lanes].sort((left, right) => {
    const leftTime = left.lastEventAt ? Date.parse(left.lastEventAt) : 0;
    const rightTime = right.lastEventAt ? Date.parse(right.lastEventAt) : 0;
    return rightTime - leftTime;
  })[0];
}

function latestActivityAt(events: BroadcastEvent[], lanes: BroadcastLaneSnapshot[]): number | null {
  let latest: number | null = null;
  for (const event of events) {
    const timestamp = Date.parse(event.timestamp);
    if (!Number.isNaN(timestamp) && (latest === null || timestamp > latest)) latest = timestamp;
  }
  for (const lane of lanes) {
    if (!lane.lastEventAt) continue;
    const timestamp = Date.parse(lane.lastEventAt);
    if (!Number.isNaN(timestamp) && (latest === null || timestamp > latest)) latest = timestamp;
  }
  return latest;
}

function DeadAirLine({ lanes }: { lanes: BroadcastLaneSnapshot[] }) {
  const lane = newestLane(lanes);
  return (
    <div
      data-broadcast-dead-air="true"
      style={{
        paddingTop: 18,
        paddingRight: 20,
        paddingBottom: 18,
        paddingLeft: 20,
        borderBottom: '1px solid var(--t-divider-subtle)',
        color: 'var(--t-text-muted)',
        fontSize: 18,
        fontWeight: 300,
        lineHeight: 1.5,
        overflowWrap: 'anywhere',
      }}
    >
      watching {lanes.length} {lanes.length === 1 ? 'lane' : 'lanes'}{lane ? ` · newest ${lane.label}` : ''}
    </div>
  );
}

function EventRow({ event, reduceMotion }: { event: BroadcastEvent; reduceMotion: boolean }) {
  return (
    <motion.article
      initial={reduceMotion ? false : { opacity: 0, y: 18 }}
      animate={{ opacity: 1, y: 0 }}
      transition={reduceMotion ? { duration: 0 } : { type: 'spring', stiffness: 400, damping: 30 }}
      style={{
        display: 'grid',
        gridTemplateColumns: '18px minmax(0, 1fr) auto',
        columnGap: 12,
        alignItems: 'start',
        minWidth: 0,
        paddingTop: 18,
        paddingRight: 18,
        paddingBottom: 18,
        paddingLeft: 18,
        borderBottom: '1px solid var(--t-divider-subtle)',
      }}
    >
      <span style={{ paddingTop: 9, display: 'flex', justifyContent: 'center' }}>
        <StatusDot filled={eventDotIsFilled(String(event.kind))} />
      </span>
      <div style={{ minWidth: 0 }}>
        <div style={{ color: 'var(--t-text)', fontSize: 22, fontWeight: 300, letterSpacing: '-0.1px', lineHeight: 1.25, overflowWrap: 'anywhere' }}>
          {event.title}
        </div>
        {event.detail ? (
          <div style={{ marginTop: 4, color: 'var(--t-text-secondary)', fontSize: 18, fontWeight: 300, letterSpacing: '-0.1px', lineHeight: 1.5, overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}>
            {event.detail}
          </div>
        ) : null}
        <div style={{ marginTop: 4, color: 'var(--t-text-faint)', fontSize: 14, fontWeight: 260, letterSpacing: '-0.4px', lineHeight: 1.25, overflowWrap: 'anywhere' }}>
          {kindLabel(String(event.kind))}{event.repo ? ` · ${event.repo}` : ''}{event.actor ? ` · ${event.actor}` : ''}
        </div>
      </div>
      <time dateTime={event.timestamp} style={{ color: 'var(--t-text-faint)', fontSize: 14, fontWeight: 260, letterSpacing: '-0.4px', lineHeight: 1.25, whiteSpace: 'nowrap' }}>
        {formatTime(event.timestamp)}
      </time>
    </motion.article>
  );
}

export function EventFeed({ events, lanes, state, nowMs, reduceMotion }: {
  events: BroadcastEvent[];
  lanes: BroadcastLaneSnapshot[];
  state: BroadcastConnectionState;
  nowMs: number;
  reduceMotion: boolean;
}) {
  const latestAt = latestActivityAt(events, lanes);
  const hasDeadAir = lanes.length > 0 && (latestAt === null || nowMs - latestAt >= DEAD_AIR_MS);
  const visibleEvents = [...events].reverse();
  return (
    <section aria-label="Broadcast event feed" aria-live="polite" style={{ ...cardStyle, gridArea: 'stream' }}>
      <div style={{ paddingTop: 14, paddingRight: 18, paddingBottom: 13, paddingLeft: 18, borderBottom: '1px solid var(--t-divider-subtle)' }}>
        <SectionLabel>EVENT STREAM</SectionLabel>
      </div>
      {hasDeadAir ? <DeadAirLine lanes={lanes} /> : null}
      {visibleEvents.length ? visibleEvents.map((event) => (
        <EventRow key={event.id} event={event} reduceMotion={reduceMotion} />
      )) : hasDeadAir ? null : lanes.length ? (
        <div style={{ paddingTop: 34, paddingRight: 24, paddingBottom: 34, paddingLeft: 24, color: 'var(--t-text-muted)', fontSize: 18, fontWeight: 300, lineHeight: 1.5, textAlign: 'center', overflowWrap: 'anywhere' }}>
          Following {lanes.length} {lanes.length === 1 ? 'lane' : 'lanes'}.
        </div>
      ) : (
        <div style={{ paddingTop: 34, paddingRight: 24, paddingBottom: 34, paddingLeft: 24, color: 'var(--t-text-muted)', fontSize: 18, fontWeight: 300, lineHeight: 1.5, textAlign: 'center', overflowWrap: 'anywhere' }}>
          {state === 'missing-token'
            ? 'Open the spectator URL returned by o8 broadcast token mint.'
            : state === 'forbidden'
              ? 'This spectator credential is no longer authorized.'
              : 'Waiting for governed activity.'}
        </div>
      )}
    </section>
  );
}
