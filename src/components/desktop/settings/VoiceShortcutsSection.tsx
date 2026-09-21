'use client';

import { Fragment } from 'react';
import { RAMS_ACCENT } from './shared';

// Gesture behavior lives in src-tauri/src/fn_hotkey.rs.
export function VoiceShortcutsSection({ externalFnActive }: { externalFnActive: boolean }) {
  const dictateKey = externalFnActive ? 'Fn or Left Control' : 'Fn';
  const shortcuts = [
    [`Hold ${dictateKey}`, 'Dictate into the focused text field. Release to finish and paste.'],
    [`Double-tap ${dictateKey}`, 'Start hands-free dictation. Tap the same key once to finish.'],
    ['Hold Right Option', 'Talk to Symon. Release to send your request.'],
    ['Double-tap Right Option', 'Record a longer request hands-free. Tap Right Option once to send.'],
    ['Hold Control + Z in o8', 'Dictate into the chat composer. Release to submit.'],
    ['Double-tap Right Command', 'Start or stop a realtime voice conversation. Requires voice setup.'],
    ['Escape', 'Cancel hands-free recording, stop spoken playback, or cancel active Symon tasks.'],
  ];

  return (
    <section style={{ marginBottom: 28 }}>
      <details data-settings-section="Voice shortcuts" style={{ border: '1px solid var(--t-panel-border)', borderRadius: 14, background: 'var(--t-bg-card)' }}>
        <summary style={{ cursor: 'pointer', padding: 14, color: RAMS_ACCENT, fontSize: 14, fontWeight: 500 }}>Voice shortcuts <span style={{ fontSize: 12, fontWeight: 400, color: 'var(--t-text-secondary)' }}>— quick tips</span></summary>
        <dl style={{ display: 'grid', gridTemplateColumns: 'minmax(120px, 0.8fr) minmax(0, 1.6fr)', columnGap: 16, rowGap: 12, margin: 0, padding: 16, fontSize: 12, lineHeight: 1.5 }}>
          {shortcuts.map(([keys, action]) => (
            <Fragment key={keys}>
              <dt style={{ margin: 0, fontWeight: 500, color: RAMS_ACCENT }}>{keys}</dt>
              <dd style={{ margin: 0, color: 'var(--t-text-secondary)' }}>{action}</dd>
            </Fragment>
          ))}
        </dl>
        <p style={{ margin: 0, paddingLeft: 16, paddingRight: 16, paddingBottom: 16, fontSize: 12, lineHeight: 1.5, color: 'var(--t-text-secondary)' }}>macOS shortcuts. Left Control can replace Fn on supported external keyboards when enabled below. Double-tap Symon itself to open its settings.</p>
      </details>
    </section>
  );
}
