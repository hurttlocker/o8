'use client';

/**
 * SwarmStatusCard — live, inline crew monitor.
 *
 * When the orchestrator fans a turn out to a parallel crew, this card surfaces
 * the live crew directly in the chat transcript at the live edge and updates as
 * work moves through its lifecycle. It reads `missionState.packets` (handed
 * down through ThoughtsChatPanel) for the o8 Codex workers, and an explicit
 * `scouts` list for the native Claude sub-agents the orchestrator spawns via its
 * Task tool (research fan-out). Native scouts run inside the orchestrator's own
 * process and aren't packets — without this they'd vanish into the collapsed
 * tool-call cluster, which is exactly the "5 scouts fired but nothing's shown"
 * gap. No modal — the crew lives in the conversation, matching the operator's
 * "beautiful cards, inline" direction.
 */

import { orchestratorRuntimeTone, orchestratorStatusTone, resolveDisplayRuntime } from '@/lib/orchestrator/display';
import { packetTerminalState } from '@/lib/orchestrator/packet-state';
import type { OrchestratorPacket, OrchestratorPacketStatus, OrchestratorRuntime } from '@/lib/orchestrator/types';

const SWARM_ACCENT = '#FF5A1F';
const FOCUS_LANE_EVENT = 'o8:focus-spawned-agent-lane';
export const SWARM_CREW_SCROLL_STYLE = {
  display: 'flex',
  flexDirection: 'column',
  maxHeight: 'min(360px, 44vh)',
  overflowY: 'auto',
  overflowX: 'hidden',
  overscrollBehavior: 'contain',
} as const;

/** A native Claude sub-agent (Task-tool scout) surfaced in the live crew. */
export interface SwarmScoutView {
  id: string;
  /** Human label — the sub-agent's task description, falling back to its type. */
  label: string;
  status: 'running' | 'done';
}

// A mission's crew remains truthful at the live edge after it settles. Idle
// and draft packets are not dispatched crew, but terminal packets stay visible
// with the existing Failed / Completed / Archived vocabulary instead of
// disappearing while a stale Running row remains in the transcript.
const VISIBLE_STATUSES = new Set<OrchestratorPacketStatus>([
  'queued',
  'launching',
  'running',
  'recovering',
  'awaiting_review',
  'blocked',
  'failed',
  'released',
  'archived',
]);

type StatusTone = { label: string; color: string; pulse: boolean };

function statusTone(status: OrchestratorPacketStatus): StatusTone {
  const tone = orchestratorStatusTone(status);
  return {
    label: tone.label,
    color: tone.dot,
    pulse: status === 'running' || status === 'launching' || status === 'recovering',
  };
}

function scoutStatusTone(status: SwarmScoutView['status']): StatusTone {
  return status === 'running'
    ? { label: 'Running', color: '#16a34a', pulse: true }
    : { label: 'Done', color: 'var(--t-text-faint)', pulse: false };
}

function packetCardStatus(packet: OrchestratorPacket): OrchestratorPacketStatus {
  const terminal = packetTerminalState(packet);
  if (terminal === 'released') return 'released';
  if (terminal === 'archived') return 'archived';
  if (terminal === 'failed') return packet.status === 'blocked' ? 'blocked' : 'failed';
  return packet.status;
}

function SwarmGlyph({ size = 13, color = SWARM_ACCENT }: { size?: number; color?: string }) {
  return (
    <span aria-hidden="true" style={{ display: 'inline-flex', alignItems: 'center', width: size, height: size, flexShrink: 0 }}>
      <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
        <circle cx="8" cy="3.4" r="2" fill={color} />
        <circle cx="3.4" cy="11.6" r="2" fill={color} />
        <circle cx="12.6" cy="11.6" r="2" fill={color} />
      </svg>
    </span>
  );
}

/** One crew row — shared geometry for both scouts and Codex packets. */
function CrewRow({
  dotColor,
  dotGlow,
  title,
  sub,
  status,
  showTopBorder,
  onClick,
}: {
  dotColor: string;
  dotGlow?: string;
  title: string;
  sub: string;
  status: StatusTone;
  showTopBorder: boolean;
  onClick?: () => void;
}) {
  const rowStyle = {
    width: '100%',
    display: 'grid',
    gridTemplateColumns: 'auto minmax(0, 1fr) auto',
    alignItems: 'center',
    gap: 10,
    paddingTop: 7,
    paddingRight: 12,
    paddingBottom: 7,
    paddingLeft: 12,
    borderTopWidth: showTopBorder ? 1 : 0,
    borderTopStyle: 'solid',
    borderTopColor: 'var(--t-divider-subtle)',
    borderRightWidth: 0,
    borderBottomWidth: 0,
    borderLeftWidth: 0,
    background: 'transparent',
    textAlign: 'left',
    cursor: onClick ? 'pointer' : 'default',
    fontFamily: 'var(--font-sans-system)',
  } as const;
  const content = (
    <>
      {/* Role dot */}
      <span
        aria-hidden="true"
        style={{ width: 7, height: 7, borderRadius: 999, background: dotColor, flexShrink: 0, boxShadow: dotGlow ? `0 0 0 3px ${dotGlow}` : undefined }}
      />

      {/* Title + sub */}
      <span style={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }}>
        <span style={{ color: 'var(--t-text)', fontSize: 12.5, fontWeight: 300, letterSpacing: '-0.1px', lineHeight: 1.25, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {title}
        </span>
        <span style={{ color: 'var(--t-text-faint)', fontSize: 9.5, fontWeight: 260, letterSpacing: '-0.4px', lineHeight: 1.25, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {sub}
        </span>
      </span>

      {/* Status chip */}
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
        <span
          aria-hidden="true"
          style={{
            width: 6,
            height: 6,
            borderRadius: 999,
            background: status.color,
            flexShrink: 0,
            animation: status.pulse ? 'swarmDotPulse 1.6s ease-in-out infinite' : 'none',
          }}
        />
        <span style={{ color: status.color, fontSize: 10, fontWeight: 300, letterSpacing: '-0.1px', lineHeight: 1.25, whiteSpace: 'nowrap' }}>
          {status.label}
        </span>
      </span>
    </>
  );

  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        title={`Open ${title}`}
        style={rowStyle}
        onMouseEnter={(event) => { event.currentTarget.style.background = 'var(--t-panel-hover)'; }}
        onMouseLeave={(event) => { event.currentTarget.style.background = 'transparent'; }}
      >
        {content}
      </button>
    );
  }

  return <div style={rowStyle}>{content}</div>;
}

interface SwarmStatusCardProps {
  packets: OrchestratorPacket[];
  scouts?: SwarmScoutView[];
  onFocusPacket?: (packet: OrchestratorPacket) => void;
}

export function focusSwarmPacket(packet: OrchestratorPacket, onFocusPacket?: (packet: OrchestratorPacket) => void) {
  if (onFocusPacket) {
    onFocusPacket(packet);
    return;
  }
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(FOCUS_LANE_EVENT, {
    detail: {
      packetId: packet.id,
      laneId: packet.lane?.laneId ?? null,
      sessionKey: packet.lane?.sessionKey ?? packet.lane?.tabId ?? null,
      title: packet.title,
    },
  }));
}

export function SwarmStatusCard({ packets, scouts = [], onFocusPacket }: SwarmStatusCardProps) {
  const active = packets.flatMap((packet) => {
    const status = packetCardStatus(packet);
    if (!VISIBLE_STATUSES.has(status)) return [];
    // Pre-dispatch packets only belong to the live crew once a lane is bound.
    // Otherwise an archived lane hidden from the client's active-lane reconcile
    // can revive an orphaned packet as a phantom "Queued" swarm card.
    if ((status === 'queued' || status === 'launching') && !packet.lane?.laneId) {
      return [];
    }
    return [{ packet, status }];
  });
  if (active.length === 0 && scouts.length === 0) return null;

  const crewCount = active.length + scouts.length;

  // Runtime breakdown for the header ("Scouts 5 · Codex 3").
  const byRuntime = new Map<OrchestratorRuntime, number>();
  for (const { packet } of active) {
    const runtime = resolveDisplayRuntime(packet);
    byRuntime.set(runtime, (byRuntime.get(runtime) ?? 0) + 1);
  }
  const breakdown = [
    scouts.length > 0 ? `Scouts ${scouts.length}` : null,
    ...Array.from(byRuntime.entries()).map(([runtime, count]) => `${orchestratorRuntimeTone(runtime).label} ${count}`),
  ]
    .filter(Boolean)
    .join(' · ');

  // Native scouts ARE claude-code sub-agents — color their dot with the same
  // tone the app already uses for claude-code so the role reads consistently.
  const scoutTone = orchestratorRuntimeTone('claude-code');

  return (
    <div
      role="group"
      aria-label={`Swarm — ${crewCount} ${crewCount === 1 ? 'agent' : 'agents'}`}
      style={{
        display: 'flex',
        flexDirection: 'column',
        borderRadius: 12,
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: 'rgba(255, 90, 31, 0.22)',
        background: 'var(--t-input-bg)',
        overflow: 'hidden',
        animation: 'swarmCardIn 280ms cubic-bezier(0.22, 1, 0.36, 1)',
      }}
    >
      <style>{`@keyframes swarmCardIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }`}</style>

      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 9,
          paddingTop: 9,
          paddingRight: 12,
          paddingBottom: 9,
          paddingLeft: 12,
          borderBottomWidth: 1,
          borderBottomStyle: 'solid',
          borderBottomColor: 'var(--t-divider-subtle)',
        }}
      >
        <SwarmGlyph size={14} />
        <span style={{ color: 'var(--t-text)', fontSize: 13.5, fontWeight: 300, letterSpacing: '-0.1px', lineHeight: 1.25 }}>
          Swarm
        </span>
        <span style={{ color: 'var(--t-text-faint)', fontSize: 9.5, fontWeight: 260, letterSpacing: '-0.4px', lineHeight: 1.25 }}>
          {crewCount} {crewCount === 1 ? 'agent' : 'agents'}
        </span>
        <div style={{ flex: 1 }} />
        {breakdown ? (
          <span style={{ color: 'var(--t-text-muted)', fontSize: 9.5, fontWeight: 300, letterSpacing: '-0.2px', lineHeight: 1.25, whiteSpace: 'nowrap', fontFamily: "'iA Writer Mono', 'JetBrains Mono', 'SF Mono', Menlo, ui-monospace, monospace" }}>
            {breakdown}
          </span>
        ) : null}
      </div>

      {/* Crew rows — native scouts first (research fan-out), then Codex workers. */}
      <div data-swarm-crew="scrollable" style={SWARM_CREW_SCROLL_STYLE}>
        {scouts.map((scout, index) => (
          <CrewRow
            key={scout.id}
            dotColor={scoutTone.color}
            dotGlow={scoutTone.background}
            title={scout.label}
            sub={`${scoutTone.label} · scout`}
            status={scoutStatusTone(scout.status)}
            showTopBorder={index > 0}
          />
        ))}
        {active.map(({ packet, status }, index) => {
          const runtime = resolveDisplayRuntime(packet);
          const tone = orchestratorRuntimeTone(runtime);
          const eventLabel = packet.blockedReason === 'runtime_process_exit'
            ? packet.blockedReason
            : packet.lane?.lastEventLabel?.trim() || packet.lastEventLabel?.trim() || null;
          const title = packet.title?.trim() || packet.referenceLabel?.trim() || 'Agent';
          return (
            <CrewRow
              key={packet.id}
              dotColor={tone.color}
              dotGlow={tone.background}
              title={title}
              sub={`${tone.label}${eventLabel ? ` · ${eventLabel}` : ''}`}
              status={statusTone(status)}
              showTopBorder={index > 0 || scouts.length > 0}
              onClick={() => focusSwarmPacket(packet, onFocusPacket)}
            />
          );
        })}
        <style>{`@keyframes swarmDotPulse { 0%,100% { opacity: 1 } 50% { opacity: 0.35 } }`}</style>
      </div>
    </div>
  );
}
