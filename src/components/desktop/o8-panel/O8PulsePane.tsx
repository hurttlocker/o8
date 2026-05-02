'use client';

/**
 * O8PulsePane — live fleet temperature surface. Promoted from the retired
 * AmbientPanel/PulseMode into a tab on the wide O8 panel.
 *
 * Four zones, top to bottom:
 *   1. HERO    — running-count + animated pulse dot
 *   2. NOW     — list of in-flight packets (runtime icon · title · branch)
 *   3. MIX     — horizontal stacked bar of running-runtime distribution
 *   4. TODAY   — compact metric row (dispatched / review / merged)
 *
 * Pulls live state from OrchestratorDataContext.
 */

import { memo, useMemo } from 'react';
import { useOrchestratorData } from '@/components/desktop/orchestrator-data-context';
import { CodexIcon, ClaudeIcon, GeminiIcon, OpenCodeIcon } from '@/components/desktop/repo-registry/shared';
import { compactPacketLabel } from '@/lib/workspace-terminal/compact-packet-label';
import type { FleetAgent } from '@/components/desktop/thoughts/types';
import type { OrchestratorMissionState, OrchestratorPacket, OrchestratorRuntime } from '@/lib/orchestrator/types';

const MONO = 'var(--font-mono, "SF Mono", Menlo, monospace)';

const RUNTIME_LABEL: Record<OrchestratorRuntime, string> = {
  codex: 'Codex',
  gemini: 'Gemini',
  'claude-code': 'Claude',
  opencode: 'OpenCode',
};

const RUNTIME_COLOR: Record<OrchestratorRuntime, string> = {
  codex: '#7C3AED',
  gemini: '#3B82F6',
  'claude-code': '#FF8A3D',
  opencode: '#22C55E',
};

function isToday(raw: string | null | undefined): boolean {
  if (!raw) return false;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return false;
  const now = new Date();
  return date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate();
}

function normalizeRuntime(raw: string | null | undefined): OrchestratorRuntime {
  if (raw === 'claude-code' || raw === 'gemini' || raw === 'opencode') return raw;
  return 'codex';
}

function runtimeIcon(runtime: OrchestratorRuntime, size = 12) {
  if (runtime === 'claude-code') return <ClaudeIcon size={size} />;
  if (runtime === 'gemini') return <GeminiIcon size={size} />;
  if (runtime === 'opencode') return <OpenCodeIcon size={size} />;
  return <CodexIcon size={size} />;
}

interface RunningEntry {
  id: string;
  title: string;
  branch: string | null;
  runtime: OrchestratorRuntime;
}

interface PulseStats {
  running: RunningEntry[];
  mixCounts: Record<OrchestratorRuntime, number>;
  totalRunning: number;
  dispatched: number;
  awaiting: number;
  mergedToday: number;
}

function computePulse(missionState: OrchestratorMissionState, agents: FleetAgent[]): PulseStats {
  const packets = missionState.packets;

  const dispatched = packets.filter((packet) => packet.status !== 'draft' || Boolean(packet.lane)).length;
  const awaiting = packets.filter((packet) => packet.status === 'awaiting_review').length;
  const mergedToday = packets.filter((packet) => (
    (packet.releaseState === 'released' || packet.status === 'released')
    && isToday(packet.archivedAt ?? packet.review?.recordedAt ?? packet.lastEventAt)
  )).length;

  const runningKeys = new Set<string>();
  const running: RunningEntry[] = [];
  const mixCounts: Record<OrchestratorRuntime, number> = {
    codex: 0,
    gemini: 0,
    'claude-code': 0,
    opencode: 0,
  };

  for (const packet of packets) {
    if (packet.status !== 'running') continue;
    const key = packet.lane?.sessionKey ?? packet.id;
    if (runningKeys.has(key)) continue;
    runningKeys.add(key);
    const runtime = normalizeRuntime(packet.runtime);
    mixCounts[runtime] += 1;
    running.push({
      id: key,
      title: compactPacketLabel(packet.title) || packet.title,
      branch: packet.branchTarget || null,
      runtime,
    });
  }

  for (const agent of agents) {
    if (agent.status !== 'running') continue;
    const key = agent.sessionKey ?? `${agent.runtime ?? 'codex'}:${agent.name ?? running.length}`;
    if (runningKeys.has(key)) continue;
    runningKeys.add(key);
    const runtime = normalizeRuntime(agent.runtime);
    mixCounts[runtime] += 1;
    const workspaceName = agent.workspace ? agent.workspace.split('/').pop() ?? null : null;
    running.push({
      id: key,
      title: agent.name ?? agent.sessionKey?.split(':').pop()?.slice(0, 14) ?? 'Agent',
      branch: workspaceName,
      runtime,
    });
  }

  return {
    running,
    mixCounts,
    totalRunning: runningKeys.size,
    dispatched,
    awaiting,
    mergedToday,
  };
}

export const O8PulsePane = memo(function O8PulsePane() {
  const data = useOrchestratorData();
  const agents = data?.agents ?? [];
  const missionState: OrchestratorMissionState = data?.missionState ?? {
    version: 2,
    prompt: '',
    summary: '',
    packets: [],
    updatedAt: '',
  };

  const stats = useMemo(() => computePulse(missionState, agents), [missionState, agents]);
  const isIdle = stats.totalRunning === 0
    && stats.dispatched === 0
    && stats.awaiting === 0
    && stats.mergedToday === 0;

  if (!data || isIdle) {
    return <PulseEmpty />;
  }

  return (
    <div
      style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        overflowY: 'auto',
        paddingTop: 14,
        paddingRight: 14,
        paddingBottom: 14,
        paddingLeft: 14,
        gap: 16,
      }}
    >
      <PulseHero running={stats.totalRunning} />
      <NowSection running={stats.running} />
      <MixBar mixCounts={stats.mixCounts} totalRunning={stats.totalRunning} />
      <TodayRow dispatched={stats.dispatched} awaiting={stats.awaiting} mergedToday={stats.mergedToday} />
    </div>
  );
});

// ── Hero ──
function PulseHero({ running }: { running: number }) {
  const live = running > 0;
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-end',
        gap: 10,
        paddingTop: 4,
        paddingBottom: 4,
      }}
    >
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: live ? '#22C55E' : 'var(--t-text-muted)',
          boxShadow: live ? '0 0 0 4px rgba(34, 197, 94, 0.18)' : 'none',
          marginBottom: 8,
          animation: live ? 'o8-pulse 1.6s cubic-bezier(0.22, 1, 0.36, 1) infinite' : 'none',
          flexShrink: 0,
        }}
      />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
        <div
          style={{
            fontFamily: MONO,
            fontSize: 10,
            fontWeight: 500,
            letterSpacing: '0.08em',
            color: 'var(--t-text-muted)',
            textTransform: 'uppercase',
          }}
        >
          [PULSE]
        </div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <span
            style={{
              fontSize: 30,
              fontWeight: 600,
              letterSpacing: '-0.025em',
              color: 'var(--t-text)',
              lineHeight: 1,
              fontFeatureSettings: '"tnum"',
            }}
          >
            {running}
          </span>
          <span
            style={{
              fontSize: 12,
              fontWeight: 500,
              color: 'var(--t-text-muted)',
              letterSpacing: '-0.005em',
            }}
          >
            {running === 1 ? 'agent running' : 'agents running'}
          </span>
        </div>
      </div>
      <style>{`
        @keyframes o8-pulse {
          0%   { box-shadow: 0 0 0 0 rgba(34, 197, 94, 0.36); }
          70%  { box-shadow: 0 0 0 9px rgba(34, 197, 94, 0); }
          100% { box-shadow: 0 0 0 0 rgba(34, 197, 94, 0); }
        }
      `}</style>
    </div>
  );
}

// ── Now Playing ──
function NowSection({ running }: { running: RunningEntry[] }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <SectionLabel>[NOW]</SectionLabel>
      {running.length === 0 ? (
        <div
          style={{
            fontSize: 11.5,
            color: 'var(--t-text-muted)',
            fontStyle: 'italic',
            paddingTop: 4,
            paddingBottom: 4,
          }}
        >
          Idle — no agents running.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {running.map((entry) => (
            <NowRow key={entry.id} entry={entry} />
          ))}
        </div>
      )}
    </div>
  );
}

function NowRow({ entry }: { entry: RunningEntry }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        paddingTop: 8,
        paddingRight: 10,
        paddingBottom: 8,
        paddingLeft: 10,
        borderRadius: 8,
        background: 'var(--t-bg-card)',
        border: '1px solid var(--t-divider-subtle)',
        minWidth: 0,
      }}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: '50%',
          background: RUNTIME_COLOR[entry.runtime],
          boxShadow: `0 0 0 3px ${RUNTIME_COLOR[entry.runtime]}22`,
          flexShrink: 0,
        }}
      />
      <span style={{ display: 'inline-flex', flexShrink: 0 }}>{runtimeIcon(entry.runtime)}</span>
      <span
        style={{
          flex: 1,
          minWidth: 0,
          fontSize: 12,
          fontWeight: 500,
          color: 'var(--t-text)',
          letterSpacing: '-0.01em',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {entry.title}
      </span>
      {entry.branch ? (
        <span
          style={{
            fontFamily: MONO,
            fontSize: 10.5,
            color: 'var(--t-text-muted)',
            background: 'var(--t-input-bg, rgba(0,0,0,0.04))',
            paddingTop: 1,
            paddingRight: 6,
            paddingBottom: 1,
            paddingLeft: 6,
            borderRadius: 4,
            maxWidth: 140,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            flexShrink: 0,
          }}
        >
          {entry.branch}
        </span>
      ) : null}
    </div>
  );
}

// ── Mix Bar ──
function MixBar({ mixCounts, totalRunning }: { mixCounts: Record<OrchestratorRuntime, number>; totalRunning: number }) {
  const order: OrchestratorRuntime[] = ['codex', 'gemini', 'claude-code', 'opencode'];
  const visible = order.filter((rt) => mixCounts[rt] > 0);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <SectionLabel>[MIX]</SectionLabel>
      {totalRunning === 0 ? (
        <div
          style={{
            fontSize: 11.5,
            color: 'var(--t-text-muted)',
            fontStyle: 'italic',
          }}
        >
          No live runtime mix.
        </div>
      ) : (
        <>
          <div
            style={{
              display: 'flex',
              height: 6,
              borderRadius: 3,
              overflow: 'hidden',
              background: 'var(--t-input-bg, rgba(0,0,0,0.04))',
            }}
          >
            {visible.map((rt) => {
              const pct = (mixCounts[rt] / totalRunning) * 100;
              return (
                <div
                  key={rt}
                  style={{
                    width: `${pct}%`,
                    background: RUNTIME_COLOR[rt],
                  }}
                  title={`${RUNTIME_LABEL[rt]} ${mixCounts[rt]}`}
                />
              );
            })}
          </div>
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 12,
              fontSize: 10.5,
              fontFamily: MONO,
              color: 'var(--t-text-muted)',
            }}
          >
            {visible.map((rt) => (
              <span key={rt} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                <span
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: 1.5,
                    background: RUNTIME_COLOR[rt],
                    flexShrink: 0,
                  }}
                />
                <span>{RUNTIME_LABEL[rt]} {mixCounts[rt]}</span>
              </span>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ── Today ──
function TodayRow({ dispatched, awaiting, mergedToday }: { dispatched: number; awaiting: number; mergedToday: number }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <SectionLabel>[TODAY]</SectionLabel>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, 1fr)',
          gap: 8,
        }}
      >
        <Metric value={dispatched} label="Dispatched" />
        <Metric value={awaiting} label="In review" tone={awaiting > 0 ? 'attention' : 'neutral'} />
        <Metric value={mergedToday} label="Merged" tone={mergedToday > 0 ? 'success' : 'neutral'} />
      </div>
    </div>
  );
}

function Metric({ value, label, tone = 'neutral' }: { value: number; label: string; tone?: 'neutral' | 'attention' | 'success' }) {
  const valueColor = tone === 'attention'
    ? '#FF5A1F'
    : tone === 'success'
      ? '#22C55E'
      : 'var(--t-text)';
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-start',
        gap: 2,
        paddingTop: 9,
        paddingRight: 10,
        paddingBottom: 9,
        paddingLeft: 10,
        borderRadius: 8,
        border: '1px solid var(--t-divider-subtle)',
        background: 'var(--t-bg-card)',
      }}
    >
      <div
        style={{
          fontSize: 18,
          fontWeight: 600,
          color: valueColor,
          letterSpacing: '-0.02em',
          lineHeight: 1,
          fontFeatureSettings: '"tnum"',
        }}
      >
        {value}
      </div>
      <div
        style={{
          fontSize: 10,
          color: 'var(--t-text-muted)',
          letterSpacing: '0.02em',
          fontWeight: 500,
        }}
      >
        {label}
      </div>
    </div>
  );
}

// ── Shared bits ──
function SectionLabel({ children }: { children: string }) {
  return (
    <div
      style={{
        fontFamily: MONO,
        fontSize: 9.5,
        fontWeight: 500,
        letterSpacing: '0.10em',
        color: 'var(--t-text-muted)',
        textTransform: 'uppercase',
      }}
    >
      {children}
    </div>
  );
}

function PulseEmpty() {
  return (
    <div
      style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 12,
        paddingLeft: 32,
        paddingRight: 32,
        textAlign: 'center',
      }}
    >
      <div
        style={{
          width: 10,
          height: 10,
          borderRadius: '50%',
          background: 'var(--t-text-muted)',
          opacity: 0.45,
        }}
      />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div
          style={{
            fontFamily: MONO,
            fontSize: 10,
            fontWeight: 500,
            letterSpacing: '0.10em',
            color: 'var(--t-text-muted)',
            textTransform: 'uppercase',
          }}
        >
          [PULSE]
        </div>
        <div
          style={{
            fontSize: 13,
            fontWeight: 500,
            color: 'var(--t-text)',
            letterSpacing: '-0.01em',
          }}
        >
          Fleet idle
        </div>
        <div style={{ fontSize: 11.5, color: 'var(--t-text-muted)', maxWidth: 260, lineHeight: 1.5 }}>
          When agents are dispatched, this surface lights up with live runtime mix and in-flight packets.
        </div>
      </div>
    </div>
  );
}
