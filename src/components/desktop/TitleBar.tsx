'use client';

/**
 * TitleBar — Topmost bar across the entire application.
 *
 * Layout (matching Cursor/Claude Code pattern):
 * Left:  [Sidebar toggle] [← Back] [→ Forward]
 * Center: [Search pill / expanded UniversalSearch]
 * Right: [Bottom panel toggle] [Chat toggle] [Settings gear (red)]
 *
 * Sits ABOVE everything. Height: 44px. Frosted glass.
 */

import {
  Settings,
  Search,
  PanelLeft,
  PanelBottom,
  MessageSquare,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import { useState, useCallback, useEffect, useRef } from 'react';

// ── Types ──

interface TitleBarProps {
  onSettingsClick?: () => void;
  renderSearch?: (onClose: () => void) => React.ReactNode;
  // Panel toggles
  sidebarVisible?: boolean;
  onToggleSidebar?: () => void;
  bottomPanelVisible?: boolean;
  onToggleBottomPanel?: () => void;
  chatVisible?: boolean;
  onToggleChat?: () => void;
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
  const defaultColor = color ?? '#6b7280';
  const defaultHoverBg = hoverBg ?? 'rgba(0, 0, 0, 0.05)';

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
        background: active ? 'rgba(0, 0, 0, 0.06)' : 'transparent',
        color: active ? '#111827' : defaultColor,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'pointer',
        WebkitTapHighlightColor: 'transparent',
        transition: 'background 120ms ease, color 120ms ease',
        flexShrink: 0,
      }}
      onMouseEnter={(e) => {
        if (!active) {
          e.currentTarget.style.background = defaultHoverBg;
          if (color) e.currentTarget.style.color = color;
        }
      }}
      onMouseLeave={(e) => {
        if (!active) {
          e.currentTarget.style.background = 'transparent';
          e.currentTarget.style.color = active ? '#111827' : defaultColor;
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
      background: 'rgba(0, 0, 0, 0.08)',
      margin: '0 4px',
      flexShrink: 0,
    }} />
  );
}

// ── Main Component ──

export function TitleBar({
  onSettingsClick,
  renderSearch,
  sidebarVisible = true,
  onToggleSidebar,
  bottomPanelVisible = true,
  onToggleBottomPanel,
  chatVisible = true,
  onToggleChat,
}: TitleBarProps) {
  const [searchExpanded, setSearchExpanded] = useState(false);

  // ⌘K keyboard shortcut
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setSearchExpanded(prev => !prev);
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
      data-tauri-drag-region=""
      style={{
        height: 44,
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        padding: '0 12px',
        gap: 4,
        background: 'rgba(255, 255, 255, 0.72)',
        backdropFilter: 'blur(20px) saturate(1.6)',
        WebkitBackdropFilter: 'blur(20px) saturate(1.6)',
        borderBottom: '1px solid rgba(0, 0, 0, 0.06)',
        zIndex: 100,
        position: 'relative',
        ['WebkitAppRegion' as string]: 'drag',
      }}
    >
      {/* ── Left controls ── */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 2,
        flexShrink: 0,
        ['WebkitAppRegion' as string]: 'no-drag',
      }}>
        {/* Sidebar toggle */}
        <TitleBarButton
          icon={<PanelLeft size={16} strokeWidth={1.8} />}
          label="Toggle sidebar"
          onClick={onToggleSidebar}
          active={sidebarVisible}
        />

        <TitleBarSep />

        {/* Back */}
        <TitleBarButton
          icon={<ChevronLeft size={16} strokeWidth={2} />}
          label="Go back"
          onClick={() => window.history.back()}
        />

        {/* Forward */}
        <TitleBarButton
          icon={<ChevronRight size={16} strokeWidth={2} />}
          label="Go forward"
          onClick={() => window.history.forward()}
        />
      </div>

      {/* ── Center — Search ── */}
      <div style={{
        flex: 1,
        display: 'flex',
        justifyContent: 'center',
        ['WebkitAppRegion' as string]: 'no-drag',
      }}>
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
                border: '1px solid rgba(0, 0, 0, 0.06)',
                background: 'rgba(0, 0, 0, 0.03)',
                color: '#8e8e93',
                fontSize: 13,
                fontWeight: 500,
                letterSpacing: '-0.01em',
                cursor: 'pointer',
                WebkitTapHighlightColor: 'transparent',
                transition: 'background 150ms ease, border-color 150ms ease',
                width: '100%',
                justifyContent: 'center',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'rgba(0, 0, 0, 0.05)';
                e.currentTarget.style.borderColor = 'rgba(0, 0, 0, 0.1)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'rgba(0, 0, 0, 0.03)';
                e.currentTarget.style.borderColor = 'rgba(0, 0, 0, 0.06)';
              }}
            >
              <Search size={14} strokeWidth={2} style={{ color: '#aeaeb2' }} />
              <span>Search</span>
              <kbd style={{
                fontSize: 10,
                fontWeight: 500,
                color: '#aeaeb2',
                background: 'rgba(0, 0, 0, 0.04)',
                border: '1px solid rgba(0, 0, 0, 0.06)',
                borderRadius: 4,
                padding: '1px 5px',
                marginLeft: 8,
                fontFamily: '-apple-system, BlinkMacSystemFont, system-ui, sans-serif',
              }}>
                ⌘K
              </kbd>
            </button>
          ) : (
            <div style={{ position: 'relative' }}>
              {renderSearch ? renderSearch(closeSearch) : null}
            </div>
          )}
        </div>
      </div>

      {/* ── Right controls ── */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 2,
        flexShrink: 0,
        ['WebkitAppRegion' as string]: 'no-drag',
      }}>
        {/* Bottom panel toggle */}
        <TitleBarButton
          icon={<PanelBottom size={16} strokeWidth={1.8} />}
          label="Toggle bottom panel"
          onClick={onToggleBottomPanel}
          active={bottomPanelVisible}
        />

        {/* Chat panel toggle */}
        <TitleBarButton
          icon={<MessageSquare size={16} strokeWidth={1.8} />}
          label="Toggle chat"
          onClick={onToggleChat}
          active={chatVisible}
        />

        <TitleBarSep />

        {/* Settings — red */}
        <TitleBarButton
          icon={<Settings size={18} strokeWidth={1.8} />}
          label="Settings"
          onClick={onSettingsClick}
          color="#ef4444"
          hoverBg="rgba(239, 68, 68, 0.08)"
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
