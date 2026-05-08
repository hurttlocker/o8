import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AttachFilesButton } from './AttachFilesButton';
import { SparklesIcon } from './ThoughtsIcons';
import { MicButton } from './MicButton';
import type { OrchestratorWorkspaceTarget } from '@/lib/orchestrator/types';
import { type ThinkingEffort } from '@/lib/orchestrator/thinking-effort';

const EFFORT_LABELS: Record<ThinkingEffort, string> = {
  adaptive: 'adaptive',
  low: 'low',
  medium: 'medium',
  high: 'high',
  max: 'max',
  xhigh: 'xhigh',
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
  const [menuPosition, setMenuPosition] = useState<{ left: number; top: number } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
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

  useEffect(() => {
    if (!open) return;
    const updateMenuPosition = () => {
      const rect = buttonRef.current?.getBoundingClientRect();
      if (!rect) return;
      const viewportWidth = window.innerWidth;
      setMenuPosition({
        left: Math.min(Math.max(8, rect.left - 12), Math.max(8, viewportWidth - REPO_TARGET_MENU_WIDTH - 8)),
        top: Math.max(8, rect.top - REPO_TARGET_MENU_HEIGHT - 8),
      });
    };
    const handlePointer = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && containerRef.current?.contains(target)) return;
      if (target && menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    updateMenuPosition();
    document.addEventListener('pointerdown', handlePointer);
    document.addEventListener('keydown', handleKey);
    window.addEventListener('resize', updateMenuPosition);
    window.addEventListener('scroll', updateMenuPosition, true);
    return () => {
      document.removeEventListener('pointerdown', handlePointer);
      document.removeEventListener('keydown', handleKey);
      window.removeEventListener('resize', updateMenuPosition);
      window.removeEventListener('scroll', updateMenuPosition, true);
    };
  }, [open]);

  if (!label) return null;

  return (
    <div ref={containerRef} style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', minWidth: 0 }}>
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
          fontWeight: 500,
          letterSpacing: '-0.005em',
          whiteSpace: 'nowrap',
          fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
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

      {open && menuPosition ? createPortal(
        <div
          ref={menuRef}
          role="listbox"
          aria-label="Chat target repo"
          style={{
            position: 'fixed',
            top: menuPosition.top,
            left: menuPosition.left,
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
            zIndex: 1000,
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
                    fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
                  }}
                >
                  <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 10.5, fontWeight: 700 }}>
                    {group.label}
                  </span>
                  <span style={{ fontSize: 9.5, color: 'var(--t-text-faint)', fontFamily: "'iA Writer Mono', 'JetBrains Mono', 'SF Mono', Menlo, ui-monospace, monospace" }}>
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
                        fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
                      }}
                    >
                      <span style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 }}>
                        <span style={{ fontSize: 11.5, fontWeight: 650, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {targetLabel}
                        </span>
                        <span style={{ fontSize: 9.5, color: 'var(--t-text-faint)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: "'iA Writer Mono', 'JetBrains Mono', 'SF Mono', Menlo, ui-monospace, monospace" }}>
                          {compactRepoPath(target.localPath)}
                        </span>
                      </span>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ fontSize: 9.5, color: active ? 'var(--t-accent)' : 'var(--t-text-faint)', fontFamily: "'iA Writer Mono', 'JetBrains Mono', 'SF Mono', Menlo, ui-monospace, monospace" }}>
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
        </div>,
        document.body,
      ) : null}
    </div>
  );
}

export function InputButtons({
  input,
  enhancing,
  preEnhanceInput,
  onEnhance,
  onUndoEnhance,
  onSubmit,
  modelLabel,
  effort = 'adaptive',
  onEffortChange,
  adaptiveEnabled = true,
  permissionMode,
  onTogglePermission,
  repoLabel,
  working = false,
  onStop,
  onUploadDiskFiles,
  onFileReferenceSelect,
  repoPath,
  workspaceTargets,
  selectedRepoPath,
  onSelectRepoPath,
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
  effort?: ThinkingEffort;
  onEffortChange?: (effort: ThinkingEffort) => void;
  adaptiveEnabled?: boolean;
  permissionMode?: 'full' | 'plan';
  onTogglePermission?: () => void;
  repoLabel?: string | null;
  working?: boolean;
  onStop?: () => void;
  onUploadDiskFiles?: (files: FileList | File[]) => void;
  onFileReferenceSelect?: (path: string) => void;
  repoPath?: string | null;
  workspaceTargets?: OrchestratorWorkspaceTarget[];
  selectedRepoPath?: string | null;
  onSelectRepoPath?: (next: string) => void;
}) {
  const canSubmit = Boolean(input.trim());
  const effortCycle: ThinkingEffort[] = adaptiveEnabled
    ? ['adaptive', 'low', 'medium', 'high', 'xhigh', 'max']
    : ['low', 'medium', 'high', 'xhigh', 'max'];

  const cycleEffort = (next = effortCycle[(Math.max(effortCycle.indexOf(effort), 0)) + 1] ?? effortCycle[0]) => {
    onEffortChange?.(next);
  };

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      paddingTop: 4,
      paddingRight: 8,
      paddingBottom: 6,
      paddingLeft: 10,
    }}>
      <div style={{ display: 'none' }} aria-hidden="true">
        <ThinkingChip effort={effort} adaptiveEnabled={adaptiveEnabled} onChange={cycleEffort} />
      </div>

      {/* Model label */}
      {modelLabel ? (
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            fontSize: 10.5,
            fontWeight: 500,
            color: 'var(--t-text-faint)',
            letterSpacing: '-0.005em',
            whiteSpace: 'nowrap',
            fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
          }}
        >
          {modelLabel}
        </span>
      ) : null}

      {/* Repo / workspace target */}
      {repoLabel ? (
        <>
          <span style={{ color: 'var(--t-text-faint)' }}>·</span>
          <RepoTargetChip
            repoLabel={repoLabel}
            workspaceTargets={workspaceTargets}
            selectedRepoPath={selectedRepoPath}
            onSelectRepoPath={onSelectRepoPath}
          />
        </>
      ) : null}

      {/* Enhance */}
      {preEnhanceInput !== null ? (
        <button
          type="button"
          onClick={onUndoEnhance}
          title="Undo enhancement"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 22,
            height: 22,
            borderRadius: 6,
            borderWidth: 0,
            background: 'rgba(239, 68, 68, 0.1)',
            color: '#ef4444',
            cursor: 'pointer',
            fontSize: 11,
            fontWeight: 600,
          }}
        >
          ↩
        </button>
      ) : (
        <button
          type="button"
          onClick={onEnhance}
          disabled={!input.trim() || enhancing}
          title="Enhance with AI"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 22,
            height: 22,
            borderRadius: 6,
            borderWidth: 0,
            background: 'transparent',
            color: enhancing ? '#93c5fd' : input.trim() ? 'var(--t-text-muted)' : 'var(--t-text-faint)',
            cursor: input.trim() && !enhancing ? 'pointer' : 'default',
            transition: 'color 120ms',
            animation: enhancing ? 'spin 1.5s ease-in-out infinite' : 'none',
          }}
        >
          <SparklesIcon />
        </button>
      )}

      {/* Permission toggle — always rendered, icon-only */}
      <button
        type="button"
        onClick={onTogglePermission}
        title={permissionMode === 'full' ? 'Full access — click to switch to read-only' : 'Read-only — click to arm full access'}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 24,
          height: 24,
          borderRadius: 6,
          borderWidth: 0,
          background: 'transparent',
          color: permissionMode === 'full' ? '#ef4444' : '#9ca3af',
          cursor: 'pointer',
          transition: 'color 120ms',
        }}
      >
        {permissionMode === 'full' ? (
          <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
            <path d="m2 2 20 20" />
          </svg>
        ) : (
          <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
          </svg>
        )}
      </button>

      <div style={{ flex: 1 }} />

      <AttachFilesButton
        onUploadDiskFiles={onUploadDiskFiles}
        onFileReferenceSelect={onFileReferenceSelect}
        repoPath={repoPath}
      />

      {/* Dictation — hold to record. Sits adjacent to Send because
          mic-then-send is the natural flow. */}
      <MicButton />

      {/* Send — Rams pill matching ContextMeter/ThinkingChip aesthetic.
          Three states with 180ms morph: idle (hairline faint) → armed
          (accent border + soft bg + dot) → working (orange hairline +
          pulsing dot + "stop" if onStop provided, else "working"). */}
      <SendPill
        canSubmit={canSubmit}
        working={working}
        onSubmit={onSubmit}
        onStop={onStop}
      />
    </div>
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
  const canStop = working && Boolean(onStop);
  const interactive = canStop || (!working && canSubmit);
  const stateColor = working ? '#FF5A1F' : canSubmit ? '#2563eb' : 'var(--t-text-faint)';
  const borderColor = working
    ? 'rgba(255, 90, 31, 0.32)'
    : canSubmit
      ? 'rgba(37, 99, 235, 0.32)'
      : 'var(--t-border)';
  const background = working
    ? 'rgba(255, 90, 31, 0.08)'
    : canSubmit
      ? 'rgba(37, 99, 235, 0.06)'
      : 'transparent';
  const label = working ? (canStop ? 'stop' : 'working') : 'send';
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
        position: 'relative',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        height: 26,
        paddingLeft: 10,
        paddingRight: 10,
        borderRadius: 8,
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor,
        background,
        color: stateColor,
        cursor: interactive ? 'pointer' : 'default',
        minWidth: 0,
        fontSize: 11.5,
        fontWeight: 500,
        letterSpacing: '0.01em',
        whiteSpace: 'nowrap',
        fontVariantNumeric: 'tabular-nums',
        fontFamily: "'iA Writer Mono', 'JetBrains Mono', 'SF Mono', Menlo, ui-monospace, monospace",
        flexShrink: 0,
        transition: 'background 180ms cubic-bezier(0.22, 1, 0.36, 1), border-color 180ms cubic-bezier(0.22, 1, 0.36, 1), color 180ms cubic-bezier(0.22, 1, 0.36, 1)',
      }}
    >
      {/* status dot — pulses during working */}
      <span
        aria-hidden="true"
        style={{
          width: 6,
          height: 6,
          borderRadius: 999,
          flexShrink: 0,
          background: stateColor,
          animation: working ? 'sendpill-pulse 1.6s ease-in-out infinite' : 'none',
          transition: 'background 180ms cubic-bezier(0.22, 1, 0.36, 1)',
        }}
      />
      <span style={{ color: stateColor }}>{label}</span>
      {/* glyph — up-arrow when send/armed, small square when stop */}
      {canStop ? (
        <svg width={9} height={9} viewBox="0 0 24 24" style={{ display: 'block', flexShrink: 0 }}>
          <rect x="6" y="6" width="12" height="12" rx="1.5" fill={stateColor} />
        </svg>
      ) : working ? null : (
        <svg width={10} height={10} viewBox="0 0 24 24" fill="none" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
          <path d="M12 19V5" stroke={stateColor} />
          <path d="m5 12 7-7 7 7" stroke={stateColor} />
        </svg>
      )}
      <style>{`@keyframes sendpill-pulse { 0%,100% { opacity: 1 } 50% { opacity: 0.35 } }`}</style>
    </button>
  );
}
