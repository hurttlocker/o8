'use client';

/**
 * LivingAgentPanel — the calm, state-streaming "Coordinator" surface
 * that lives on the left side of an active packet view (#888/#890).
 *
 * Renders three sections, top to bottom:
 *
 *   1. ACTIVITY      — Coordinator tool-call chips streaming in as
 *                      they happen. Compact one-line chips, calm
 *                      slide-in (100ms fade), no bounce.
 *   2. SUB-AGENTS    — "N / M background agents running". Each
 *                      sub-agent renders as one row. Spawn/complete
 *                      events update the count without layout shift
 *                      (we reserve a min-height for the section).
 *   3. VERIFIER      — Yellow Issues-style row when verifier flagged
 *                      anything for the active packet.
 *
 * Subscribes to the existing window-level events that the
 * orchestrator stream socket already publishes:
 *   - `cortex:agent-supervisor-update` (sub-agent lifecycle)
 *
 * Tool-call events come through the orchestrator chat panel's
 * messages array — to avoid re-plumbing WS subscriptions, the parent
 * passes the latest tool calls as a prop. The throttle is at 100ms.
 *
 * Hard founder constraint (issue body):
 *   "State changes should feel like turning a page, not a Slack
 *    notification. One orange accent max per update. No sound. No
 *    bounce. No avatar jiggle."
 */

import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import { agentDisplayLabel } from '@/lib/orchestrator/display';
import { ToolCallChip, classifyToolCall, extractO8AskQuestion, type ToolCallChipStatus } from './ToolCallChip';

const RENDER_THROTTLE_MS = 100;
const MAX_TOOL_CALLS_VISIBLE = 8;

export interface LivingToolCall {
  id: string;
  name: string;
  status: ToolCallChipStatus;
  argument?: string | null;
  /** Epoch ms when this tool call was first seen — used for slide-in ordering. */
  observedAt: number;
}

interface SupervisorUpdate {
  surfaceId: string;
  name?: string;
  status?: string;
  detail?: string;
  duration?: number;
  repoPath?: string;
  prompt?: string;
}

interface SubAgentRow {
  id: string;
  label: string;
  status: 'running' | 'completed' | 'idle';
  detail?: string | null;
  updatedAt: number;
}

export interface LivingAgentPanelProps {
  packet: OrchestratorPacket;
  /** Latest Coordinator tool calls, scoped to this packet's session. */
  toolCalls?: LivingToolCall[];
}

function LivingAgentPanelBase({ packet, toolCalls = [] }: LivingAgentPanelProps) {
  const [, setRenderTick] = useState(0);
  const lastRenderRef = useRef<number>(0);
  const throttleTimerRef = useRef<number | null>(null);
  const [subAgents, setSubAgents] = useState<SubAgentRow[]>([]);
  // The motion of this panel is delegated to its children (ToolCallChip).
  // The chips handle prefers-reduced-motion themselves.

  // Throttle: never re-render this surface more than once per 100ms even
  // if events arrive in a burst. We schedule a trailing tick so the last
  // event in a burst is reflected.
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<SupervisorUpdate>).detail;
      if (!detail?.surfaceId) return;

      // Only count sub-agents that share this packet's lane scope. The
      // supervisor channel doesn't yet carry packet IDs directly, so we
      // accept all updates whose repoPath matches the packet's repo. If
      // the packet has no repo bound (rare), fall back to all updates.
      const matchesRepo = !packet.workspaceTargetPath
        || !detail.repoPath
        || detail.repoPath === packet.workspaceTargetPath;
      if (!matchesRepo) return;

      setSubAgents((current) => {
        const idx = current.findIndex((row) => row.id === detail.surfaceId);
        const next = current.slice();
        const status: SubAgentRow['status'] = detail.status === 'running'
          ? 'running'
          : detail.status === 'completed' || detail.status === 'finished'
            ? 'completed'
            : 'idle';
        const row: SubAgentRow = {
          id: detail.surfaceId,
          label: agentDisplayLabel({ name: detail.name, sessionKey: detail.surfaceId }),
          status,
          detail: detail.detail ?? null,
          updatedAt: Date.now(),
        };
        if (idx >= 0) next[idx] = row; else next.push(row);
        return next.slice(-12);
      });

      const now = Date.now();
      const sinceLast = now - lastRenderRef.current;
      if (sinceLast >= RENDER_THROTTLE_MS) {
        lastRenderRef.current = now;
        setRenderTick((t) => t + 1);
      } else {
        const delay = RENDER_THROTTLE_MS - sinceLast;
        if (throttleTimerRef.current !== null) window.clearTimeout(throttleTimerRef.current);
        throttleTimerRef.current = window.setTimeout(() => {
          throttleTimerRef.current = null;
          lastRenderRef.current = Date.now();
          setRenderTick((t) => t + 1);
        }, delay);
      }
    };

    window.addEventListener('cortex:agent-supervisor-update', handler);
    return () => {
      window.removeEventListener('cortex:agent-supervisor-update', handler);
      if (throttleTimerRef.current !== null) {
        window.clearTimeout(throttleTimerRef.current);
        throttleTimerRef.current = null;
      }
    };
  }, [packet.workspaceTargetPath]);

  const visibleToolCalls = useMemo(
    () => toolCalls.slice(-MAX_TOOL_CALLS_VISIBLE),
    [toolCalls],
  );

  const runningSubAgents = useMemo(() => subAgents.filter((row) => row.status === 'running'), [subAgents]);
  const totalSubAgents = subAgents.length;

  const verifierFinding = packet.review?.findings?.[0] ?? null;

  return (
    <div
      data-living-agent-panel
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
        paddingTop: 12,
        paddingRight: 12,
        paddingBottom: 12,
        paddingLeft: 12,
        fontFamily: 'var(--font-sans-system)',
      }}
    >
      {/* Activity */}
      <SectionFrame label="Activity">
        {visibleToolCalls.length === 0 ? (
          <EmptyHint>Coordinator is quiet. Tool calls will stream in here as they happen.</EmptyHint>
        ) : (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 4,
              minHeight: 30,
            }}
          >
            {visibleToolCalls.map((tc) => {
              const cls = classifyToolCall(tc.name, tc.argument);
              const brainQuestion = tc.argument ? extractO8AskQuestion(tc.argument) : null;
              return (
                <ToolCallChip
                  key={tc.id}
                  verb={cls.verb}
                  kind={cls.kind}
                  argument={brainQuestion ?? tc.argument ?? undefined}
                  status={tc.status}
                />
              );
            })}
          </div>
        )}
      </SectionFrame>

      {/* Sub-agents — reserve min-height so the count update never shifts layout. */}
      <SectionFrame
        label={
          <>
            Background agents
            {totalSubAgents > 0 ? (
              <>
                {' '}
                <span style={{ color: 'var(--t-text-muted)', fontWeight: 500 }}>
                  {runningSubAgents.length} / {totalSubAgents} running
                </span>
              </>
            ) : null}
          </>
        }
      >
        <div style={{ minHeight: 28, display: 'flex', flexDirection: 'column', gap: 2 }}>
          {totalSubAgents === 0 ? (
            <EmptyHint>No sub-agents spawned for this packet yet.</EmptyHint>
          ) : (
            subAgents.map((row) => <SubAgentRowView key={row.id} row={row} />)
          )}
        </div>
      </SectionFrame>

      {/* Verifier (yellow Issues row) */}
      {verifierFinding ? (
        <SectionFrame label="Verifier flagged">
          <div
            role="alert"
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 8,
              paddingTop: 6,
              paddingRight: 10,
              paddingBottom: 6,
              paddingLeft: 10,
              borderRadius: 8,
              borderLeftWidth: 0,
              borderWidth: 1,
              borderStyle: 'solid',
              borderColor: 'var(--t-warning-border, rgba(245, 158, 11, 0.32))',
              background: 'var(--t-warning-bg, rgba(245, 158, 11, 0.08))',
              color: 'var(--t-text)',
              fontSize: 11,
              fontWeight: 500,
              lineHeight: 1.5,
            }}
          >
            <svg width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ flexShrink: 0, marginTop: 2 }}>
              <path d="M12 9v4" />
              <path d="M12 17h.01" />
              <path d="M21.73 18 13.73 4a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3z" />
            </svg>
            <span style={{ minWidth: 0 }}>{verifierFinding.description ?? 'Verifier flagged this packet.'}</span>
          </div>
        </SectionFrame>
      ) : null}
    </div>
  );
}

interface SectionFrameProps {
  label: React.ReactNode;
  children: React.ReactNode;
}

function SectionFrame({ label, children }: SectionFrameProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div
        style={{
          fontSize: 9,
          fontWeight: 700,
          color: 'var(--t-text-muted)',
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
        }}
      >
        {label}
      </div>
      {children}
    </div>
  );
}

function EmptyHint({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: 10.5,
        color: 'var(--t-text-muted)',
        lineHeight: 1.55,
        paddingTop: 2,
      }}
    >
      {children}
    </div>
  );
}

function SubAgentRowView({ row }: { row: SubAgentRow }) {
  const dotColor = row.status === 'running'
    ? '#FF5A1F'
    : row.status === 'completed'
      ? 'var(--t-text-faint, #94a3b8)'
      : 'var(--t-text-faint, #94a3b8)';

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        paddingTop: 4,
        paddingRight: 6,
        paddingBottom: 4,
        paddingLeft: 6,
        borderRadius: 6,
      }}
    >
      <span
        aria-hidden
        style={{
          width: 6,
          height: 6,
          borderRadius: '50%',
          background: dotColor,
          flexShrink: 0,
        }}
      />
      <span
        style={{
          flex: 1,
          minWidth: 0,
          fontSize: 11,
          fontWeight: 500,
          color: 'var(--t-text)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {row.label}
      </span>
      {row.detail ? (
        <span
          style={{
            flexShrink: 0,
            fontSize: 10,
            color: 'var(--t-text-muted)',
            fontFamily: 'var(--font-mono, "SF Mono", Menlo, monospace)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            maxWidth: 80,
          }}
        >
          {row.detail}
        </span>
      ) : null}
    </div>
  );
}

export const LivingAgentPanel = memo(LivingAgentPanelBase);
