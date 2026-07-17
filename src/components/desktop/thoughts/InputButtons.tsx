import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ComposerChipCompactContext } from './composer-compact-context';
import { ComposerPopover } from './chat-panel/ComposerPopover';
import { AttachFilesButton } from './AttachFilesButton';
import type { ComposerMode } from './composer-mode';
import { MicButton } from './MicButton';
import { SessionRulesChip } from './SessionRulesChip';
import { ModelThinkingChip } from './ModelThinkingChip';
import type { OrchestratorBackendSetting } from './operator-defaults';
import type { OrchestratorWorkspaceTarget } from '@/lib/orchestrator/types';
import { type ThinkingEffort } from '@/lib/orchestrator/thinking-effort';

const EFFORT_LABELS: Record<ThinkingEffort, string> = {
  adaptive: 'adaptive',
  low: 'low',
  medium: 'medium',
  high: 'high',
  max: 'max',
  xhigh: 'xhigh',
  ultra: 'ultra',
};
// xhigh stays in the menu but reads as a sibling option to max, NOT as
// "even better than max". max gets the brand orange to anchor it as the
// climax tier; xhigh gets a muted dot so it doesn't outshine max.
const EFFORT_OPTIONS: ThinkingEffort[] = ['adaptive', 'low', 'medium', 'high', 'xhigh', 'max'];
const EFFORT_DOT: Record<ThinkingEffort, string> = {
  adaptive: 'var(--t-text-faint)',
  low: 'var(--t-text-faint)',
  medium: 'var(--t-text-muted)',
  high: 'var(--t-text-muted)',
  xhigh: 'var(--t-text-muted)',
  max: '#FF5A1F',
  ultra: '#FF5A1F',
};
/**
 * Thinking effort control — Rams pill matching ThreadsDropdown aesthetic.
 * <details>-based popover that opens UPWARD (bottom: 30) so it never
 * collides with the bottom edge of the composer.
 */
export function ThinkingChip({
  effort = 'adaptive',
  adaptiveEnabled = true,
  onChange,
}: {
  effort?: ThinkingEffort;
  adaptiveEnabled?: boolean;
  onChange?: (next: ThinkingEffort) => void;
}) {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const label = EFFORT_LABELS[effort];
  const dotColor = EFFORT_DOT[effort];
  const options = adaptiveEnabled ? EFFORT_OPTIONS : EFFORT_OPTIONS.filter((option) => option !== 'adaptive');

  const menuItem = (option: ThinkingEffort) => {
    const active = option === effort;
    return (
      <button
        key={option}
        type="button"
        onClick={() => { detailsRef.current?.removeAttribute('open'); onChange?.(option); }}
        style={{
          height: 28, paddingTop: 0, paddingRight: 10, paddingBottom: 0, paddingLeft: 10, borderWidth: 0,
          background: active ? 'var(--t-accent-soft)' : 'transparent',
          color: active ? 'var(--t-accent)' : 'var(--t-text)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
          cursor: 'pointer', fontSize: 12, fontWeight: 400,
          fontFamily: "'iA Writer Mono', 'JetBrains Mono', 'SF Mono', Menlo, ui-monospace, monospace",
        }}
      >
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <span
            aria-hidden="true"
            style={{ width: 6, height: 6, borderRadius: 999, background: EFFORT_DOT[option] }}
          />
          <span>{EFFORT_LABELS[option]}</span>
        </span>
        {active ? <span style={{ fontSize: 11, color: 'var(--t-accent)' }}>•</span> : null}
      </button>
    );
  };

  return (
    <details ref={detailsRef} style={{ position: 'relative', flexShrink: 0 }}>
      <summary
        title={`Thinking ${label}`}
        style={{
          listStyle: 'none',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 8,
          height: 26,
          paddingLeft: 8,
          paddingRight: 8,
          borderRadius: 8,
          borderWidth: 1,
          borderStyle: 'solid',
          borderColor: 'var(--t-border)',
          background: 'transparent',
          color: 'var(--t-text-muted)',
          cursor: 'pointer',
          minWidth: 0,
          fontSize: 11.5,
          fontWeight: 400,
          letterSpacing: '0.01em',
          whiteSpace: 'nowrap',
          fontVariantNumeric: 'tabular-nums',
          fontFamily: "'iA Writer Mono', 'JetBrains Mono', 'SF Mono', Menlo, ui-monospace, monospace",
        }}
      >
        <span
          aria-hidden="true"
          style={{ width: 6, height: 6, borderRadius: 999, flexShrink: 0, background: dotColor }}
        />
        <span style={{ color: 'var(--t-text-muted)' }}>thinking</span>
        <span style={{ color: 'var(--t-text)' }}>{label}</span>
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
      </summary>
      <div
        style={{
          position: 'absolute', bottom: 30, left: 0, width: 156,
          paddingTop: 4, paddingRight: 4, paddingBottom: 4, paddingLeft: 4,
          borderRadius: 10, borderWidth: 1, borderStyle: 'solid',
          borderColor: 'var(--t-border)', background: 'var(--t-panel)',
          backdropFilter: 'blur(18px) saturate(1.3)', boxShadow: 'var(--t-panel-shadow)',
          display: 'flex', flexDirection: 'column', gap: 2, zIndex: 20,
        }}
      >
        {options.map((option) => menuItem(option))}
      </div>
    </details>
  );
}

/**
 * InputToolbar — sits below the textarea inside the composer container.
 *
 *   [▊▊▊ effort] [model label] [✦ enhance]         [+ attach] [↑ send]
 */
export type { ThinkingEffort };

function repoPathLabel(path: string | null | undefined): string | null {
  if (!path?.trim()) return null;
  return path.split('/').filter(Boolean).pop() ?? path;
}

function repoGroupLabel(target: OrchestratorWorkspaceTarget): string {
  return target.repoName?.trim() || repoPathLabel(target.localPath) || target.label;
}

function repoTargetRowLabel(target: OrchestratorWorkspaceTarget, groupLabel: string): string {
  if (!target.isWorktree) return 'Base repo';
  if (target.branch?.trim()) return target.branch;

  const pathLabel = repoPathLabel(target.localPath);
  if (pathLabel && pathLabel !== groupLabel) return pathLabel;

  const prefix = `${groupLabel} · `;
  return target.label.startsWith(prefix) ? target.label.slice(prefix.length) : target.label;
}

function compactRepoPath(path: string): string {
  return path.replace(/^\/Users\/[^/]+/, '~');
}

const REPO_TARGET_MENU_WIDTH = 320;
const REPO_TARGET_MENU_HEIGHT = 280;

function RepoTargetChip({
  repoLabel,
  workspaceTargets,
  selectedRepoPath,
  onSelectRepoPath,
}: {
  repoLabel?: string | null;
  workspaceTargets?: OrchestratorWorkspaceTarget[];
  selectedRepoPath?: string | null;
  onSelectRepoPath?: (next: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const targets = useMemo(() => workspaceTargets ?? [], [workspaceTargets]);
  const targetGroups = useMemo(() => {
    const groups = new Map<string, {
      key: string;
      label: string;
      targets: Array<{ target: OrchestratorWorkspaceTarget; index: number }>;
    }>();

    targets.forEach((target, index) => {
      const label = repoGroupLabel(target);
      const key = label.toLowerCase();
      const group = groups.get(key) ?? {
        key,
        label,
        targets: [],
      };
      group.targets.push({ target, index });
      groups.set(key, group);
    });

    return Array.from(groups.values()).map((group) => ({
      key: group.key,
      label: group.label,
      targets: group.targets
        .sort((a, b) => {
          const aRank = a.target.isWorktree ? 1 : 0;
          const bRank = b.target.isWorktree ? 1 : 0;
          return aRank === bRank ? a.index - b.index : aRank - bRank;
        })
        .map(({ target }) => target),
    }));
  }, [targets]);
  const selectedTarget = useMemo(
    () => targets.find((target) => target.localPath === selectedRepoPath) ?? null,
    [selectedRepoPath, targets],
  );
  const label = selectedTarget?.label
    ?? repoLabel
    ?? repoPathLabel(selectedRepoPath)
    ?? (targets[0]?.label ?? null);
  const canSelect = targets.length > 0 && Boolean(onSelectRepoPath);
  const showingAffordance = canSelect && (hovered || focused || open);

  if (!label) return null;

  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', minWidth: 0 }}>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => { if (canSelect) setOpen((value) => !value); }}
        onPointerEnter={() => setHovered(true)}
        onPointerLeave={() => setHovered(false)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        disabled={!canSelect}
        title={selectedRepoPath ? `Chat target: ${selectedRepoPath}` : 'Chat target'}
        aria-haspopup="listbox"
        aria-expanded={open}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          maxWidth: 180,
          height: 22,
          paddingTop: 0,
          paddingRight: canSelect ? 6 : 0,
          paddingBottom: 0,
          paddingLeft: canSelect ? 6 : 0,
          borderWidth: 1,
          borderStyle: 'solid',
          borderColor: showingAffordance ? 'rgba(37, 99, 235, 0.16)' : 'transparent',
          borderRadius: 7,
          background: showingAffordance ? 'rgba(37, 99, 235, 0.055)' : 'transparent',
          color: showingAffordance ? 'var(--t-text-muted)' : 'var(--t-text-faint)',
          cursor: canSelect ? 'pointer' : 'default',
          outline: focused && canSelect ? '2px solid rgba(37, 99, 235, 0.14)' : 'none',
          outlineOffset: 1,
          fontSize: 10.5,
          fontWeight: 300,
          letterSpacing: '-0.1px',
          whiteSpace: 'nowrap',
          fontFamily: 'var(--font-sans-system)',
          transition: 'background 180ms cubic-bezier(0.22, 1, 0.36, 1), border-color 180ms cubic-bezier(0.22, 1, 0.36, 1), color 180ms cubic-bezier(0.22, 1, 0.36, 1)',
        }}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {label}
        </span>
        {canSelect ? (
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0, opacity: showingAffordance ? 0.92 : 0.58, transition: 'opacity 180ms cubic-bezier(0.22, 1, 0.36, 1)' }}>
            <path d="m6 9 6 6 6-6" />
          </svg>
        ) : null}
      </button>

      <ComposerPopover anchorRef={buttonRef} open={open} onClose={() => setOpen(false)} align="start">
        <div
          role="listbox"
          aria-label="Chat target repo"
          style={{
            width: REPO_TARGET_MENU_WIDTH,
            maxHeight: REPO_TARGET_MENU_HEIGHT,
            overflowY: 'auto',
            scrollbarWidth: 'none',
            paddingTop: 5,
            paddingRight: 5,
            paddingBottom: 5,
            paddingLeft: 5,
            borderRadius: 12,
            borderWidth: 1,
            borderStyle: 'solid',
            borderColor: 'var(--t-border)',
            background: 'var(--t-panel)',
            backdropFilter: 'blur(18px) saturate(1.3)',
            boxShadow: 'var(--t-panel-shadow)',
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
          }}
        >
          {targetGroups.map((group) => {
            const groupActive = group.targets.some((target) => target.localPath === selectedRepoPath);
            return (
              <div
                key={group.key}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 2,
                  paddingTop: 3,
                  paddingBottom: 3,
                }}
              >
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'minmax(0, 1fr) auto',
                    alignItems: 'center',
                    columnGap: 8,
                    paddingTop: 4,
                    paddingRight: 8,
                    paddingBottom: 3,
                    paddingLeft: 8,
                    color: groupActive ? 'var(--t-accent)' : 'var(--t-text-muted)',
                    fontFamily: 'var(--font-sans-system)',
                  }}
                >
                  <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 10, fontWeight: 300, letterSpacing: '-0.1px' }}>
                    {group.label}
                  </span>
                  <span style={{ fontSize: 9, fontWeight: 300, color: 'var(--t-text-faint)', letterSpacing: '-0.1px' }}>
                    {group.targets.length === 1 ? '1 target' : `${group.targets.length} targets`}
                  </span>
                </div>
                {group.targets.map((target, index) => {
                  const active = target.localPath === selectedRepoPath;
                  const targetLabel = repoTargetRowLabel(target, group.label);
                  return (
                    <button
                      key={`${target.id}:${target.localPath}:${target.branch ?? 'default'}:${index}`}
                      type="button"
                      role="option"
                      aria-selected={active}
                      onClick={() => {
                        onSelectRepoPath?.(target.localPath);
                        setOpen(false);
                      }}
                      style={{
                        width: '100%',
                        display: 'grid',
                        gridTemplateColumns: 'minmax(0, 1fr) auto',
                        columnGap: 10,
                        rowGap: 2,
                        alignItems: 'center',
                        paddingTop: 6,
                        paddingRight: 9,
                        paddingBottom: 6,
                        paddingLeft: 12,
                        borderWidth: 0,
                        borderRadius: 9,
                        background: active ? 'var(--t-accent-soft)' : 'rgba(255, 255, 255, 0.02)',
                        color: active ? 'var(--t-accent)' : 'var(--t-text)',
                        cursor: 'pointer',
                        textAlign: 'left',
                        fontFamily: 'var(--font-sans-system)',
                      }}
                    >
                      <span style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                        <span style={{ fontSize: 13.5, fontWeight: 300, letterSpacing: '-0.1px', lineHeight: 1.25, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {targetLabel}
                        </span>
                        <span style={{ fontSize: 9.5, fontWeight: 260, letterSpacing: '-0.4px', color: 'var(--t-text-faint)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: "'iA Writer Mono', 'JetBrains Mono', 'SF Mono', Menlo, ui-monospace, monospace" }}>
                          {compactRepoPath(target.localPath)}
                        </span>
                      </span>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ fontSize: 9.5, fontWeight: 300, letterSpacing: '-0.2px', color: active ? 'var(--t-accent)' : 'var(--t-text-faint)', fontFamily: "'iA Writer Mono', 'JetBrains Mono', 'SF Mono', Menlo, ui-monospace, monospace" }}>
                          {target.isWorktree ? 'worktree' : 'base'}
                        </span>
                        <span
                          aria-hidden="true"
                          style={{
                            width: 6,
                            height: 6,
                            borderRadius: 999,
                            background: active ? 'var(--t-accent)' : 'transparent',
                            boxShadow: active ? '0 0 0 3px var(--t-accent-soft)' : 'none',
                          }}
                        />
                      </span>
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      </ComposerPopover>
    </div>
  );
}

export function InputButtons({
  input,
  onSubmit,
  modelLabel,
  modelId,
  onModelChange,
  activeBackend,
  onBackendChange,
  effort = 'adaptive',
  onEffortChange,
  adaptiveEnabled = true,
  swarmEnabled = false,
  onSetSwarm,
  collideEnabled = false,
  onSetCollide,
  sessionRulesThreadId,
  repoLabel,
  displayMessagesCount = 0,
  working = false,
  onStop,
  onUploadDiskFiles,
  onFileReferenceSelect,
  composerMode,
  onComposerModeChange,
  repoPath,
  workspaceTargets,
  selectedRepoPath,
  onSelectRepoPath,
  inlineLeadingExtras,
  inlineMeterSlot,
}: {
  input: string;
  enhancing: boolean;
  preEnhanceInput: string | null;
  onEnhance: () => void;
  onUndoEnhance: () => void;
  onSendAsTask?: () => void;
  onSubmit: () => void;
  small?: boolean;
  modelLabel?: string;
  /** Raw orchestrator model id — drives the active row in the chip's model section. */
  modelId?: string;
  /** When set, the chip menu grows a Model section (Fable/Opus/Sonnet). */
  onModelChange?: (model: string) => void;
  activeBackend?: OrchestratorBackendSetting;
  onBackendChange?: (backend: OrchestratorBackendSetting) => void;
  effort?: ThinkingEffort;
  onEffortChange?: (effort: ThinkingEffort) => void;
  adaptiveEnabled?: boolean;
  /** UltraCode / swarm tier — Claude fans work out to native sub-agents + Codex. */
  swarmEnabled?: boolean;
  onSetSwarm?: (enabled: boolean) => void;
  /** Collide / MoA tier — Claude + Codex propose independently, Claude synthesizes. */
  collideEnabled?: boolean;
  onSetCollide?: (enabled: boolean) => void;
  /**
   * Session rules (#1329). `undefined` = surface doesn't carry session rules
   * (CLI lanes) → chip hidden. `null` = orchestrator surface, thread not yet
   * minted → chip shows read-only tiers. String = active thread, fully editable.
   */
  sessionRulesThreadId?: string | null;
  repoLabel?: string | null;
  /**
   * Transcript size in the parent panel. When > 0 the chat is no longer
   * in its empty state, so the in-composer repo chip is hidden (the repo
   * is locked in for the conversation — Codex behavior).
   */
  displayMessagesCount?: number;
  working?: boolean;
  onStop?: () => void;
  onUploadDiskFiles?: (files: FileList | File[]) => void;
  onFileReferenceSelect?: (path: string) => void;
  composerMode?: ComposerMode;
  onComposerModeChange?: (mode: ComposerMode) => void;
  repoPath?: string | null;
  workspaceTargets?: OrchestratorWorkspaceTarget[];
  selectedRepoPath?: string | null;
  onSelectRepoPath?: (next: string) => void;
  inlineLeadingExtras?: ReactNode;
  inlineMeterSlot?: ReactNode;
}) {
  const canSubmit = Boolean(input.trim());
  const showRepoChip = Boolean(repoLabel) && displayMessagesCount === 0;

  // Adaptive composer row: measure available width and, below the threshold,
  // collapse the in-input pickers (model + agent) to icon-only — matching the
  // below-composer chip row's COMPACT_CHIP_ROW_WIDTH (440) so both collapse in
  // lockstep. Measured, not a media query, so it tracks the real panel size.
  const rowRef = useRef<HTMLDivElement | null>(null);
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    const el = rowRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      if (w > 0) setCompact(w < 440);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <ComposerChipCompactContext.Provider value={compact}>
    <div ref={rowRef} style={{
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      paddingTop: 4,
      paddingRight: 8,
      paddingBottom: 6,
      paddingLeft: 10,
    }}>
      {/* Left controls — the flexible group. As the composer narrows this
          shrinks and (below the threshold) collapses its pickers to icon-only.
          The right action cluster stays pinned, so Send/mic/attach are never
          pushed off the clipped right edge — the bug this fixes. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, flex: '1 1 auto', overflow: 'hidden' }}>
      {inlineLeadingExtras ? (
        // overflow:hidden is load-bearing — without it a nowrap child that
        // can't shrink spills out of this minWidth:0 span and paints under
        // the row siblings that follow.
        <span style={{ display: 'inline-flex', alignItems: 'center', minWidth: 0, overflow: 'hidden' }}>
          {inlineLeadingExtras}
        </span>
      ) : null}

      {/* Repo / workspace target — only on the empty state. Once a chat
          has messages, the repo is locked in for the conversation
          (Codex behavior) and the chip becomes redundant noise. */}
      {showRepoChip ? (
        <>
          {compact || !inlineLeadingExtras ? null : <span style={{ color: 'var(--t-text-faint)' }}>·</span>}
          <RepoTargetChip
            repoLabel={repoLabel}
            workspaceTargets={workspaceTargets}
            selectedRepoPath={selectedRepoPath}
            onSelectRepoPath={onSelectRepoPath}
          />
        </>
      ) : null}

      {/* Clarify-first toggle removed 2026-07-11 (Q ruling): the interview
          now auto-arms silently — standing doctrine covers materially
          ambiguous requests, and the system prompt arms it for a repo's
          first-ever mission. No transcript-visible directive, no chrome. */}

      {/* Permission (shield) toggle removed 2026-07-11 (Q ruling): the
          orchestrator + worker composers always run full access — a
          read-only mode chip was chrome nobody used. */}

      {/* Session rules (#1329) — "Rules · N" chip. Lists the merged
          Session/Repo/Global rule set; session tier is editable inline.
          Only on orchestrator surfaces (undefined = hidden). */}
      {sessionRulesThreadId !== undefined ? (
        <SessionRulesChip threadId={sessionRulesThreadId} repoPath={repoPath} />
      ) : null}

      {/* Left cluster = intent: attach/+, mode chip, mic (Q ruling 2026-07-17
          — supersedes 07-11's mic-next-to-Send). Context meter moved RIGHT
          beside the model selector. */}
      <AttachFilesButton
        onUploadDiskFiles={onUploadDiskFiles}
        onFileReferenceSelect={onFileReferenceSelect}
        mode={composerMode}
        onModeChange={onComposerModeChange}
        repoPath={repoPath}
      />
      <MicButton />

      </div>

      {/* Right cluster — runtime: context meter · model · thinking · send
          (Q ruling 2026-07-17). Pinned, never shrinks or clips. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
      {inlineMeterSlot ? (
        <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          {inlineMeterSlot}
        </span>
      ) : null}
      {modelLabel ? (
        <ModelThinkingChip
          split
          compact={compact}
          modelLabel={modelLabel}
          modelId={modelId}
          onModelChange={onModelChange}
          activeBackend={activeBackend}
          onBackendChange={onBackendChange}
          effort={effort}
          adaptiveEnabled={adaptiveEnabled}
          onEffortChange={onEffortChange}
          swarmEnabled={swarmEnabled}
          onSetSwarm={onSetSwarm}
          collideEnabled={collideEnabled}
          onSetCollide={onSetCollide}
        />
      ) : null}

      {/* Send — ↵ enter key when idle, square stop while working
          (Claude Code reference, Q ruling 2026-07-11). */}
      <SendPill
        canSubmit={canSubmit}
        working={working}
        onSubmit={onSubmit}
        onStop={onStop}
      />
      </div>
    </div>
    </ComposerChipCompactContext.Provider>
  );
}

function SendPill({
  canSubmit,
  working,
  onSubmit,
  onStop,
}: {
  canSubmit: boolean;
  working: boolean;
  onSubmit: () => void;
  onStop?: () => void;
}) {
  // Compact icon-only button — operator-pinned visual, matches the reference
  // pill set (voice / pause / stop). Single button: play when idle+armed,
  // pause when working (clicking it stops the orchestrator if onStop is
  // wired, otherwise it's a passive indicator).
  const canStop = working && Boolean(onStop);
  const interactive = canStop || (!working && canSubmit);
  const accent = '#2563eb';
  const background = !interactive
    ? 'transparent'
    : accent;
  const iconColor = interactive ? '#ffffff' : 'var(--t-text-faint)';
  const title = working
    ? (canStop ? 'Stop orchestrator' : 'Orchestrator working…')
    : canSubmit ? 'Send (Enter)' : 'Type to send';

  return (
    <button
      type="button"
      onClick={canStop ? onStop : onSubmit}
      disabled={!interactive}
      title={title}
      aria-label={title}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 32,
        height: 32,
        paddingTop: 0,
        paddingRight: 0,
        paddingBottom: 0,
        paddingLeft: 0,
        borderRadius: 10,
        borderWidth: interactive ? 0 : 1,
        borderStyle: 'solid',
        borderColor: 'var(--t-border)',
        background,
        color: iconColor,
        cursor: interactive ? 'pointer' : 'default',
        flexShrink: 0,
        transition: 'background 180ms cubic-bezier(0.22, 1, 0.36, 1), opacity 180ms cubic-bezier(0.22, 1, 0.36, 1)',
        opacity: working && !canStop ? 0.7 : 1,
        animation: working ? 'sendpill-pulse 1.6s ease-in-out infinite' : 'none',
      }}
    >
      {working ? (
        // Stop glyph — solid square (Claude Code reference). Click stops
        // (canStop) or shows "working" indicator otherwise.
        <svg width={13} height={13} viewBox="0 0 16 16" fill={iconColor} style={{ display: 'block' }}>
          <rect x="4" y="4" width="8" height="8" rx="1.5" />
        </svg>
      ) : (
        // Enter-key glyph — ↵ (Claude Code reference).
        <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke={iconColor} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}>
          <polyline points="9 10 4 15 9 20" />
          <path d="M20 4v7a4 4 0 0 1-4 4H4" />
        </svg>
      )}
      <style>{`@keyframes sendpill-pulse { 0%,100% { opacity: 1 } 50% { opacity: 0.6 } }`}</style>
    </button>
  );
}
