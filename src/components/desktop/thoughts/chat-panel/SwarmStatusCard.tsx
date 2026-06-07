'use client';

/**
 * SwarmStatusCard — live, inline crew monitor.
 *
 * When the orchestrator fans a turn out to a parallel Claude + Codex swarm
 * (UltraCode), this card surfaces the o8-visible crew directly in the chat
 * transcript at the live edge and updates as packets move through their
 * lifecycle. It reads `missionState.packets` (handed down through
 * ThoughtsChatPanel) so it tracks status in real time without its own fetch.
 * Native Claude sub-agents run inside the workflow runtime and aren't packets,
 * so only the o8 Codex workers surface here. No modal — the crew lives in the
 * conversation, matching the operator's "beautiful cards, inline" direction.
 */

import { resolveDisplayRuntime, orchestratorRuntimeTone } from '@/lib/orchestrator/display';
import type { OrchestratorPacket, OrchestratorPacketStatus, OrchestratorRuntime } from '@/lib/orchestrator/types';

const SWARM_ACCENT = '#FF5A1F';

// Statuses that mean a packet is genuinely in-flight as part of the LIVE crew.
// The card mirrors the operator's "cards while it's working" intent, so only
// active-lifecycle states show. Excluded on purpose:
//   - `idle`   — a launched-then-idle / errored packet that isn't working.
//   - `failed` — terminal and dead; a failed agent surfaces in the agents list
//                and the orchestrator's chat report, not as a stale card that
//                bleeds dead packets into unrelated conversations.
//   - archived / released / draft — settled or not-yet-real.
const ACTIVE_STATUSES = new Set<OrchestratorPacketStatus>([
  'queued',
  'launching',
  'running',
  'recovering',
  'awaiting_review',
  'blocked',
]);

type StatusTone = { label: string; color: string; pulse: boolean };

function statusTone(status: OrchestratorPacketStatus): StatusTone {
  switch (status) {
    case 'running':
      return { label: 'Running', color: '#16a34a', pulse: true };
    case 'launching':
      return { label: 'Launching', color: '#2563eb', pulse: true };
    case 'queued':
      return { label: 'Queued', color: 'var(--t-text-faint)', pulse: false };
    case 'idle':
      return { label: 'Idle', color: 'var(--t-text-faint)', pulse: false };
    case 'awaiting_review':
      return { label: 'Review', color: '#d97706', pulse: false };
    case 'recovering':
      return { label: 'Recovering', color: '#d97706', pulse: true };
    case 'blocked':
      return { label: 'Blocked', color: '#dc2626', pulse: false };
    case 'failed':
      return { label: 'Failed', color: '#dc2626', pulse: false };
    default:
      return { label: status, color: 'var(--t-text-faint)', pulse: false };
  }
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

export function SwarmStatusCard({ packets }: { packets: OrchestratorPacket[] }) {
  const active = packets.filter((packet) => {
    if (!ACTIVE_STATUSES.has(packet.status)) return false;
    if (packet.archivedAt) return false;
    if (packet.releaseState === 'released') return false;
    // Pre-dispatch packets only belong to the live crew once a lane is bound.
    // Otherwise an archived lane hidden from the client's active-lane reconcile
    // can revive an orphaned packet as a phantom "Queued" swarm card.
    if ((packet.status === 'queued' || packet.status === 'launching') && !packet.lane?.laneId) {
      return false;
    }
    return true;
  });
  if (active.length === 0) return null;

  // Runtime breakdown for the header ("Codex 3").
  const byRuntime = new Map<OrchestratorRuntime, number>();
  for (const packet of active) {
    const runtime = resolveDisplayRuntime(packet);
    byRuntime.set(runtime, (byRuntime.get(runtime) ?? 0) + 1);
  }
  const breakdown = Array.from(byRuntime.entries())
    .map(([runtime, count]) => `${orchestratorRuntimeTone(runtime).label} ${count}`)
    .join(' · ');

  return (
    <div
      role="group"
      aria-label={`Swarm — ${active.length} ${active.length === 1 ? 'agent' : 'agents'}`}
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
          {active.length} {active.length === 1 ? 'agent' : 'agents'}
        </span>
        <div style={{ flex: 1 }} />
        {breakdown ? (
          <span style={{ color: 'var(--t-text-muted)', fontSize: 9.5, fontWeight: 300, letterSpacing: '-0.2px', lineHeight: 1.25, whiteSpace: 'nowrap', fontFamily: "'iA Writer Mono', 'JetBrains Mono', 'SF Mono', Menlo, ui-monospace, monospace" }}>
            {breakdown}
          </span>
        ) : null}
      </div>

      {/* Agent rows */}
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {active.map((packet, index) => {
          const runtime = resolveDisplayRuntime(packet);
          const tone = orchestratorRuntimeTone(runtime);
          const status = statusTone(packet.status);
          const eventLabel = packet.lane?.lastEventLabel?.trim() || packet.lastEventLabel?.trim() || null;
          const title = packet.title?.trim() || packet.referenceLabel?.trim() || 'Agent';
          return (
            <div
              key={packet.id}
              style={{
                display: 'grid',
                gridTemplateColumns: 'auto minmax(0, 1fr) auto',
                alignItems: 'center',
                gap: 10,
                paddingTop: 7,
                paddingRight: 12,
                paddingBottom: 7,
                paddingLeft: 12,
                borderTopWidth: index === 0 ? 0 : 1,
                borderTopStyle: 'solid',
                borderTopColor: 'var(--t-divider-subtle)',
              }}
            >
              {/* Runtime dot */}
              <span
                aria-hidden="true"
                title={tone.label}
                style={{ width: 7, height: 7, borderRadius: 999, background: tone.color, flexShrink: 0, boxShadow: `0 0 0 3px ${tone.background}` }}
              />

              {/* Title + event sub */}
              <span style={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }}>
                <span style={{ color: 'var(--t-text)', fontSize: 12.5, fontWeight: 300, letterSpacing: '-0.1px', lineHeight: 1.25, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {title}
                </span>
                <span style={{ color: 'var(--t-text-faint)', fontSize: 9.5, fontWeight: 260, letterSpacing: '-0.4px', lineHeight: 1.25, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {tone.label}{eventLabel ? ` · ${eventLabel}` : ''}
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
            </div>
          );
        })}
        <style>{`@keyframes swarmDotPulse { 0%,100% { opacity: 1 } 50% { opacity: 0.35 } }`}</style>
      </div>
    </div>
  );
}
