'use client';
/* eslint-disable react-hooks/set-state-in-effect, react-hooks/purity --
   the diff-summary fetch sets loading state via the standard useEffect pattern
   (mirrors useRepoCardModel.ts); idle detection uses Date.now() to derive a
   purely visual flag (no render cycle depends on the exact millisecond). */

import { memo, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  resolveFloatingPanelPosition,
  sessionStatusTone,
  type BranchAgent,
} from './shared';

// ─────────────────────────────────────────────────────────────────────
//  Raw single-stroke icons — same policy as RepoStatusHover: Phosphor
//  React components don't render in the Tauri webview, so every glyph
//  is inlined.
// ─────────────────────────────────────────────────────────────────────

function IconSpark({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M12 3v3" />
      <path d="M12 18v3" />
      <path d="M5.6 5.6 7.7 7.7" />
      <path d="m16.3 16.3 2.1 2.1" />
      <path d="M3 12h3" />
      <path d="M18 12h3" />
      <path d="M5.6 18.4 7.7 16.3" />
      <path d="m16.3 7.7 2.1-2.1" />
    </svg>
  );
}

function IconDiff({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M12 4v16" />
      <path d="M4 12h16" />
    </svg>
  );
}

function IconWrench({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M14.7 6.3a4 4 0 0 0 5 5l-3.4 3.4 3.4 3.4a2.8 2.8 0 1 1-4 4l-3.4-3.4L8.9 22a4 4 0 0 1-5-5l3.4-3.4L4 10.3a2.8 2.8 0 1 1 4-4L11.3 9.7Z" />
    </svg>
  );
}

function IconGauge({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M12 13V4" />
      <path d="M4 20a8 8 0 1 1 16 0" />
    </svg>
  );
}

function IconIdle({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5" />
      <path d="m12 12 3 2" />
    </svg>
  );
}

// ─────────────────────────────────────────────────────────────────────
//  Types
// ─────────────────────────────────────────────────────────────────────

interface DiffSummaryResponse {
  additions: number;
  deletions: number;
  fileCount: number;
  worktreePath?: string | null;
  baseBranch?: string | null;
}

export interface AgentStatusHoverProps {
  agent: BranchAgent;
  anchorRect: DOMRect | null;
  worktreePath?: string | null;
  baseBranch?: string | null;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
}

// ─────────────────────────────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────────────────────────────

function formatElapsed(startUnixMs: number | null | undefined) {
  if (!startUnixMs) return null;
  const delta = Math.max(0, Date.now() - startUnixMs);
  const seconds = Math.floor(delta / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    const remSec = seconds % 60;
    return `${minutes}m ${remSec.toString().padStart(2, '0')}s`;
  }
  const hours = Math.floor(minutes / 60);
  const remMin = minutes % 60;
  return `${hours}h ${remMin.toString().padStart(2, '0')}m`;
}

function formatAgoCompact(startUnixMs: number | null | undefined) {
  if (!startUnixMs) return null;
  const delta = Math.max(0, Date.now() - startUnixMs);
  const seconds = Math.floor(delta / 1000);
  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatContextTokens(percent: number | null | undefined) {
  if (typeof percent !== 'number' || percent <= 0) return null;
  // Map context percent onto a rough 1M token window (the default for Claude
  // Opus 4.7 1M and for Codex's GPT-5.4). The UI prefers "143k / 1M" over a
  // bare percent — the scale is what operators actually track.
  const windowTokens = 1_000_000;
  const usedTokens = Math.round((percent / 100) * windowTokens);
  const k = usedTokens / 1000;
  const usedLabel = k >= 100 ? `${Math.round(k)}k` : `${k.toFixed(1).replace(/\.0$/, '')}k`;
  return `${usedLabel} / 1M`;
}

// ─────────────────────────────────────────────────────────────────────
//  Data hook — diff summary (the #1 valuable signal)
// ─────────────────────────────────────────────────────────────────────

function useDiffSummary(params: {
  enabled: boolean;
  sessionKey: string;
  worktreePath: string | null;
  baseBranch: string | null;
}): { state: DiffSummaryResponse | null; loading: boolean } {
  const { enabled, sessionKey, worktreePath, baseBranch } = params;
  const [state, setState] = useState<DiffSummaryResponse | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!enabled) {
      setState(null);
      return;
    }
    let active = true;
    setLoading(true);

    const qs = new URLSearchParams();
    qs.set('sessionKey', sessionKey);
    if (worktreePath) qs.set('worktreePath', worktreePath);
    if (baseBranch) qs.set('baseBranch', baseBranch);

    const controller = new AbortController();
    fetch(`/api/worktrees/diff-summary?${qs.toString()}`, { signal: controller.signal })
      .then((response) => response.json())
      .then((data) => {
        if (!active) return;
        setState({
          additions: data.additions ?? 0,
          deletions: data.deletions ?? 0,
          fileCount: data.fileCount ?? 0,
          worktreePath: data.worktreePath ?? null,
          baseBranch: data.baseBranch ?? null,
        });
      })
      .catch(() => {
        if (active) setState(null);
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [enabled, sessionKey, worktreePath, baseBranch]);

  return { state, loading };
}

// ─────────────────────────────────────────────────────────────────────
//  Rendering primitives
// ─────────────────────────────────────────────────────────────────────

interface RowProps {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  title?: string;
}

function AgentRow({ icon, label, value, title }: RowProps) {
  return (
    <div
      title={title}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        paddingTop: 4,
        paddingBottom: 4,
      }}
    >
      <div
        aria-hidden="true"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 16,
          height: 16,
          flexShrink: 0,
          color: 'var(--t-text-muted)',
        }}
      >
        {icon}
      </div>
      <div
        style={{
          fontSize: 10,
          fontWeight: 600,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          color: 'var(--t-text-faint)',
          width: 78,
          flexShrink: 0,
          fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
        }}
      >
        {label}
      </div>
      <div
        style={{
          flex: 1,
          minWidth: 0,
          fontSize: 12.5,
          fontWeight: 460,
          color: 'var(--t-text)',
          letterSpacing: '-0.005em',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
        }}
      >
        {value}
      </div>
    </div>
  );
}

function MutedValue({ children }: { children: React.ReactNode }) {
  return <span style={{ color: 'var(--t-text-faint)' }}>{children}</span>;
}

// ─────────────────────────────────────────────────────────────────────
//  AgentStatusHover — the full hover card
// ─────────────────────────────────────────────────────────────────────

function AgentStatusHoverBase({
  agent,
  anchorRect,
  worktreePath = null,
  baseBranch = null,
  onMouseEnter,
  onMouseLeave,
}: AgentStatusHoverProps) {
  const cardWidth = 340;
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  const diff = useDiffSummary({
    enabled: Boolean(anchorRect),
    sessionKey: agent.sessionKey,
    worktreePath,
    baseBranch,
  });

  if (!mounted || !anchorRect || typeof document === 'undefined') return null;
  const position = resolveFloatingPanelPosition(anchorRect, cardWidth);

  // ── Stuck detection — no activity for >= 2 minutes with running status ──
  const idleMs = agent.lastActivityAt ? Date.now() - agent.lastActivityAt : 0;
  const isStuck = (agent.status === 'running' || agent.status === 'reviewing')
    && agent.lastActivityAt
    && idleMs >= 120_000;

  const statusTone = sessionStatusTone(agent.status);

  // ── Row values ───────────────────────────────────────────────────
  const currentTask = agent.currentTask?.trim();
  const taskValue = currentTask
    ? <span>{currentTask.length > 120 ? `${currentTask.slice(0, 119)}…` : currentTask}</span>
    : <MutedValue>No active task</MutedValue>;

  const diffValue = diff.loading && !diff.state ? <MutedValue>Loading…</MutedValue>
    : !diff.state ? <MutedValue>No diff</MutedValue>
    : (diff.state.additions === 0 && diff.state.deletions === 0 && diff.state.fileCount === 0)
      ? <MutedValue>No changes yet</MutedValue>
      : (
        <>
          <span style={{ color: '#4ea672' }}>+{diff.state.additions.toLocaleString()}</span>
          <span style={{ padding: '0 4px' }} />
          <span style={{ color: '#c97070' }}>−{diff.state.deletions.toLocaleString()}</span>
          <MutedValue>
            {' · '}{diff.state.fileCount} file{diff.state.fileCount === 1 ? '' : 's'}
          </MutedValue>
        </>
      );

  const toolLabel = agent.activityToolName || agent.activityHeadline;
  const toolFile = agent.activityFilePath;
  const toolAgo = formatAgoCompact(agent.lastActivityAt);
  const toolValue = !toolLabel && !toolFile && !toolAgo
    ? <MutedValue>No tool activity</MutedValue>
    : (
      <>
        {toolLabel ? <span>{toolLabel}</span> : null}
        {toolFile ? (
          <>
            {toolLabel ? <span style={{ padding: '0 4px', color: 'var(--t-text-faint)' }} /> : null}
            <span
              style={{
                fontFamily: '"SF Mono", ui-monospace, Menlo, monospace',
                fontSize: 11.5,
              }}
            >
              {toolFile}
            </span>
          </>
        ) : null}
        {toolAgo ? (
          <MutedValue>
            {(toolLabel || toolFile) ? ' · ' : ''}{toolAgo}
          </MutedValue>
        ) : null}
      </>
    );

  const elapsed = formatElapsed(agent.lastActivityAt);
  const contextLabel = formatContextTokens(agent.contextUsedPercent ?? null);
  const contextPercent = typeof agent.contextUsedPercent === 'number' ? Math.round(agent.contextUsedPercent) : null;
  const contextValue = !contextLabel && !elapsed
    ? <MutedValue>—</MutedValue>
    : (
      <>
        {contextLabel ? (
          <span>{contextLabel}</span>
        ) : contextPercent !== null ? (
          <span>{contextPercent}% ctx</span>
        ) : null}
        {elapsed ? (
          <MutedValue>{contextLabel || contextPercent !== null ? ' · ' : ''}{elapsed}</MutedValue>
        ) : null}
      </>
    );

  return createPortal(
    <div
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      style={{
        position: 'fixed',
        left: position.left,
        top: position.top,
        zIndex: 10000,
        width: cardWidth,
        padding: '14px 16px 12px',
        borderRadius: 12,
        border: '1px solid var(--t-panel-border)',
        background: 'var(--t-panel-solid)',
        boxShadow: 'var(--t-panel-shadow), 0 8px 32px rgba(15, 23, 42, 0.18)',
        color: 'var(--t-text)',
        pointerEvents: 'auto',
        fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
      }}
    >
      {/* Stuck banner — only when the agent has gone quiet while "running". */}
      {isStuck ? (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '6px 10px',
            borderRadius: 8,
            background: 'rgba(210, 135, 135, 0.12)',
            color: '#d28787',
            marginBottom: 10,
          }}
        >
          <IconIdle size={12} />
          <span
            style={{
              fontSize: 10,
              fontWeight: 600,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
            }}
          >
            Idle {Math.floor(idleMs / 60_000)}m
          </span>
        </div>
      ) : null}

      {/* Header — agent name + status + runtime */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3, marginBottom: 10 }}>
        <div
          style={{
            fontSize: 14,
            fontWeight: 600,
            letterSpacing: '-0.012em',
            color: 'var(--t-text)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {agent.agentName || agent.name}
        </div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            fontSize: 11,
            color: 'var(--t-text-muted)',
            letterSpacing: '-0.002em',
          }}
        >
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: statusTone.color,
                flexShrink: 0,
              }}
            />
            <span>{statusTone.label}</span>
          </span>
          <span style={{ color: 'var(--t-text-faint)' }}>·</span>
          <span>{agent.name}</span>
          {agent.model ? (
            <>
              <span style={{ color: 'var(--t-text-faint)' }}>·</span>
              <span
                style={{
                  fontFamily: '"SF Mono", ui-monospace, Menlo, monospace',
                  fontSize: 10.5,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  minWidth: 0,
                }}
              >
                {agent.model}
              </span>
            </>
          ) : null}
        </div>
      </div>

      {/* Divider */}
      <div style={{ height: 1, background: 'var(--t-divider-subtle)', margin: '2px -16px 6px' }} />

      <AgentRow icon={<IconSpark size={13} />} label="Task" value={taskValue} title={currentTask ?? undefined} />
      <AgentRow icon={<IconDiff size={13} />} label="Diff" value={diffValue} />
      <AgentRow icon={<IconWrench size={13} />} label="Last tool" value={toolValue} title={toolFile ?? undefined} />
      <AgentRow icon={<IconGauge size={13} />} label="Context" value={contextValue} />
    </div>,
    document.body,
  );
}

export const AgentStatusHover = memo(AgentStatusHoverBase);
