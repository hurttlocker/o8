'use client';

/**
 * FleetCanvasTab — the fleet-canvas workspace tab.
 *
 * Live packet-objects as calm glass cards on a solid paper canvas: arrange
 * freely (drag persists per scope via fleet-canvas-store), status reads at a
 * distance through the Symon-dock motion vocabulary (working = slow breathing,
 * waiting = still + orange, failed = still + red), settled packets stack
 * quietly in the corner instead of vanishing. Click a card to dive into the
 * packet's existing session surface — this tab renders the fleet, it never
 * runs work itself. Zero new backend: everything reads useOrchestratorData().
 *
 * NOT the `canvas` kind (agent-created file/diff viewer). Gated behind the
 * experimentalCanvas operator flag.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { UpdateCard } from '@/components/desktop/UpdateCard';
import { useOrchestratorData } from '@/components/desktop/orchestrator-data-context';
import { STATUS_COLORS } from '@/components/desktop/SessionVisualizer';
import {
  readFleetCanvasPositions,
  writeFleetCanvasPosition,
  type FleetCanvasPositions,
} from '@/components/desktop/workspace-terminal/fleet-canvas-store';
import type { OrchestratorPacket, OrchestratorPacketStatus } from '@/lib/orchestrator/types';

const CARD_W = 200;
const CARD_H = 84;
const FLOW_ORIGIN = 28;
const FLOW_STEP_X = CARD_W + 24;
const FLOW_STEP_Y = CARD_H + 24;
const FLOW_COLUMNS = 4;
const DRAG_CLICK_THRESHOLD = 5;

type CardTone = 'working' | 'waiting' | 'failed' | 'neutral';

function packetTone(status: OrchestratorPacketStatus): CardTone {
  if (status === 'running' || status === 'launching' || status === 'recovering') return 'working';
  if (status === 'awaiting_review' || status === 'blocked') return 'waiting';
  if (status === 'failed') return 'failed';
  return 'neutral';
}

function isSettled(packet: OrchestratorPacket): boolean {
  return packet.status === 'released' || packet.status === 'archived' || Boolean(packet.archivedAt);
}

function toneDotColor(tone: CardTone): string {
  if (tone === 'working') return STATUS_COLORS.running;
  if (tone === 'waiting') return STATUS_COLORS.waiting;
  if (tone === 'failed') return STATUS_COLORS.error;
  return 'var(--t-text-faint)';
}

function toneLabel(tone: CardTone, status: OrchestratorPacketStatus): string {
  if (tone === 'working') return 'Working';
  if (tone === 'waiting') return status === 'blocked' ? 'Blocked' : 'Needs review';
  if (tone === 'failed') return 'Failed';
  if (status === 'queued') return 'Queued';
  if (status === 'draft') return 'Draft';
  return 'Idle';
}

function repoBasename(path: string | null): string {
  if (!path) return '';
  const parts = path.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? '';
}

interface FleetCanvasTabProps {
  active: boolean;
  repoPath: string | null;
}

export function FleetCanvasTab({ active, repoPath }: FleetCanvasTabProps) {
  const orchestratorData = useOrchestratorData();
  const packets = orchestratorData?.missionState?.packets ?? [];
  const onSelectSession = orchestratorData?.onSelectSession;
  const onOpenO8Panel = orchestratorData?.onOpenO8Panel;

  const scope = repoPath ?? 'fleet';
  const [positions, setPositions] = useState<FleetCanvasPositions>(() => readFleetCanvasPositions(scope));
  useEffect(() => {
    setPositions(readFleetCanvasPositions(scope));
  }, [scope]);

  const activeCards = useMemo(() => packets.filter((packet) => !isSettled(packet)), [packets]);
  const settledCards = useMemo(() => packets.filter((packet) => isSettled(packet)), [packets]);

  // Auto-place: cards without a stored position land in a left-to-right flow,
  // slotted by their index among the unpositioned so new dispatches never
  // stack on top of an arranged card.
  const resolvedPositions = useMemo(() => {
    const result: FleetCanvasPositions = {};
    let flowIndex = 0;
    for (const packet of activeCards) {
      const stored = positions[packet.id];
      if (stored) {
        result[packet.id] = stored;
      } else {
        result[packet.id] = {
          x: FLOW_ORIGIN + (flowIndex % FLOW_COLUMNS) * FLOW_STEP_X,
          y: FLOW_ORIGIN + Math.floor(flowIndex / FLOW_COLUMNS) * FLOW_STEP_Y,
        };
        flowIndex += 1;
      }
    }
    return result;
  }, [activeCards, positions]);

  // Drag bookkeeping lives in a ref — only the live position goes through
  // state so a drag never re-renders more than the moving card's coordinates.
  const dragRef = useRef<{
    packetId: string;
    pointerId: number;
    startClientX: number;
    startClientY: number;
    originX: number;
    originY: number;
    moved: boolean;
  } | null>(null);

  const diveIn = useCallback((packet: OrchestratorPacket) => {
    const sessionKey = packet.lane?.sessionKey ?? null;
    if (sessionKey && onSelectSession) {
      onSelectSession(sessionKey);
      return;
    }
    // No live session to land on — fall back to the workspace diff for the
    // packet's repo so the click always goes somewhere real.
    if (onOpenO8Panel) {
      onOpenO8Panel({ repoPath: packet.workspaceTargetPath, tab: 'workspace' });
    }
  }, [onOpenO8Panel, onSelectSession]);

  const handlePointerDown = useCallback((packet: OrchestratorPacket, event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const origin = resolvedPositions[packet.id];
    if (!origin) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      packetId: packet.id,
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      originX: origin.x,
      originY: origin.y,
      moved: false,
    };
  }, [resolvedPositions]);

  const handlePointerMove = useCallback((packet: OrchestratorPacket, event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.packetId !== packet.id || drag.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - drag.startClientX;
    const deltaY = event.clientY - drag.startClientY;
    if (!drag.moved && Math.abs(deltaX) < DRAG_CLICK_THRESHOLD && Math.abs(deltaY) < DRAG_CLICK_THRESHOLD) return;
    drag.moved = true;
    setPositions((previous) => ({
      ...previous,
      [packet.id]: {
        x: Math.max(4, drag.originX + deltaX),
        y: Math.max(4, drag.originY + deltaY),
      },
    }));
  }, []);

  const handlePointerUp = useCallback((packet: OrchestratorPacket, event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.packetId !== packet.id || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (drag.moved) {
      const deltaX = event.clientX - drag.startClientX;
      const deltaY = event.clientY - drag.startClientY;
      writeFleetCanvasPosition(scope, packet.id, {
        x: Math.max(4, drag.originX + deltaX),
        y: Math.max(4, drag.originY + deltaY),
      });
      return;
    }
    diveIn(packet);
  }, [diveIn, scope]);

  return (
    <div
      aria-hidden={!active}
      style={{
        position: active ? 'relative' : 'absolute',
        inset: 0,
        flex: active ? 1 : undefined,
        height: '100%',
        minHeight: 0,
        visibility: active ? 'visible' : 'hidden',
        pointerEvents: active ? 'auto' : 'none',
        overflow: 'hidden',
        // The center stays SOLID paper — glass cards layer over this, the
        // canvas itself never bleeds the vibrancy backdrop (DESIGN.md).
        background: 'var(--t-canvas-bg, var(--t-chat-surface-bg, var(--t-panel)))',
      }}
    >
      {activeCards.length === 0 && settledCards.length === 0 ? (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <span style={{ fontSize: 12.5, fontWeight: 300, color: 'var(--t-text-faint)', letterSpacing: '-0.1px' }}>
            No packets yet — dispatch from the Orchestrator and they appear here.
          </span>
        </div>
      ) : null}

      {activeCards.map((packet) => {
        const position = resolvedPositions[packet.id];
        if (!position) return null;
        return (
          <FleetCard
            key={packet.id}
            packet={packet}
            x={position.x}
            y={position.y}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onView={diveIn}
            onReview={onOpenO8Panel ? (target) => onOpenO8Panel({ repoPath: target.workspaceTargetPath, tab: 'workspace' }) : undefined}
          />
        );
      })}

      {settledCards.length > 0 ? <SettledStack packets={settledCards} onView={diveIn} /> : null}

      {/* Update slot — the canvas route never mounted the dashboard's UpdateCard,
          so a pending update was invisible here (report 0.1.580). Reuse the same
          self-contained card (renders null when no update); top-right keeps it
          clear of the bottom-right SettledStack. */}
      <div
        style={{
          position: 'absolute',
          top: 16,
          right: 16,
          width: 300,
          display: 'flex',
          flexDirection: 'column',
          zIndex: 5,
        }}
      >
        <UpdateCard />
      </div>
    </div>
  );
}

function FleetCard({
  packet,
  x,
  y,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onView,
  onReview,
}: {
  packet: OrchestratorPacket;
  x: number;
  y: number;
  onPointerDown: (packet: OrchestratorPacket, event: React.PointerEvent<HTMLDivElement>) => void;
  onPointerMove: (packet: OrchestratorPacket, event: React.PointerEvent<HTMLDivElement>) => void;
  onPointerUp: (packet: OrchestratorPacket, event: React.PointerEvent<HTMLDivElement>) => void;
  onView: (packet: OrchestratorPacket) => void;
  onReview?: (packet: OrchestratorPacket) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const tone = packetTone(packet.status);
  const working = tone === 'working';
  const repo = repoBasename(packet.workspaceTargetPath);
  const meta = [repo, packet.runtime, packet.referenceLabel].filter(Boolean).join(' · ');

  return (
    <motion.div
      role="button"
      tabIndex={0}
      aria-label={`${packet.title} — ${toneLabel(tone, packet.status)}`}
      animate={working ? { scale: [1, 1.015, 1], opacity: [1, 0.92, 1] } : { scale: 1, opacity: 1 }}
      transition={working ? { duration: 3.2, repeat: Infinity, ease: 'easeInOut' } : { type: 'spring', stiffness: 400, damping: 30 }}
      onPointerDown={(event) => onPointerDown(packet, event)}
      onPointerMove={(event) => onPointerMove(packet, event)}
      onPointerUp={(event) => onPointerUp(packet, event)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onView(packet);
        }
      }}
      style={{
        position: 'absolute',
        left: x,
        top: y,
        width: CARD_W,
        minHeight: CARD_H,
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        paddingTop: 10,
        paddingRight: 12,
        paddingBottom: 10,
        paddingLeft: 12,
        borderRadius: 14,
        background: 'var(--t-bg-card)',
        border: `1px solid ${tone === 'waiting' ? 'rgba(245, 158, 11, 0.45)' : 'var(--t-panel-border, var(--t-divider))'}`,
        boxShadow: hovered
          ? '0 4px 18px rgba(15, 23, 42, 0.12)'
          : '0 1px 6px rgba(15, 23, 42, 0.06)',
        cursor: 'grab',
        userSelect: 'none',
        touchAction: 'none',
        fontFamily: 'var(--font-sans-system)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
        <span
          aria-hidden
          style={{
            width: 6,
            height: 6,
            borderRadius: '50%',
            flexShrink: 0,
            background: toneDotColor(tone),
          }}
        />
        <span
          style={{
            fontSize: 13.5,
            fontWeight: 300,
            letterSpacing: '-0.1px',
            color: 'var(--t-text)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {packet.title}
        </span>
      </div>
      <span
        style={{
          fontSize: 9.5,
          fontWeight: 260,
          color: 'var(--t-text-muted)',
          letterSpacing: '0.01em',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {meta || toneLabel(tone, packet.status)}
      </span>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 'auto', minHeight: 16 }}>
        <span style={{ fontSize: 9.5, fontWeight: 260, color: tone === 'waiting' ? STATUS_COLORS.waiting : 'var(--t-text-faint)' }}>
          {toneLabel(tone, packet.status)}
        </span>
        {/* Hover-reveal quiet actions per hurttlocker — never default-visible. */}
        <span style={{ display: 'inline-flex', gap: 8, opacity: hovered ? 1 : 0, transition: 'opacity 120ms' }}>
          <CardAction label="View" onActivate={() => onView(packet)} />
          {onReview ? <CardAction label="Review" onActivate={() => onReview(packet)} /> : null}
        </span>
      </div>
    </motion.div>
  );
}

function CardAction({ label, onActivate }: { label: string; onActivate: () => void }) {
  return (
    <button
      type="button"
      onPointerDown={(event) => event.stopPropagation()}
      onPointerUp={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        onActivate();
      }}
      style={{
        borderWidth: 0,
        background: 'transparent',
        padding: 0,
        fontSize: 10,
        fontWeight: 300,
        color: 'var(--t-text-muted)',
        cursor: 'pointer',
        fontFamily: 'var(--font-sans-system)',
      }}
      onMouseEnter={(event) => { event.currentTarget.style.color = 'var(--t-text)'; }}
      onMouseLeave={(event) => { event.currentTarget.style.color = 'var(--t-text-muted)'; }}
    >
      {label}
    </button>
  );
}

/** Settled packets gather in a quiet bottom-right stack — a definite ending
 *  on the canvas (#1231), never a vanishing pane. */
function SettledStack({ packets, onView }: { packets: OrchestratorPacket[]; onView: (packet: OrchestratorPacket) => void }) {
  const visible = packets.slice(0, 3);
  return (
    <div
      style={{
        position: 'absolute',
        right: 16,
        bottom: 16,
        width: 188,
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        paddingTop: 8,
        paddingRight: 10,
        paddingBottom: 8,
        paddingLeft: 10,
        borderRadius: 12,
        background: 'var(--t-bg-card)',
        border: '1px solid var(--t-panel-border, var(--t-divider))',
        opacity: 0.7,
        fontFamily: 'var(--font-sans-system)',
      }}
    >
      <span style={{ fontSize: 9.5, fontWeight: 260, color: 'var(--t-text-faint)', letterSpacing: '0.04em', textTransform: 'uppercase' }}>
        Settled · {packets.length}
      </span>
      {visible.map((packet) => (
        <button
          key={packet.id}
          type="button"
          onClick={() => onView(packet)}
          title={packet.title}
          style={{
            display: 'block',
            width: '100%',
            borderWidth: 0,
            background: 'transparent',
            padding: 0,
            textAlign: 'left',
            fontSize: 11,
            fontWeight: 300,
            color: 'var(--t-text-muted)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            cursor: 'pointer',
            fontFamily: 'var(--font-sans-system)',
          }}
        >
          {packet.title}
        </button>
      ))}
      {packets.length > visible.length ? (
        <span style={{ fontSize: 9.5, fontWeight: 260, color: 'var(--t-text-faint)' }}>
          +{packets.length - visible.length} more
        </span>
      ) : null}
    </div>
  );
}
