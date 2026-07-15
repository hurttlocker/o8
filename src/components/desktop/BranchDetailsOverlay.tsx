'use client';

import type { CSSProperties, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { CollapsedRailIcon, ChevronsRightIcon } from './branch-rail-collapse';
import type { PrDetail } from './pr-panel/types';

const ROW_HEIGHT = 28;
const CHECK_ROW_HEIGHT = 24;

/** The O8 right-panel tabs the rail rows can jump to (mirrors onOpenO8Panel). */
export type OverlayPanelTab =
  | 'workspace'
  | 'prs'
  | 'inbox'
  | 'activity'
  | 'spec'
  | 'browser'
  | 'review'
  | 'compare';

export type ProgressRowData = { label: string; done: boolean; muted?: boolean };
export type PrChecksSummary = { label: string; danger: boolean } | null;

export interface BranchDetailsOverlayProps {
  /** Open state — drives the morph in/out. The overlay stays mounted and
   *  cross-fades so the capsule can morph into it (and back) both ways. */
  open: boolean;
  /** Bounding rect of the in-layout capsule the overlay anchors to. */
  anchorRect: DOMRect;
  /** Hover-bridge: keep the overlay open while the cursor is inside it. */
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  /** The » control unpins (collapsed → true). */
  onToggleCollapsed?: () => void;
  // Progress card
  progressHint: string;
  progressRows: ProgressRowData[];
  progressOpen: boolean;
  onToggleProgress: () => void;
  // Environment card
  environmentOpen: boolean;
  onToggleEnvironment: () => void;
  hasDiff: boolean;
  additions: number;
  deletions: number;
  changesFileCount: number;
  branch: string;
  // Pull request card
  prDetail: PrDetail | null;
  prChecks: PrChecksSummary;
  prCommentCount: number;
  // Subagents card
  subagentLabel: string | null | undefined;
  subagentDanger: boolean;
  onSelectSubagent: () => void;
  // Browser card
  browserHost?: string;
  // Sources card — the links the USER put into THIS conversation (not agent
  // tool integrations). Empty when the chat has no sources.
  sources?: Array<{ label: string; href: string }>;
  /** Open a source link in the right-side browser panel. */
  onOpenSource?: (href: string) => void;
  // Hidden audit hook
  runtimeLabelText: string;
  onOpenTab: (tab: OverlayPanelTab) => void;
}

const OVERLAY_WIDTH = 256;
const OVERLAY_MARGIN = 8;
const OVERLAY_EASE = 'cubic-bezier(0.22, 1, 0.36, 1)';

/**
 * The expanded branch-details card stack, rendered as a floating overlay
 * (Cursor-style git/environment popover, Q ruling 2026-07-14). It portals to
 * document.body to escape the rail's `overflow:hidden` ancestor, right-aligns
 * to the in-layout capsule, and extends LEFTWARD over the chat — so revealing
 * it never pushes the composer. Hover-bridge + pin logic lives in the caller
 * (BranchDetailsLauncher); this component only positions, animates, and renders.
 */
export function BranchDetailsOverlay(props: BranchDetailsOverlayProps) {
  const {
    open,
    anchorRect,
    onMouseEnter,
    onMouseLeave,
    onToggleCollapsed,
    progressHint,
    progressRows,
    progressOpen,
    onToggleProgress,
    environmentOpen,
    onToggleEnvironment,
    hasDiff,
    additions,
    deletions,
    changesFileCount,
    branch,
    prDetail,
    prChecks,
    prCommentCount,
    subagentLabel,
    subagentDanger,
    onSelectSubagent,
    browserHost,
    sources = [],
    onOpenSource,
    runtimeLabelText,
    onOpenTab,
  } = props;

  if (typeof document === 'undefined') return null;

  const viewportWidth = typeof window === 'undefined' ? 1440 : window.innerWidth;
  const viewportHeight = typeof window === 'undefined' ? 900 : window.innerHeight;
  const top = Math.max(OVERLAY_MARGIN, anchorRect.top);
  const right = Math.max(OVERLAY_MARGIN, viewportWidth - anchorRect.right);
  const maxHeight = Math.max(160, viewportHeight - top - OVERLAY_MARGIN);

  return createPortal(
    <div
      className="hide-scrollbar"
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      style={{
        position: 'fixed',
        top,
        right,
        width: OVERLAY_WIDTH,
        maxHeight,
        zIndex: 10000,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        paddingTop: 8,
        paddingRight: 10,
        paddingBottom: 12,
        paddingLeft: 10,
        overflowY: 'auto',
        scrollbarWidth: 'none',
        borderRadius: 14,
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: 'var(--t-border-subtle, var(--t-border))',
        // Opaque paper surface so the chat never bleeds through (--t-chat-surface-bg
        // is pinned solid in every palette × surface). The card reads as an
        // elevated panel over the chat, not a translucent scrim.
        background: 'var(--t-chat-surface-bg)',
        boxShadow: 'var(--t-panel-shadow), 0 8px 30px rgba(15, 23, 42, 0.18)',
        color: 'var(--t-text)',
        // Morph: scale up out of the capsule's top-right corner on open, and back
        // down into it on close (the capsule cross-fades in the launcher). The
        // overlay stays mounted so both directions animate.
        opacity: open ? 1 : 0,
        transform: open ? 'scale(1)' : 'scale(0.9)',
        transformOrigin: 'top right',
        transition: `opacity 150ms ${OVERLAY_EASE}, transform 150ms ${OVERLAY_EASE}`,
        pointerEvents: open ? 'auto' : 'none',
      }}
    >
      {/* » folds the overlay away (unpins → collapsed=true). */}
      {onToggleCollapsed ? (
        <div style={{ display: 'flex', justifyContent: 'flex-end', flexShrink: 0 }}>
          <CollapsedRailIcon title="Collapse" onClick={onToggleCollapsed}><ChevronsRightIcon /></CollapsedRailIcon>
        </div>
      ) : null}

      <Card>
        <SectionHeader
          label="Progress"
          hint={progressHint}
          open={progressOpen}
          onClick={onToggleProgress}
        />
        {progressOpen ? (
          <div style={{ paddingTop: 2, paddingBottom: 4 }}>
            {progressRows.map((row) => (
              <ProgressRow key={row.label} label={row.label} done={row.done} muted={row.muted} />
            ))}
          </div>
        ) : null}
      </Card>

      <Card>
        <SectionHeader
          label="Environment"
          open={environmentOpen}
          onClick={onToggleEnvironment}
          metric={hasDiff ? <DiffStats additions={additions} deletions={deletions} /> : null}
          action={<GearIcon />}
        />
        {environmentOpen ? (
          <div style={{ paddingTop: 2, paddingBottom: 3 }}>
            <Row icon={<DiffIcon />} label="Changes" detail={changesFileCount > 0 ? `${changesFileCount}` : undefined} onClick={() => onOpenTab('workspace')} />
            <Row icon={<LaptopIcon />} label="Local" onClick={() => onOpenTab('workspace')} />
            <Row icon={<BranchIcon />} label={branch} onClick={() => onOpenTab('workspace')} />
            <Row icon={<CommitIcon />} label="Commit" onClick={() => onOpenTab('workspace')} />
            <Row icon={<GhIcon />} label="Create pull request" onClick={() => onOpenTab('prs')} />
          </div>
        ) : null}
      </Card>

      {prDetail ? (
        <Card>
          <StaticHeader label="Pull request" />
          <Row
            icon={<GhIcon />}
            label={`#${prDetail.number} ${prDetail.title}`}
            onClick={() => onOpenTab('prs')}
          />
          <Row
            icon={<DiffIcon />}
            label={`+${prDetail.additions} −${prDetail.deletions}`}
            detail={`${prDetail.changedFiles} file${prDetail.changedFiles === 1 ? '' : 's'}`}
            onClick={() => onOpenTab('prs')}
          />
          {!prDetail.mergeable ? (
            <Row icon={<ConflictIcon />} label="Conflicts with base" tone="danger" onClick={() => onOpenTab('prs')} />
          ) : null}
          {prChecks ? (
            prChecks.danger ? (
              <Row icon={<ChecksIcon />} label={prChecks.label} tone="danger" onClick={() => onOpenTab('prs')} />
            ) : (
              <StaticRow icon={<ChecksIcon />} label={prChecks.label} />
            )
          ) : null}
          {prCommentCount > 0 ? (
            <Row
              icon={<CommentIcon />}
              label={`${prCommentCount} comment${prCommentCount === 1 ? '' : 's'}`}
              onClick={() => onOpenTab('prs')}
            />
          ) : null}
        </Card>
      ) : null}

      <Card>
        <StaticHeader label="Subagents" />
        {subagentLabel ? (
          <Row
            icon={<WorkerIcon />}
            label={`${subagentLabel} (worker)`}
            onClick={onSelectSubagent}
            tone={subagentDanger ? 'danger' : undefined}
          />
        ) : (
          <StaticRow icon={<WorkerIcon />} label="No active subagents" muted />
        )}
      </Card>

      <Card>
        <StaticHeader label="Browser" />
        <Row icon={<GlobeIcon />} label="o8" detail={browserHost} onClick={() => onOpenTab('browser')} />
      </Card>

      <Card>
        <StaticHeader label="Sources" />
        {sources.length === 0 ? (
          <StaticRow icon={<LinkIcon />} label="No sources yet" muted />
        ) : (
          sources.map((source) => (
            <Row
              key={source.href}
              icon={<LinkIcon />}
              label={source.label}
              onClick={() => onOpenSource?.(source.href)}
            />
          ))
        )}
      </Card>

      <span style={{ display: 'none' }} aria-hidden data-runtime={runtimeLabelText} />
    </div>,
    document.body,
  );
}

function Card({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        borderRadius: 12,
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: 'color-mix(in srgb, var(--t-border-subtle, var(--t-border)) 55%, transparent)',
        background: 'color-mix(in srgb, var(--t-bg-card) 70%, transparent)',
        paddingTop: 6,
        paddingBottom: 4,
        paddingLeft: 4,
        paddingRight: 4,
        display: 'flex',
        flexDirection: 'column',
        flexShrink: 0,
      }}
    >
      {children}
    </div>
  );
}

function StaticHeader({ label }: { label: string }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        minHeight: 22,
        paddingLeft: 10,
        paddingRight: 10,
        paddingBottom: 4,
        fontSize: 10,
        fontWeight: 300,
        letterSpacing: '-0.1px',
        lineHeight: '14px',
        color: 'var(--t-text-faint)',
      }}
    >
      {label}
    </div>
  );
}

function SectionHeader({
  label,
  hint,
  action,
  metric,
  open,
  onClick,
}: {
  label: string;
  hint?: string;
  action?: ReactNode;
  metric?: ReactNode;
  open: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        width: '100%',
        minHeight: 24,
        paddingLeft: 10,
        paddingRight: 10,
        paddingTop: 0,
        paddingBottom: 4,
        border: 0,
        borderRadius: 8,
        background: 'transparent',
        fontSize: 10,
        fontWeight: 300,
        letterSpacing: '-0.1px',
        lineHeight: '14px',
        color: 'var(--t-text-faint)',
        fontFamily: 'inherit',
        textAlign: 'left',
        cursor: 'pointer',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = 'color-mix(in srgb, var(--t-text-muted) 7%, transparent)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'transparent';
      }}
    >
      <span>{label}</span>
      <span
        style={{
          display: 'inline-flex',
          transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
          transition: 'transform 160ms cubic-bezier(0.22, 1, 0.36, 1)',
          color: 'var(--t-text-muted)',
          opacity: 0.8,
        }}
      >
        <ChevronIcon />
      </span>
      {hint ? (
        <span
          style={{
            fontSize: 9.5,
            fontWeight: 260,
            letterSpacing: '-0.4px',
            color: 'var(--t-text-faint)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            minWidth: 0,
            flex: 1,
            textAlign: 'right',
          }}
          title={hint}
        >
          {hint}
        </span>
      ) : null}
      {metric ? (
        <span style={{ marginLeft: 'auto', display: 'inline-flex' }}>
          {metric}
        </span>
      ) : null}
      {action ? (
        <span
          onClick={(event) => event.stopPropagation()}
          style={{ display: 'inline-flex', color: 'var(--t-text-muted)' }}
        >
          {action}
        </span>
      ) : null}
    </button>
  );
}

function DiffStats({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        fontSize: 9.5,
        fontWeight: 300,
        letterSpacing: '-0.2px',
        fontVariantNumeric: 'tabular-nums',
      }}
    >
      <span style={{ color: 'var(--t-terminal-ansi-bright-green, #22c55e)' }}>+{additions}</span>
      <span style={{ color: 'var(--t-terminal-ansi-bright-red, #ef4444)' }}>-{deletions}</span>
    </span>
  );
}

function ProgressRow({ label, done, muted }: { label: string; done: boolean; muted?: boolean }) {
  return (
    <div
      style={{
        minHeight: CHECK_ROW_HEIGHT,
        paddingLeft: 10,
        paddingRight: 10,
        display: 'flex',
        alignItems: 'center',
        gap: 9,
        color: muted ? 'var(--t-text-faint)' : 'var(--t-text)',
        fontSize: 13.5,
        fontWeight: 300,
        lineHeight: 1.25,
        letterSpacing: '-0.1px',
      }}
    >
      <span
        style={{
          width: 12,
          height: 12,
          borderRadius: 999,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
          color: done ? 'var(--t-bg-card)' : 'var(--t-text-faint)',
          background: done
            ? 'color-mix(in srgb, var(--t-text-muted) 72%, transparent)'
            : 'color-mix(in srgb, var(--t-text-muted) 10%, transparent)',
        }}
      >
        {done ? <CheckIcon /> : null}
      </span>
      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
    </div>
  );
}

const ROW_BASE: CSSProperties = {
  height: ROW_HEIGHT,
  paddingLeft: 10,
  paddingRight: 10,
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  borderRadius: 8,
  borderWidth: 0,
  background: 'transparent',
  cursor: 'pointer',
  textAlign: 'left',
  fontSize: 13.5,
  fontWeight: 300,
  letterSpacing: '-0.1px',
  lineHeight: 1.25,
  color: 'var(--t-text)',
  fontFamily: 'inherit',
};

function Row({
  icon,
  label,
  detail,
  onClick,
  muted = false,
  tone,
}: {
  icon: ReactNode;
  label: string;
  detail?: string;
  onClick: () => void;
  muted?: boolean;
  tone?: 'danger';
}) {
  return (
    <button
      onClick={onClick}
      style={{
        ...ROW_BASE,
        color: tone === 'danger' ? '#dc2626' : muted ? 'var(--t-text-muted)' : 'var(--t-text)',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = 'var(--t-panel-hover)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'transparent';
      }}
    >
      <span style={{ display: 'inline-flex', flexShrink: 0, color: muted ? 'var(--t-text-muted)' : 'var(--t-text-secondary)' }}>{icon}</span>
      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
      {detail ? <span style={{ color: 'var(--t-text-faint)', fontSize: 9.5, fontWeight: 260, letterSpacing: '-0.4px', whiteSpace: 'nowrap' }}>{detail}</span> : null}
    </button>
  );
}

function StaticRow({ icon, label, muted = false }: { icon: ReactNode; label: string; muted?: boolean }) {
  return (
    <div
      style={{
        ...ROW_BASE,
        cursor: 'default',
        color: muted ? 'var(--t-text-muted)' : 'var(--t-text)',
      }}
    >
      <span style={{ display: 'inline-flex', flexShrink: 0, color: 'var(--t-text-muted)' }}>{icon}</span>
      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
    </div>
  );
}

function svgProps(size = 15): { width: number; height: number; viewBox: string; fill: string; stroke: string; strokeWidth: number; strokeLinecap: 'round'; strokeLinejoin: 'round' } {
  return { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' };
}

export function DiffIcon() {
  return (
    <svg {...svgProps()}>
      <rect x="4" y="4" width="16" height="16" rx="3" />
      <path d="M12 8v8M8 12h8" />
    </svg>
  );
}

function LaptopIcon() {
  return (
    <svg {...svgProps()}>
      <rect x="4" y="5" width="16" height="11" rx="2" />
      <path d="M3 19h18" />
      <path d="M8 16h8" />
    </svg>
  );
}

function BranchIcon() {
  return (
    <svg {...svgProps()}>
      <circle cx="6" cy="6" r="2" />
      <circle cx="6" cy="18" r="2" />
      <circle cx="18" cy="8" r="2" />
      <path d="M6 8v8" />
      <path d="M18 10v2a4 4 0 0 1-4 4H8" />
    </svg>
  );
}

function CommitIcon() {
  return (
    <svg {...svgProps()}>
      <path d="M3 12h6" />
      <circle cx="12" cy="12" r="3" />
      <path d="M15 12h6" />
    </svg>
  );
}

export function WorkerIcon() {
  return (
    <svg {...svgProps()}>
      <rect x="7" y="4" width="10" height="8" rx="3" />
      <circle cx="9.5" cy="8" r=".6" fill="currentColor" stroke="none" />
      <circle cx="14.5" cy="8" r=".6" fill="currentColor" stroke="none" />
      <path d="M8 18a4 4 0 0 1 8 0" />
      <path d="M12 12v2" />
    </svg>
  );
}

export function LinkIcon() {
  return (
    <svg {...svgProps()}>
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </svg>
  );
}

export function GhIcon() {
  return (
    <svg {...svgProps()}>
      <path d="M9 19c-4 1.5-4-2-6-2" />
      <path d="M15 21v-3.4a3 3 0 0 0-.84-2.32C17.06 14.92 19 13.46 19 9.5a4.65 4.65 0 0 0-.88-3 4.3 4.3 0 0 0-.12-3s-1-.32-3.3 1.24a11.4 11.4 0 0 0-6 0C6.4 3.16 5.4 3.5 5.4 3.5a4.3 4.3 0 0 0-.12 3A4.65 4.65 0 0 0 4.4 9.5c0 3.95 1.93 5.42 4.84 5.78A3 3 0 0 0 8.4 17.6V21" />
    </svg>
  );
}

export function GlobeIcon() {
  return (
    <svg {...svgProps()}>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
    </svg>
  );
}

export function ChecksIcon() {
  return (
    <svg {...svgProps()}>
      <circle cx="12" cy="12" r="9" />
      <path d="m8.5 12 2.5 2.5 4.5-5" />
    </svg>
  );
}

function ConflictIcon() {
  return (
    <svg {...svgProps()}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8v4" />
      <path d="M12 16h.01" />
    </svg>
  );
}

function CommentIcon() {
  return (
    <svg {...svgProps()}>
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg {...svgProps()}>
      <path d="M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.05.05a2 2 0 1 1-2.83 2.83l-.05-.05A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6V20a2 2 0 1 1-4 0v-.08a1.7 1.7 0 0 0-1-.6 1.7 1.7 0 0 0-1.88.34l-.05.05a2 2 0 1 1-2.83-2.83l.05-.05A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.6-1H4a2 2 0 1 1 0-4h.08a1.7 1.7 0 0 0 .6-1 1.7 1.7 0 0 0-.34-1.88l-.05-.05a2 2 0 1 1 2.83-2.83l.05.05A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.6V4a2 2 0 1 1 4 0v.08a1.7 1.7 0 0 0 1 .6 1.7 1.7 0 0 0 1.88-.34l.05-.05a2 2 0 1 1 2.83 2.83l-.05.05A1.7 1.7 0 0 0 19.4 9c.24.35.44.68.6 1H20a2 2 0 1 1 0 4h-.08c-.16.32-.36.65-.52 1Z" />
    </svg>
  );
}

function ChevronIcon() {
  return (
    <svg {...svgProps(14)}>
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
      <path d="m5 12 4 4 10-10" />
    </svg>
  );
}

export function SquaresIcon() {
  return (
    <svg {...svgProps()}>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </svg>
  );
}
