'use client';

/**
 * /voice-settings — the standalone Voice settings window (Symon parity).
 *
 * Rendered in a dedicated Tauri window ("voice-settings") that the dock opens on
 * double-tap (`open_voice_settings`). It works even when the main o8 window is
 * closed — the dock is always-on, so this is the way to reach ALL the voice
 * settings when the dock is all the user is running. Reuses the same VoiceTab
 * as the main settings overlay; wraps it in its own ThemeProvider since this is
 * a separate window with no dashboard shell.
 */

import { ThemeProvider } from '@/lib/theme/context';
import { VoiceTab } from '@/components/desktop/settings/VoiceTab';

export const dynamic = 'force-dynamic';

export default function VoiceSettingsPage() {
  return (
    <ThemeProvider>
      <div
        style={{
          minHeight: '100vh',
          background: 'var(--t-bg-app, #1C1C1E)',
          color: 'var(--t-text)',
          overflowY: 'auto',
          paddingTop: 12,
          paddingBottom: 24,
        }}
      >
        <VoiceTab />
      </div>
    </ThemeProvider>
  );
}
