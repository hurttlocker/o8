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
import { motion } from 'framer-motion';
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

function IconDelta({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M12 5 18.5 18H5.5L12 5Z" />
      <path d="M8.5 14h7" />
    </svg>
  );
}

function IconPanelRightCollapse({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <rect x="3" y="4" width="18" height="16" rx="3" />
      <path d="M16 4v16" />
      <path d="m10 9 3 3-3 3" />
    </svg>
  );
}

// ── Types ──

interface TitleBarProps {
  renderSearch?: (onClose: () => void) => React.ReactNode;
  selectedRepoEntry?: RepoRegistryEntry | null;
  sidebarVisible?: boolean;
  onToggleSidebar?: () => void;
  bottomPanelVisible?: boolean;
  onToggleBottomPanel?: () => void;
  chatVisible?: boolean;
  onToggleChat?: () => void;
  workspacePanelVisible?: boolean;
  onToggleWorkspacePanel?: () => void;
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

function RightPanelMorphButton({
  chatVisible,
  workspacePanelVisible,
  onToggleChat,
  onToggleWorkspacePanel,
}: {
  chatVisible: boolean;
  workspacePanelVisible: boolean;
  onToggleChat?: () => void;
  onToggleWorkspacePanel?: () => void;
}) {
  const panelOpen = chatVisible || workspacePanelVisible;
  const state: 'collapsed' | 'chat' | 'review' = !panelOpen
    ? 'collapsed'
    : chatVisible
      ? 'chat'
      : 'review';
  const label = state === 'collapsed'
    ? 'Open agent chat'
    : state === 'chat'
      ? 'Open review panel'
      : 'Minimize right panel';
  const handleClick = state === 'collapsed'
    ? onToggleChat
    : onToggleWorkspacePanel;

  return (
    <motion.button
      type="button"
      aria-label={label}
      onClick={handleClick}
      initial={false}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 32,
        height: 32,
        padding: 0,
        border: 'none',
        borderRadius: 8,
        background: panelOpen ? 'var(--t-panel-active)' : 'transparent',
        color: panelOpen ? 'var(--t-text)' : 'var(--t-text-secondary)',
        cursor: 'pointer',
        flexShrink: 0,
        WebkitTapHighlightColor: 'transparent',
        transition: 'background 140ms ease, color 140ms ease',
        ['WebkitAppRegion' as string]: 'no-drag',
      }}
      onMouseEnter={(e) => {
        if (!panelOpen) {
          e.currentTarget.style.background = 'var(--t-hover)';
        }
      }}
      onMouseLeave={(e) => {
        if (!panelOpen) {
          e.currentTarget.style.background = 'transparent';
        }
      }}
    >
      <span style={{ position: 'relative', width: 16, height: 16, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
        <motion.span
          initial={false}
          animate={{
            opacity: state === 'chat' ? 1 : 0,
            scale: state === 'chat' ? 1 : 0.72,
            rotate: state === 'chat' ? 0 : -12,
          }}
          transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
          style={{ position: 'absolute', inset: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
        >
          <IconMessageSquare />
        </motion.span>
        <motion.span
          initial={false}
          animate={{
            opacity: state === 'review' ? 1 : 0,
            scale: state === 'review' ? 1 : 0.72,
            rotate: state === 'review' ? 0 : state === 'chat' ? 12 : -12,
          }}
          transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
          style={{ position: 'absolute', inset: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
        >
          <IconDelta />
        </motion.span>
        <motion.span
          initial={false}
          animate={{
            opacity: state === 'collapsed' ? 1 : 0,
            scale: state === 'collapsed' ? 1 : 0.72,
            rotate: state === 'collapsed' ? 0 : 12,
          }}
          transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
          style={{ position: 'absolute', inset: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
        >
          <IconPanelRightCollapse />
        </motion.span>
      </span>
    </motion.button>
  );
}

// ── Main Component ──

export function TitleBar({
  renderSearch,
  selectedRepoEntry = null,
  sidebarVisible = true,
  onToggleSidebar,
  bottomPanelVisible = true,
  onToggleBottomPanel,
  chatVisible = true,
  onToggleChat,
  workspacePanelVisible = false,
  onToggleWorkspacePanel,
  wsStatus = 'connecting',
}: TitleBarProps) {
  const [searchExpanded, setSearchExpanded] = useState(false);
  const [openMenuOpen, setOpenMenuOpen] = useState(false);
  const [availableEditors, setAvailableEditors] = useState<{ id: string; name: string; available: boolean }[]>([]);
  const selectedRepoPath = selectedRepoEntry?.localPath ?? '';
  const hasSelectedRepo = Boolean(selectedRepoEntry);

  // Fetch available editors on mount
  useEffect(() => {
    fetch('/api/panel/open-in')
      .then(r => r.json())
      .then(data => setAvailableEditors(data.editors ?? []))
      .catch(() => {});
  }, []);
  const headerRef = useRef<HTMLElement>(null);

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

  // ⌘K / ⇧⌘P keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const isCommandPaletteShortcut = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k';
      const isShiftPaletteShortcut = (e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'p';

      if (isCommandPaletteShortcut || isShiftPaletteShortcut) {
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
        gap: 8,
        flexShrink: 0,
      }}>
        {/* Spacer for macOS traffic lights (close/minimize/maximize) */}
        <div style={{ width: 78, flexShrink: 0 }} />

        {/* Live dot */}
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
          }}
        />

        {/* Sidebar toggle */}
        <TitleBarButton
          icon={<IconPanelLeft />}
          label="Toggle sidebar"
          onClick={onToggleSidebar}
          active={sidebarVisible}
        />
      </div>

      {/* ── Center — Search ── */}
      <div style={{
        flex: 1,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 0,
      }}>
        <div style={{
          width: '100%',
          maxWidth: searchExpanded ? 640 : 320,
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
              <span>Command Palette</span>
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

        <RightPanelMorphButton
          chatVisible={chatVisible}
          workspacePanelVisible={workspacePanelVisible}
          onToggleChat={onToggleChat}
          onToggleWorkspacePanel={onToggleWorkspacePanel}
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
