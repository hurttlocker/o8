'use client';

/**
 * KeyboardShortcutsOverlay — a glass reference card listing every real
 * keyboard shortcut wired in the desktop shell.
 *
 * Opened via ⌘/ (or `?` when not typing) and from the status-bar `?`
 * button. The shortcut list here is hand-kept in sync with the actual
 * handlers — do NOT add a row for a keybind that isn't wired, or the
 * card lies to the operator. Current sources of truth:
 *   - dashboard/page.tsx        → ⌘K, ⌘W, ⌘1-9, ⌘⌥←/→
 *   - ComposerArea.tsx          → Enter (send), ⌘⏎ (steer)
 *   - DictationHost.tsx         → hold Ctrl (push-to-talk)
 *   - src-tauri/src/lib.rs      → global voice shortcuts
 */

import { useEffect } from 'react';
import {
  overlayStyle,
  cardStyle,
  kbdStyle,
  sectionHeaderStyle,
} from './command-palette-styles';

interface KeyboardShortcutsOverlayProps {
  open: boolean;
  onClose: () => void;
}

/** A single chord (keys pressed together) rendered as adjacent kbd chips. */
type Chord = string[];

interface ShortcutRow {
  label: string;
  /** One or more chords. Multiple chords render separated by "or". */
  chords: Chord[];
}

interface ShortcutSection {
  title: string;
  rows: ShortcutRow[];
}

const SECTIONS: ShortcutSection[] = [
  {
    title: 'Navigation',
    rows: [
      { label: 'Command palette', chords: [['⌘', 'K']] },
      { label: 'Orchestrator quick actions', chords: [['⌘', '⇧', 'K']] },
      { label: 'Cycle tabs', chords: [['⌘', '⌥', '←'], ['⌘', '⌥', '→']] },
      { label: 'Jump to tab 1–9', chords: [['⌘', '1']] },
    ],
  },
  {
    title: 'Tabs',
    rows: [
      { label: 'New tab', chords: [['⌘', 'T']] },
      { label: 'Close active tab', chords: [['⌘', 'W']] },
    ],
  },
  {
    title: 'Panels',
    rows: [
      { label: 'Toggle left sidebar', chords: [['⌘', 'B']] },
      { label: 'Toggle right panel', chords: [['⌘', '⌥', 'B']] },
      { label: 'Canvas mode', chords: [['⌘', '⌥', 'C']] },
      { label: 'Toggle terminal', chords: [['⌘', 'J']] },
    ],
  },
  {
    title: 'Composer',
    rows: [
      { label: 'Send message', chords: [['↵']] },
      { label: 'Steer while running', chords: [['⌘', '↵']] },
    ],
  },
  {
    title: 'Voice',
    rows: [
      { label: 'Push-to-talk dictation', chords: [['Hold', '⌃']] },
      { label: 'Dictate anywhere → paste at caret', chords: [['Hold', 'Fn']] },
      { label: 'Long-form dictation (double-tap, tap to end)', chords: [['Fn', 'Fn']] },
      { label: 'Summon o8', chords: [['⌘', '⇧', 'Space']] },
      { label: 'Speak selected text', chords: [['⌃', '⇧', 'S']] },
      { label: 'Paste last dictation', chords: [['⌘', '⌥', 'V']] },
      { label: 'Open settings (anywhere)', chords: [['⌘', '⇧', ',']] },
    ],
  },
  {
    title: 'General',
    rows: [
      { label: 'Open settings', chords: [['⌘', ',']] },
      { label: 'Show this help', chords: [['⌘', '/']] },
      { label: 'Dismiss / close', chords: [['Esc']] },
    ],
  },
];

export function KeyboardShortcutsOverlay({ open, onClose }: KeyboardShortcutsOverlayProps) {
  useEffect(() => {
    if (!open) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Keyboard shortcuts"
      style={overlayStyle}
      onClick={onClose}
    >
      <div
        style={{ ...cardStyle, maxWidth: 460 }}
        onClick={(event) => event.stopPropagation()}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 10,
            paddingTop: 14,
            paddingRight: 14,
            paddingBottom: 12,
            paddingLeft: 16,
            borderBottom: '1px solid var(--t-divider, var(--t-border))',
          }}
        >
          <span style={{ fontSize: 13, fontWeight: 500, letterSpacing: '-0.01em' }}>
            Keyboard shortcuts
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close keyboard shortcuts"
            title="Close (Esc)"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 22,
              height: 22,
              borderWidth: 0,
              background: 'var(--t-hover)',
              borderRadius: 8,
              cursor: 'pointer',
              color: 'var(--t-text-muted)',
              padding: 0,
            }}
          >
            <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div
          style={{
            maxHeight: '60vh',
            overflowY: 'auto',
            WebkitOverflowScrolling: 'touch',
            paddingTop: 4,
            paddingBottom: 10,
          }}
        >
          {SECTIONS.map((section) => (
            <div key={section.title}>
              <div style={sectionHeaderStyle}>{section.title}</div>
              {section.rows.map((row) => (
                <div
                  key={row.label}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 16,
                    paddingTop: 7,
                    paddingRight: 16,
                    paddingBottom: 7,
                    paddingLeft: 16,
                  }}
                >
                  <span style={{ fontSize: 12.5, color: 'var(--t-text)', fontWeight: 300, letterSpacing: '-0.1px' }}>
                    {row.label}
                  </span>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                    {row.chords.map((chord, chordIndex) => (
                      <span key={chordIndex} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                        {chordIndex > 0 ? (
                          <span style={{ fontSize: 10, color: 'var(--t-text-faint)', fontWeight: 300 }}>or</span>
                        ) : null}
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                          {chord.map((key, keyIndex) => (
                            <kbd
                              key={keyIndex}
                              style={{
                                ...kbdStyle,
                                textTransform: 'none',
                                letterSpacing: 0,
                                minWidth: 18,
                                textAlign: 'center',
                              }}
                            >
                              {key}
                            </kbd>
                          ))}
                        </span>
                      </span>
                    ))}
                  </span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
