'use client';

/**
 * TitleBar — Topmost bar across the entire application.
 *
 * Minimal, Apple-professional. Frosted glass.
 * Center: "Search" pill (clickable, triggers ⌘K search).
 * Right: Settings gear icon.
 * Left: Empty (or window drag region for Tauri).
 *
 * This bar sits ABOVE everything — nav rail, panels, canvas.
 * Height: 44px (Apple HIG touch target).
 */

import { Settings, Search } from 'lucide-react';

interface TitleBarProps {
  onSearchClick?: () => void;
  onSettingsClick?: () => void;
}

export function TitleBar({ onSearchClick, onSettingsClick }: TitleBarProps) {
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
        // Tauri: make the bar draggable for window movement
        ['WebkitAppRegion' as string]: 'drag',
      }}
    >
      {/* Left — drag region / spacing for traffic lights in Tauri */}
      <div style={{
        width: 78,
        flexShrink: 0,
        ['WebkitAppRegion' as string]: 'no-drag',
      }} />

      {/* Center — Search pill */}
      <button
        type="button"
        onClick={onSearchClick}
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
          ['WebkitAppRegion' as string]: 'no-drag',
          transition: 'background 150ms ease, border-color 150ms ease',
          minWidth: 200,
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

      {/* Right — Settings */}
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
            color: '#8e8e93',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            WebkitTapHighlightColor: 'transparent',
            transition: 'background 150ms ease, color 150ms ease',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'rgba(0, 0, 0, 0.04)';
            e.currentTarget.style.color = '#6b7280';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'transparent';
            e.currentTarget.style.color = '#8e8e93';
          }}
        >
          <Settings size={18} strokeWidth={1.8} />
        </button>
      </div>
    </header>
  );
}
