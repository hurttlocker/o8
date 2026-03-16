'use client';

/**
 * TitleBar — Topmost bar across the entire application.
 *
 * Minimal, Apple-professional. Frosted glass.
 * Center: Search pill that expands into full UniversalSearch on click.
 * Right: Red settings gear icon.
 * Left: Window drag region for Tauri traffic lights.
 *
 * Sits ABOVE everything — nav rail, panels, canvas.
 * Height: 44px (Apple HIG).
 */

import { Settings, Search, X } from 'lucide-react';
import { useState, useCallback, useEffect, useRef } from 'react';

interface TitleBarProps {
  onSettingsClick?: () => void;
  /** Render prop: receives onClose callback, renders UniversalSearch */
  renderSearch?: (onClose: () => void) => React.ReactNode;
}

export function TitleBar({ onSettingsClick, renderSearch }: TitleBarProps) {
  const [searchExpanded, setSearchExpanded] = useState(false);
  const searchRef = useRef<HTMLDivElement>(null);

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
        justifyContent: 'space-between',
        padding: '0 16px',
        background: 'rgba(255, 255, 255, 0.72)',
        backdropFilter: 'blur(20px) saturate(1.6)',
        WebkitBackdropFilter: 'blur(20px) saturate(1.6)',
        borderBottom: '1px solid rgba(0, 0, 0, 0.06)',
        zIndex: 100,
        position: 'relative',
        ['WebkitAppRegion' as string]: 'drag',
      }}
    >
      {/* Left — drag region / spacing for traffic lights in Tauri */}
      <div style={{
        width: 78,
        flexShrink: 0,
        ['WebkitAppRegion' as string]: 'no-drag',
      }} />

      {/* Center — Search */}
      <div
        ref={searchRef}
        style={{
          flex: 1,
          maxWidth: searchExpanded ? 640 : 240,
          transition: 'max-width 250ms cubic-bezier(0.32, 0.72, 0, 1)',
          position: 'relative',
          ['WebkitAppRegion' as string]: 'no-drag',
        }}
      >
        {!searchExpanded ? (
          /* Collapsed: clickable pill */
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
          /* Expanded: live UniversalSearch with results dropdown */
          <div style={{ position: 'relative' }}>
            {renderSearch ? renderSearch(closeSearch) : null}
          </div>
        )}
      </div>

      {/* Right — Settings (red gear) */}
      <div style={{
        width: 78,
        flexShrink: 0,
        display: 'flex',
        justifyContent: 'flex-end',
        ['WebkitAppRegion' as string]: 'no-drag',
      }}>
        <button
          type="button"
          onClick={onSettingsClick}
          aria-label="Settings"
          style={{
            width: 32,
            height: 32,
            borderRadius: 8,
            border: 'none',
            background: 'transparent',
            color: '#ef4444',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            WebkitTapHighlightColor: 'transparent',
            transition: 'background 150ms ease, color 150ms ease',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'rgba(239, 68, 68, 0.08)';
            e.currentTarget.style.color = '#dc2626';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'transparent';
            e.currentTarget.style.color = '#ef4444';
          }}
        >
          <Settings size={18} strokeWidth={1.8} />
        </button>
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
