'use client';

/**
 * TitleBar — Topmost bar across the entire application.
 *
 * Layout (matching Cursor/Claude Code pattern):
 * Left:  [78px traffic light spacer] [Sidebar toggle] [← Back] [→ Forward]
 * Center: [Search pill / expanded UniversalSearch]
 * Right: [Bottom panel toggle] [Chat toggle] [Settings gear (red)]
 *
 * Sits ABOVE everything. Height: 44px. Frosted glass.
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import type { RepoRegistryEntry } from '@/lib/repos/types';

// ── Inline SVG icons (Tauri webview doesn't reliably render Lucide React components) ──

function IconPanelLeft({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="M9 3v18" />
    </svg>
  );
}

function IconChevronLeft({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <path d="m15 18-6-6 6-6" />
    </svg>
  );
}

function IconChevronRight({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
}

function IconSearch({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  );
}

function IconPanelBottom({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="M3 15h18" />
    </svg>
  );
}

function IconMessageSquare({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}

// ── Types ──

interface TitleBarProps {
  renderSearch?: (onClose: () => void) => React.ReactNode;
  globalRepoBranch?: string;
  selectedRepoEntry?: RepoRegistryEntry | null;
  repoEntries?: RepoRegistryEntry[];
  onRepoChange?: (repoId: string | null) => void;
  onRepoRemove?: (repoId: string) => void;
  onOpenFolder?: () => void;
  sidebarVisible?: boolean;
  onToggleSidebar?: () => void;
  bottomPanelVisible?: boolean;
  onToggleBottomPanel?: () => void;
  chatVisible?: boolean;
  onToggleChat?: () => void;
  wsStatus?: 'connected' | 'connecting' | 'reconnecting' | 'disconnected';
}

// ── Icon Button ──

function TitleBarButton({
  icon,
  label,
  onClick,
  active,
  color,
  hoverBg,
}: {
  icon: React.ReactNode;
  label: string;
  onClick?: () => void;
  active?: boolean;
  color?: string;
  hoverBg?: string;
}) {
  const defaultColor = color ?? 'var(--t-text-secondary)';
  const defaultHoverBg = hoverBg ?? 'var(--t-hover)';

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      style={{
        width: 32,
        height: 32,
        borderRadius: 8,
        border: 'none',
        background: active ? 'var(--t-panel-active)' : 'transparent',
        color: active ? 'var(--t-text)' : defaultColor,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'pointer',
        WebkitTapHighlightColor: 'transparent',
        transition: 'background 120ms ease, color 120ms ease',
        flexShrink: 0,
        padding: 0,
        ['WebkitAppRegion' as string]: 'no-drag',
      }}
      onMouseEnter={(e) => {
        if (!active) {
          e.currentTarget.style.background = defaultHoverBg;
        }
      }}
      onMouseLeave={(e) => {
        if (!active) {
          e.currentTarget.style.background = 'transparent';
        }
      }}
    >
      {icon}
    </button>
  );
}

// ── Separator ──

function TitleBarSep() {
  return (
    <div style={{
      width: 1,
      height: 16,
      background: 'var(--t-divider)',
      margin: '0 4px',
      flexShrink: 0,
    }} />
  );
}

// ── Main Component ──

export function TitleBar({
  renderSearch,
  globalRepoBranch = 'main',
  selectedRepoEntry = null,
  repoEntries = [],
  onRepoChange,
  onRepoRemove,
  onOpenFolder,
  sidebarVisible = true,
  onToggleSidebar,
  bottomPanelVisible = true,
  onToggleBottomPanel,
  chatVisible = true,
  onToggleChat,
  wsStatus = 'connecting',
}: TitleBarProps) {
  const [searchExpanded, setSearchExpanded] = useState(false);
  const [repoPickerOpen, setRepoPickerOpen] = useState(false);
  const [openMenuOpen, setOpenMenuOpen] = useState(false);
  const [availableEditors, setAvailableEditors] = useState<{ id: string; name: string; available: boolean }[]>([]);
  const selectedRepoPath = selectedRepoEntry?.localPath ?? '';
  const selectedRepoName = selectedRepoEntry?.name ?? null;
  const hasSelectedRepo = Boolean(selectedRepoEntry);

  // Fetch available editors on mount
  useEffect(() => {
    fetch('/api/panel/open-in')
      .then(r => r.json())
      .then(data => setAvailableEditors(data.editors ?? []))
      .catch(() => {});
  }, []);
  const headerRef = useRef<HTMLElement>(null);

  const renderRepoEntryRow = useCallback((repo: RepoRegistryEntry) => {
    const isSelected = selectedRepoEntry?.id === repo.id;

    return (
      <div
        key={repo.id}
        style={{
          display: 'flex',
          alignItems: 'stretch',
          background: isSelected ? 'rgba(239,68,68,0.06)' : 'transparent',
        }}
      >
        <button
          type="button"
          onClick={() => { onRepoChange?.(repo.id); setRepoPickerOpen(false); }}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            flex: 1,
            minWidth: 0,
            padding: '8px 12px',
            border: 'none',
            background: 'transparent',
            color: isSelected ? '#dc2626' : 'var(--t-text)',
            fontSize: 12,
            fontWeight: isSelected ? 600 : 400,
            cursor: 'pointer',
            fontFamily: '-apple-system, system-ui, sans-serif',
            textAlign: 'left',
          }}
          onMouseEnter={(e) => {
            if (!isSelected) e.currentTarget.style.background = 'rgba(0,0,0,0.03)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'transparent';
          }}
        >
          <span style={{ width: 14, textAlign: 'center', fontSize: 12, color: isSelected ? '#dc2626' : 'transparent' }}>✓</span>
          <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 }}>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{repo.name}</span>
            <span
              style={{
                fontSize: 10,
                color: 'var(--t-text-faint)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {repo.localPath}
            </span>
          </div>
        </button>
        <button
          type="button"
          onClick={() => {
            onRepoRemove?.(repo.id);
            setRepoPickerOpen(false);
          }}
          title={`Remove ${repo.name} from Cortex`}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 34,
            border: 'none',
            borderLeft: '1px solid rgba(0,0,0,0.05)',
            background: 'transparent',
            color: '#b91c1c',
            cursor: 'pointer',
            flexShrink: 0,
          }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 6h18" />
            <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
            <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
            <path d="M10 11v6" />
            <path d="M14 11v6" />
          </svg>
        </button>
      </div>
    );
  }, [onRepoChange, onRepoRemove, selectedRepoEntry]);

  // Window drag — Tauri v2 startDragging API
  const handleMouseDown = useCallback(async (e: React.MouseEvent) => {
    // Only drag from the header itself or non-interactive children
    const target = e.target as HTMLElement;
    // Skip if clicking a button, input, or anything interactive
    if (
      target.closest('button') ||
      target.closest('input') ||
      target.closest('kbd') ||
      target.closest('[data-no-drag]')
    ) {
      return;
    }
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      await getCurrentWindow().startDragging();
    } catch {
      // Not in Tauri — ignore (browser mode)
    }
  }, []);

  // ⌘K keyboard shortcut
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearchExpanded(true);
      }
      if (e.key === 'Escape' && searchExpanded) {
        setSearchExpanded(false);
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [searchExpanded]);

  const closeSearch = useCallback(() => setSearchExpanded(false), []);

  return (
    <header
      ref={headerRef}
      data-tauri-drag-region=""
      onMouseDown={handleMouseDown}
      style={{
        height: 44,
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        padding: '0 12px',
        gap: 4,
        background: 'var(--t-chrome)',
        backdropFilter: 'blur(20px) saturate(1.6)',
        WebkitBackdropFilter: 'blur(20px) saturate(1.6)',
        borderBottom: '1px solid var(--t-divider)',
        zIndex: 9000,
        position: 'relative',
        ['WebkitAppRegion' as string]: 'drag',
      }}
    >
      {/* ── Left: Traffic light spacer + controls ── */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 2,
        flexShrink: 0,
      }}>
        {/* Spacer for macOS traffic lights (close/minimize/maximize) */}
        <div style={{ width: 78, flexShrink: 0 }} />

        {/* Sidebar toggle */}
        <TitleBarButton
          icon={<IconPanelLeft />}
          label="Toggle sidebar"
          onClick={onToggleSidebar}
          active={sidebarVisible}
        />

        <TitleBarSep />

        {/* Back */}
        <TitleBarButton
          icon={<IconChevronLeft />}
          label="Go back"
          onClick={() => window.history.back()}
        />

        {/* Forward */}
        <TitleBarButton
          icon={<IconChevronRight />}
          label="Go forward"
          onClick={() => window.history.forward()}
        />
      </div>

      {/* ── Center — Repo Picker + Search ── */}
      <div style={{
        flex: 1,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
      }}>
        {/* Repo picker pill */}
        {hasSelectedRepo ? (
          <div style={{ position: 'relative', flexShrink: 0, ['WebkitAppRegion' as string]: 'no-drag' }} data-no-drag="">
            <button
              type="button"
              onClick={() => setRepoPickerOpen(v => !v)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 5,
                padding: '5px 10px',
                borderRadius: 8,
                border: '1px solid var(--t-search-border)',
                background: 'var(--t-search-bg)',
                backdropFilter: 'blur(12px)',
                cursor: 'pointer',
                fontFamily: '-apple-system, system-ui, sans-serif',
                transition: 'background 150ms ease, border-color 150ms ease',
                whiteSpace: 'nowrap',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'var(--t-hover)';
                e.currentTarget.style.borderColor = 'var(--t-input-border)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'var(--t-search-bg)';
                e.currentTarget.style.borderColor = 'var(--t-search-border)';
              }}
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z" fill="currentColor" opacity="0.4" />
              </svg>
              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--t-text)' }}>
                {selectedRepoName}
              </span>
              <span style={{
                fontSize: 10,
                color: 'var(--t-text-muted)',
                fontFamily: '"SF Mono", ui-monospace, monospace',
                padding: '1px 5px',
                borderRadius: 4,
                background: 'var(--t-kbd-bg, rgba(0,0,0,0.04))',
              }}>
                {globalRepoBranch}
              </span>
              <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.4 }}>
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>

            {/* Repo picker dropdown */}
            {repoPickerOpen ? (
              <>
                <div onClick={() => setRepoPickerOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 9998 }} />
                <div style={{
                  position: 'absolute',
                  top: '100%',
                  left: 0,
                  marginTop: 6,
                  minWidth: 200,
                  borderRadius: 10,
                  border: '1px solid rgba(255,255,255,0.3)',
                  background: 'rgba(255,255,255,0.75)',
                  backdropFilter: 'blur(40px) saturate(1.8)',
                  WebkitBackdropFilter: 'blur(40px) saturate(1.8)',
                  boxShadow: '0 12px 48px rgba(0,0,0,0.12), 0 1px 4px rgba(0,0,0,0.06)',
                  overflow: 'hidden',
                  zIndex: 9999,
                }}>
                  <button
                    type="button"
                    onClick={() => { onOpenFolder?.(); setRepoPickerOpen(false); }}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      width: '100%',
                      padding: '8px 12px',
                      border: 'none',
                      background: 'transparent',
                      color: 'var(--t-text)',
                      fontSize: 12,
                      fontWeight: 500,
                      cursor: 'pointer',
                      fontFamily: '-apple-system, system-ui, sans-serif',
                      textAlign: 'left',
                    }}
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/></svg>
                    Open Folder…
                  </button>
                  <div style={{ height: 1, background: 'var(--t-divider)', margin: '2px 0' }} />
                  <button
                    type="button"
                    onClick={() => { onRepoChange?.(null); setRepoPickerOpen(false); }}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      width: '100%',
                      padding: '8px 12px',
                      border: 'none',
                      background: 'transparent',
                      color: 'var(--t-text-muted)',
                      fontSize: 12,
                      fontWeight: 500,
                      cursor: 'pointer',
                      fontFamily: '-apple-system, system-ui, sans-serif',
                      textAlign: 'left',
                    }}
                  >
                    <span style={{ width: 14, textAlign: 'center', fontSize: 12 }}>○</span>
                    Clear Selection
                  </button>
                  {repoEntries.map(renderRepoEntryRow)}
                </div>
              </>
            ) : null}
          </div>
        ) : (
          <div style={{ position: 'relative', flexShrink: 0, ['WebkitAppRegion' as string]: 'no-drag' }} data-no-drag="">
            <button
              type="button"
              onClick={() => setRepoPickerOpen(v => !v)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 5,
                padding: '5px 10px',
                borderRadius: 8,
                border: '1px solid var(--t-search-border)',
                background: 'var(--t-search-bg)',
                backdropFilter: 'blur(12px)',
                cursor: 'pointer',
                fontFamily: '-apple-system, system-ui, sans-serif',
                whiteSpace: 'nowrap',
              }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.5 }}><path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/></svg>
              <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--t-text-muted)' }}>
                Open Folder
              </span>
            </button>
            {repoPickerOpen && (
              <>
                <div onClick={() => setRepoPickerOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 9998 }} />
                <div style={{
                  position: 'absolute', top: '100%', left: 0, marginTop: 6, minWidth: 220,
                  borderRadius: 10, border: '1px solid rgba(255,255,255,0.3)',
                  background: 'rgba(255,255,255,0.75)', backdropFilter: 'blur(40px) saturate(1.8)',
                  WebkitBackdropFilter: 'blur(40px) saturate(1.8)',
                  boxShadow: '0 12px 48px rgba(0,0,0,0.12)', overflow: 'hidden', zIndex: 9999,
                }}>
                  <button
                    type="button"
                    onClick={() => { onOpenFolder?.(); setRepoPickerOpen(false); }}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 8, width: '100%',
                      padding: '8px 12px', border: 'none', background: 'transparent',
                      color: 'var(--t-text)', fontSize: 12, fontWeight: 500, cursor: 'pointer',
                      fontFamily: '-apple-system, system-ui, sans-serif', textAlign: 'left',
                    }}
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/></svg> Open Folder…
                  </button>
                  {repoEntries.length > 0 && <div style={{ height: 1, background: 'var(--t-divider)', margin: '2px 0' }} />}
                  {repoEntries.map(renderRepoEntryRow)}
                </div>
              </>
            )}
          </div>
        )}
        <div style={{
          width: '100%',
          maxWidth: searchExpanded ? 640 : 280,
          transition: 'max-width 250ms cubic-bezier(0.32, 0.72, 0, 1)',
          position: 'relative',
        }}>
          {!searchExpanded ? (
            <button
              type="button"
              onClick={() => setSearchExpanded(true)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '6px 16px',
                borderRadius: 10,
                border: '1px solid var(--t-search-border)',
                background: 'var(--t-search-bg)',
                color: 'var(--t-text-muted)',
                fontSize: 13,
                fontWeight: 500,
                letterSpacing: '-0.01em',
                cursor: 'pointer',
                WebkitTapHighlightColor: 'transparent',
                transition: 'background 150ms ease, border-color 150ms ease',
                width: '100%',
                justifyContent: 'center',
                ['WebkitAppRegion' as string]: 'no-drag',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'var(--t-hover)';
                e.currentTarget.style.borderColor = 'var(--t-input-border)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'var(--t-search-bg)';
                e.currentTarget.style.borderColor = 'var(--t-search-border)';
              }}
            >
              <IconSearch />
              <span>Search</span>
              <kbd style={{
                fontSize: 10,
                fontWeight: 500,
                color: 'var(--t-kbd-color)',
                background: 'var(--t-kbd-bg)',
                border: '1px solid var(--t-kbd-border)',
                borderRadius: 4,
                padding: '1px 5px',
                marginLeft: 8,
                fontFamily: '-apple-system, BlinkMacSystemFont, system-ui, sans-serif',
              }}>
                ⌘K
              </kbd>
            </button>
          ) : (
            <div style={{ position: 'relative', ['WebkitAppRegion' as string]: 'no-drag' }}>
              {renderSearch ? renderSearch(closeSearch) : null}
            </div>
          )}
        </div>
      </div>

      {/* ── Live dot ── */}
      <div
        title={wsStatus === 'connected' ? 'Live — WebSocket connected' : wsStatus === 'reconnecting' ? 'Reconnecting…' : wsStatus === 'connecting' ? 'Connecting…' : 'Disconnected'}
        style={{
          width: 7,
          height: 7,
          borderRadius: '50%',
          background: wsStatus === 'connected' ? '#34c759'
            : wsStatus === 'reconnecting' || wsStatus === 'connecting' ? '#ff9f0a'
            : '#ff3b30',
          flexShrink: 0,
          transition: 'background 300ms ease',
          marginRight: 2,
        }}
      />

      {/* ── Open In button ── */}
      {hasSelectedRepo ? (
        <div style={{ position: 'relative', flexShrink: 0, ['WebkitAppRegion' as string]: 'no-drag' }} data-no-drag="">
          <button
            type="button"
            onClick={() => setOpenMenuOpen(v => !v)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              padding: '5px 10px',
              borderRadius: 8,
              border: '1px solid var(--t-search-border)',
              background: 'var(--t-search-bg)',
              cursor: 'pointer',
              fontFamily: '-apple-system, system-ui, sans-serif',
              fontSize: 12,
              fontWeight: 500,
              color: 'var(--t-text-muted)',
              transition: 'background 150ms ease, border-color 150ms ease',
              whiteSpace: 'nowrap',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'var(--t-hover)';
              e.currentTarget.style.borderColor = 'var(--t-input-border)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'var(--t-search-bg)';
              e.currentTarget.style.borderColor = 'var(--t-search-border)';
            }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
              <polyline points="15 3 21 3 21 9" />
              <line x1="10" y1="14" x2="21" y2="3" />
            </svg>
            Open
            <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.4 }}>
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>

          {openMenuOpen ? (
            <>
              <div onClick={() => setOpenMenuOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 9998 }} />
              <div style={{
                position: 'absolute',
                top: '100%',
                right: 0,
                marginTop: 6,
                minWidth: 180,
                borderRadius: 10,
                border: '1px solid rgba(255,255,255,0.3)',
                background: 'rgba(255,255,255,0.75)',
                backdropFilter: 'blur(40px) saturate(1.8)',
                WebkitBackdropFilter: 'blur(40px) saturate(1.8)',
                boxShadow: '0 12px 48px rgba(0,0,0,0.12), 0 1px 4px rgba(0,0,0,0.06)',
                overflow: 'hidden',
                zIndex: 9999,
              }}>
                {/* System actions */}
                {[
                  { id: 'finder', name: 'Finder', icon: '📁' },
                  { id: 'terminal', name: 'Terminal', icon: '▶' },
                ].map(item => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => {
                        fetch('/api/panel/open-in', {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ editor: item.id, repo: selectedRepoPath }),
                        });
                      setOpenMenuOpen(false);
                    }}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 8, width: '100%',
                      padding: '8px 12px', border: 'none', background: 'transparent',
                      color: 'var(--t-text)', fontSize: 12, fontWeight: 400,
                      cursor: 'pointer', fontFamily: '-apple-system, system-ui, sans-serif', textAlign: 'left',
                    }}
                    onMouseEnter={(e) => { (e.currentTarget).style.background = 'rgba(255,255,255,0.1)'; }}
                    onMouseLeave={(e) => { (e.currentTarget).style.background = 'transparent'; }}
                  >
                    <span style={{ width: 16, textAlign: 'center', fontSize: 13 }}>{item.icon}</span>
                    {item.name}
                  </button>
                ))}

                {/* Divider */}
                <div style={{ height: 1, background: 'rgba(255,255,255,0.12)', margin: '4px 0' }} />

                {/* IDEs */}
                {availableEditors
                  .filter(e => e.id !== 'finder' && e.id !== 'terminal' && e.available)
                  .map(editor => (
                    <button
                      key={editor.id}
                      type="button"
                      onClick={() => {
                        fetch('/api/panel/open-in', {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ editor: editor.id, repo: selectedRepoPath }),
                        });
                        setOpenMenuOpen(false);
                      }}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 8, width: '100%',
                        padding: '8px 12px', border: 'none', background: 'transparent',
                        color: 'var(--t-text)', fontSize: 12, fontWeight: 400,
                        cursor: 'pointer', fontFamily: '-apple-system, system-ui, sans-serif', textAlign: 'left',
                      }}
                      onMouseEnter={(e) => { (e.currentTarget).style.background = 'rgba(255,255,255,0.1)'; }}
                      onMouseLeave={(e) => { (e.currentTarget).style.background = 'transparent'; }}
                    >
                      <span style={{ width: 16, textAlign: 'center' }}>
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.6 }}>
                          <polyline points="16 18 22 12 16 6" />
                          <polyline points="8 6 2 12 8 18" />
                        </svg>
                      </span>
                      {editor.name}
                    </button>
                  ))}

                {/* Divider */}
                <div style={{ height: 1, background: 'rgba(255,255,255,0.12)', margin: '4px 0' }} />

                {/* Copy path */}
                <button
                  type="button"
                  onClick={() => {
                    navigator.clipboard.writeText(selectedRepoPath);
                    setOpenMenuOpen(false);
                  }}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8, width: '100%',
                    padding: '8px 12px', border: 'none', background: 'transparent',
                    color: 'var(--t-text)', fontSize: 12, fontWeight: 400,
                    cursor: 'pointer', fontFamily: '-apple-system, system-ui, sans-serif', textAlign: 'left',
                  }}
                  onMouseEnter={(e) => { (e.currentTarget).style.background = 'rgba(255,255,255,0.1)'; }}
                  onMouseLeave={(e) => { (e.currentTarget).style.background = 'transparent'; }}
                >
                  <span style={{ width: 16, textAlign: 'center' }}>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.6 }}>
                      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                    </svg>
                  </span>
                  Copy path
                  <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--t-text-faint)', fontFamily: '"SF Mono", ui-monospace, monospace' }}>⌘⇧C</span>
                </button>
              </div>
            </>
          ) : null}
        </div>
      ) : null}

      {/* ── Right controls ── */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 2,
        flexShrink: 0,
        paddingRight: 4,
      }}>
        {/* WS indicator moved to left of Open button */}

        {/* Bottom panel toggle */}
        <TitleBarButton
          icon={<IconPanelBottom />}
          label="Toggle bottom panel"
          onClick={onToggleBottomPanel}
          active={bottomPanelVisible}
        />

        {/* Chat panel toggle */}
        <TitleBarButton
          icon={<IconMessageSquare />}
          label="Toggle chat"
          onClick={onToggleChat}
          active={chatVisible}
        />

      </div>

      {/* Backdrop — closes search when clicking outside */}
      {searchExpanded && (
        <div
          onClick={closeSearch}
          style={{
            position: 'fixed',
            inset: 0,
            top: 44,
            zIndex: -1,
          }}
        />
      )}
    </header>
  );
}
