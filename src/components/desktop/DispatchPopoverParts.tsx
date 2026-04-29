'use client';

/**
 * DispatchPopoverParts — header / body / footer / picker / send subcomponents
 * for `DispatchPopover.tsx`. Split out so the popover host stays under the
 * 800-line file ceiling. None of these are exported elsewhere — the popover
 * is the only consumer.
 */
import { useEffect } from 'react';
import { ORCHESTRATOR_RUNTIMES } from '@/lib/orchestrator/runtime-capabilities';
import type { OrchestratorRuntime } from '@/lib/orchestrator/types';

export interface RepoEntry {
  id: string;
  name: string;
  localPath: string;
  defaultBranch: string;
  lastOpenedAt: string;
}

// Phosphor "X" path (regular weight, 256 viewBox).
const PHOSPHOR_X_PATH =
  'M205.66,194.34a8,8,0,0,1-11.32,11.32L128,139.31,61.66,205.66a8,8,0,0,1-11.32-11.32L116.69,128,50.34,61.66A8,8,0,0,1,61.66,50.34L128,116.69l66.34-66.35a8,8,0,0,1,11.32,11.32L139.31,128Z';

export function DispatchHeader({ busy, onClose }: { busy: boolean; onClose: () => void }) {
  return (
    <div
      data-tauri-drag-region=""
      style={{
        height: 44,
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        paddingLeft: 16,
        paddingRight: 8,
        gap: 10,
        borderBottomWidth: 1,
        borderBottomStyle: 'solid',
        borderBottomColor: 'var(--t-divider-subtle)',
        // Header is the drag region — match the TitleBar pattern so any pixel
        // that isn't a button drags the window.
        WebkitAppRegion: 'drag',
      } as React.CSSProperties}
    >
      <span
        style={{
          width: 7,
          height: 7,
          borderRadius: 2,
          background: busy ? '#f59e0b' : '#22c55e',
          flexShrink: 0,
          boxShadow: busy
            ? '0 0 10px rgba(245, 158, 11, 0.55)'
            : '0 0 10px rgba(34, 197, 94, 0.4)',
        }}
      />
      <span
        style={{
          fontSize: 13,
          fontWeight: 600,
          letterSpacing: '-0.005em',
          color: 'var(--t-text)',
        }}
      >
        Dispatch a task
      </span>
      <span
        style={{
          fontSize: 11,
          color: 'var(--t-text-muted)',
          letterSpacing: '0.02em',
          marginLeft: 4,
        }}
      >
        {busy ? 'Dispatching…' : 'one-shot packet'}
      </span>
      <div style={{ flex: 1 }} />
      <button
        type="button"
        aria-label="Close popover"
        data-no-drag=""
        onClick={onClose}
        style={{
          WebkitAppRegion: 'no-drag',
          width: 28,
          height: 28,
          borderRadius: 8,
          borderWidth: 0,
          background: 'transparent',
          color: 'var(--t-text-muted)',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          transition: 'background 120ms cubic-bezier(0.22, 1, 0.36, 1)',
        } as React.CSSProperties}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = 'var(--t-divider-subtle)';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = 'transparent';
        }}
      >
        <svg width={14} height={14} viewBox="0 0 256 256" fill="currentColor" aria-hidden>
          <path d={PHOSPHOR_X_PATH} />
        </svg>
      </button>
    </div>
  );
}

export function ContextEnginePill() {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        marginTop: 8,
        marginRight: 14,
        marginBottom: 0,
        marginLeft: 14,
        paddingTop: 6,
        paddingRight: 10,
        paddingBottom: 6,
        paddingLeft: 10,
        borderRadius: 8,
        background: 'var(--t-input-bg)',
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: 'var(--t-divider-subtle)',
        fontSize: 11,
        color: 'var(--t-text-muted)',
        letterSpacing: '-0.005em',
      }}
    >
      <span
        aria-hidden
        style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          borderWidth: 1.5,
          borderStyle: 'solid',
          borderColor: 'var(--t-text-muted)',
          borderTopColor: 'transparent',
          animation: 'dispatch-spinner 800ms linear infinite',
        }}
      />
      <span>Setting up Context Engine — dispatch will skip context for this packet</span>
      <style>{'@keyframes dispatch-spinner { to { transform: rotate(360deg); } }'}</style>
    </div>
  );
}

interface DispatchBodyProps {
  textareaRef: React.MutableRefObject<HTMLTextAreaElement | null>;
  value: string;
  busy: boolean;
  onChange: (next: string) => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void;
}

export function DispatchBody({ textareaRef, value, busy, onChange, onKeyDown }: DispatchBodyProps) {
  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        paddingTop: 12,
        paddingRight: 14,
        paddingBottom: 8,
        paddingLeft: 14,
        minHeight: 0,
      }}
    >
      <textarea
        ref={textareaRef}
        value={value}
        disabled={busy}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder="What do you want done?"
        spellCheck={false}
        autoFocus
        style={{
          flex: 1,
          width: '100%',
          minHeight: 0,
          resize: 'none',
          background: 'var(--t-input-bg)',
          borderWidth: 1,
          borderStyle: 'solid',
          borderColor: 'var(--t-input-border)',
          borderRadius: 10,
          paddingTop: 10,
          paddingRight: 12,
          paddingBottom: 10,
          paddingLeft: 12,
          color: 'var(--t-text)',
          fontFamily: 'inherit',
          fontSize: 14,
          lineHeight: 1.5,
          letterSpacing: '-0.005em',
          outline: 'none',
        }}
      />
    </div>
  );
}

export function ErrorRow({ message }: { message: string }) {
  return (
    <div
      style={{
        marginTop: 0,
        marginRight: 14,
        marginBottom: 4,
        marginLeft: 14,
        paddingTop: 4,
        paddingBottom: 4,
        fontSize: 11,
        color: '#f87171',
        letterSpacing: '-0.005em',
      }}
    >
      {message}
    </div>
  );
}

interface DispatchFooterProps {
  runtime: OrchestratorRuntime;
  runtimes: OrchestratorRuntime[];
  runtimeButtonsRef: React.MutableRefObject<Array<HTMLButtonElement | null>>;
  onRuntimeChange: (next: OrchestratorRuntime) => void;
  repoButtonRef: React.MutableRefObject<HTMLButtonElement | null>;
  repoPickerOpen: boolean;
  onRepoPickerToggle: () => void;
  onRepoPickerClose: () => void;
  repos: RepoEntry[];
  selectedRepo: RepoEntry | null;
  onRepoSelect: (localPath: string) => void;
  sendButtonRef: React.MutableRefObject<HTMLButtonElement | null>;
  canSend: boolean;
  busy: boolean;
  onSend: () => void;
}

export function DispatchFooter({
  runtime,
  runtimes,
  runtimeButtonsRef,
  onRuntimeChange,
  repoButtonRef,
  repoPickerOpen,
  onRepoPickerToggle,
  onRepoPickerClose,
  repos,
  selectedRepo,
  onRepoSelect,
  sendButtonRef,
  canSend,
  busy,
  onSend,
}: DispatchFooterProps) {
  return (
    <div
      style={{
        height: 48,
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        paddingLeft: 12,
        paddingRight: 12,
        borderTopWidth: 1,
        borderTopStyle: 'solid',
        borderTopColor: 'var(--t-divider-subtle)',
        position: 'relative',
      }}
    >
      <RuntimeChips
        runtime={runtime}
        runtimes={runtimes}
        runtimeButtonsRef={runtimeButtonsRef}
        onChange={onRuntimeChange}
      />
      <RepoPicker
        repoButtonRef={repoButtonRef}
        open={repoPickerOpen}
        onToggle={onRepoPickerToggle}
        onClose={onRepoPickerClose}
        repos={repos}
        selectedRepo={selectedRepo}
        onSelect={onRepoSelect}
      />
      <div style={{ flex: 1 }} />
      <SendButton sendButtonRef={sendButtonRef} canSend={canSend} busy={busy} onClick={onSend} />
    </div>
  );
}

interface RuntimeChipsProps {
  runtime: OrchestratorRuntime;
  runtimes: OrchestratorRuntime[];
  runtimeButtonsRef: React.MutableRefObject<Array<HTMLButtonElement | null>>;
  onChange: (next: OrchestratorRuntime) => void;
}

function RuntimeChips({ runtime, runtimes, runtimeButtonsRef, onChange }: RuntimeChipsProps) {
  return (
    <div
      role="radiogroup"
      aria-label="Runtime"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        padding: 2,
        background: 'var(--t-input-bg)',
        borderRadius: 9,
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: 'var(--t-divider-subtle)',
      }}
    >
      {runtimes.map((id, index) => {
        const meta = ORCHESTRATOR_RUNTIMES[id];
        const active = id === runtime;
        return (
          <button
            key={id}
            ref={(el) => {
              runtimeButtonsRef.current[index] = el;
            }}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(id)}
            title={meta.description}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              paddingTop: 4,
              paddingRight: 9,
              paddingBottom: 4,
              paddingLeft: 8,
              borderRadius: 7,
              borderWidth: 0,
              background: active ? 'var(--t-panel-solid, var(--t-panel))' : 'transparent',
              boxShadow: active ? '0 1px 2px rgba(0, 0, 0, 0.18)' : 'none',
              color: active ? 'var(--t-text)' : 'var(--t-text-muted)',
              fontFamily: 'inherit',
              fontSize: 11.5,
              fontWeight: active ? 600 : 500,
              letterSpacing: '-0.005em',
              cursor: 'pointer',
              transition: 'background 120ms cubic-bezier(0.22, 1, 0.36, 1)',
            }}
          >
            <span
              aria-hidden
              style={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: meta.accentColor,
                flexShrink: 0,
              }}
            />
            {meta.shortLabel}
          </button>
        );
      })}
    </div>
  );
}

interface RepoPickerProps {
  repoButtonRef: React.MutableRefObject<HTMLButtonElement | null>;
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  repos: RepoEntry[];
  selectedRepo: RepoEntry | null;
  onSelect: (localPath: string) => void;
}

function RepoPicker({
  repoButtonRef,
  open,
  onToggle,
  onClose,
  repos,
  selectedRepo,
  onSelect,
}: RepoPickerProps) {
  // Close on outside click while popover is open. Scoped to the document so
  // clicking outside the picker closes it; clicks inside don't bubble through
  // to the document handler.
  useEffect(() => {
    if (!open) return;
    const handler = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      const popoverEl = document.getElementById('dispatch-repo-popover');
      if (popoverEl && popoverEl.contains(target)) return;
      if (repoButtonRef.current && repoButtonRef.current.contains(target)) return;
      onClose();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open, onClose, repoButtonRef]);

  const label = selectedRepo ? selectedRepo.name : 'No repo';
  return (
    <div style={{ position: 'relative' }}>
      <button
        ref={repoButtonRef}
        type="button"
        onClick={onToggle}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={selectedRepo?.localPath ?? ''}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          paddingTop: 5,
          paddingRight: 8,
          paddingBottom: 5,
          paddingLeft: 10,
          borderRadius: 8,
          borderWidth: 1,
          borderStyle: 'solid',
          borderColor: 'var(--t-divider-subtle)',
          background: 'var(--t-input-bg)',
          color: 'var(--t-text)',
          fontFamily: 'inherit',
          fontSize: 11.5,
          fontWeight: 500,
          letterSpacing: '-0.005em',
          cursor: 'pointer',
          maxWidth: 180,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {label}
        </span>
        <svg
          width={9}
          height={9}
          viewBox="0 0 10 10"
          fill="none"
          stroke="var(--t-text-muted)"
          strokeWidth="1.5"
          strokeLinecap="round"
          aria-hidden
          style={{ flexShrink: 0, opacity: 0.6 }}
        >
          <path d="M2.5 3.5L5 6L7.5 3.5" />
        </svg>
      </button>
      {open ? (
        <div
          id="dispatch-repo-popover"
          role="listbox"
          style={{
            position: 'absolute',
            bottom: 36,
            left: 0,
            zIndex: 50,
            minWidth: 220,
            maxWidth: 320,
            maxHeight: 220,
            overflowY: 'auto',
            borderRadius: 10,
            borderWidth: 1,
            borderStyle: 'solid',
            borderColor: 'var(--t-divider-subtle)',
            background: 'var(--t-panel-solid, var(--t-panel))',
            boxShadow: '0 12px 28px rgba(0, 0, 0, 0.22)',
          }}
        >
          {repos.length === 0 ? (
            <div
              style={{
                paddingTop: 10,
                paddingRight: 12,
                paddingBottom: 10,
                paddingLeft: 12,
                fontSize: 11.5,
                color: 'var(--t-text-muted)',
              }}
            >
              No repos registered. Open one in the dashboard first.
            </div>
          ) : (
            repos.map((repo) => {
              const active = repo.localPath === selectedRepo?.localPath;
              return (
                <button
                  key={repo.id}
                  type="button"
                  role="option"
                  aria-selected={active}
                  onClick={() => onSelect(repo.localPath)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    width: '100%',
                    paddingTop: 8,
                    paddingRight: 12,
                    paddingBottom: 8,
                    paddingLeft: 12,
                    borderWidth: 0,
                    background: active ? 'var(--t-accent-soft)' : 'transparent',
                    color: 'var(--t-text)',
                    fontFamily: 'inherit',
                    fontSize: 11.5,
                    fontWeight: active ? 600 : 500,
                    cursor: 'pointer',
                    textAlign: 'left',
                    overflow: 'hidden',
                  }}
                  onMouseEnter={(e) => {
                    if (!active) e.currentTarget.style.background = 'var(--t-panel-hover)';
                  }}
                  onMouseLeave={(e) => {
                    if (!active) e.currentTarget.style.background = 'transparent';
                  }}
                >
                  <span
                    style={{
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      flex: 1,
                    }}
                  >
                    {repo.name}
                  </span>
                  <span
                    style={{
                      fontFamily: '"SF Mono", Menlo, monospace',
                      fontSize: 10,
                      color: 'var(--t-text-muted)',
                      flexShrink: 0,
                    }}
                  >
                    {repo.defaultBranch}
                  </span>
                </button>
              );
            })
          )}
        </div>
      ) : null}
    </div>
  );
}

interface SendButtonProps {
  sendButtonRef: React.MutableRefObject<HTMLButtonElement | null>;
  canSend: boolean;
  busy: boolean;
  onClick: () => void;
}

function SendButton({ sendButtonRef, canSend, busy, onClick }: SendButtonProps) {
  return (
    <button
      ref={sendButtonRef}
      type="button"
      onClick={onClick}
      disabled={!canSend}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        paddingTop: 6,
        paddingRight: 10,
        paddingBottom: 6,
        paddingLeft: 12,
        borderRadius: 8,
        borderWidth: 0,
        background: canSend ? 'var(--t-accent)' : 'var(--t-input-bg)',
        color: canSend ? '#ffffff' : 'var(--t-text-muted)',
        fontFamily: 'inherit',
        fontSize: 12,
        fontWeight: 600,
        letterSpacing: '-0.005em',
        cursor: canSend ? 'pointer' : 'default',
        opacity: canSend ? 1 : 0.7,
        transition: 'opacity 120ms cubic-bezier(0.22, 1, 0.36, 1)',
      }}
    >
      <span>{busy ? 'Sending…' : 'Send'}</span>
      <span
        aria-hidden
        style={{
          fontFamily: '"SF Mono", Menlo, monospace',
          fontSize: 10,
          fontWeight: 500,
          opacity: 0.85,
          letterSpacing: '0.02em',
          paddingLeft: 4,
          paddingRight: 4,
          paddingTop: 1,
          paddingBottom: 1,
          borderRadius: 4,
          background: canSend ? 'rgba(255, 255, 255, 0.22)' : 'transparent',
        }}
      >
        ⌘↵
      </span>
    </button>
  );
}
