'use client';

import { useSyncExternalStore } from 'react';
import { useTheme, type ReduceTransparency } from '@/lib/theme/context';
import type { ThemePalette } from '@/lib/theme/registry';
import {
  readTimelineVisible,
  subscribeTimelineVisible,
  writeTimelineVisible,
} from '@/lib/appearance/timeline';
import {
  DEFAULT_DICTATION_INPUT_MODE,
  readDictationInputMode,
  subscribeDictationInputMode,
  writeDictationInputMode,
  type DictationInputMode,
} from '@/lib/appearance/dictation-input-mode';
import {
  APP_FONT_STACK,
  RAMS_ACCENT,
  RAMS_HAIRLINE_SOFT,
  RAMS_INK_QUIET,
  RAMS_CONTROL_ACTIVE_BORDER,
  ActivityIcon,
  LayersIcon,
  MicIcon,
  SettingsSegmented,
  TabBreadcrumb,
  TabHeading,
  SETTINGS_CONTENT_MAX_WIDTH,
} from './shared';
import { GroupHeader, SettingsGroup, SettingsRow } from './grouped';

// ── Palette Preview Card ────────────────────────────────────────────────────

function PalettePreviewCard({
  palette,
  active,
  onSelect,
}: {
  palette: ThemePalette;
  active: boolean;
  onSelect: () => void;
}) {
  const p = palette.preview;

  return (
    <button
      type="button"
      onClick={onSelect}
      style={{
        position: 'relative',
        width: 220,
        padding: 0,
        border: `1px solid ${active ? RAMS_CONTROL_ACTIVE_BORDER : RAMS_HAIRLINE_SOFT}`,
        borderRadius: 4,
        background: 'transparent',
        cursor: 'pointer',
        overflow: 'hidden',
        transition: 'border-color 160ms',
        fontFamily: APP_FONT_STACK,
      }}
    >
      <div
        style={{
          height: 130,
          background: p.bg,
          paddingTop: 8,
          paddingBottom: 8,
          paddingLeft: 8,
          paddingRight: 8,
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
        }}
      >
        <div
          style={{
            height: 10,
            borderRadius: 3,
            background: p.titlebar,
            display: 'flex',
            alignItems: 'center',
            paddingLeft: 4,
            paddingRight: 4,
            gap: 2,
          }}
        >
          <div style={{ width: 3, height: 3, borderRadius: '50%', background: '#ef4444', opacity: 0.7 }} />
          <div style={{ width: 3, height: 3, borderRadius: '50%', background: '#f59e0b', opacity: 0.7 }} />
          <div style={{ width: 3, height: 3, borderRadius: '50%', background: '#22c55e', opacity: 0.7 }} />
        </div>
        <div style={{ flex: 1, display: 'flex', gap: 3 }}>
          <div
            style={{
              width: 14,
              borderRadius: 3,
              background: p.nav,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              paddingTop: 4,
              paddingBottom: 4,
              gap: 3,
            }}
          >
            <div style={{ width: 6, height: 6, borderRadius: 2, background: p.accent, opacity: 0.6 }} />
            <div style={{ width: 6, height: 2, borderRadius: 1, background: p.textMuted, opacity: 0.3 }} />
            <div style={{ width: 6, height: 2, borderRadius: 1, background: p.textMuted, opacity: 0.3 }} />
          </div>
          <div
            style={{
              width: 46,
              borderRadius: 3,
              background: p.panel,
              paddingTop: 4,
              paddingBottom: 4,
              paddingLeft: 4,
              paddingRight: 4,
              display: 'flex',
              flexDirection: 'column',
              gap: 3,
            }}
          >
            <div style={{ height: 4, width: '70%', borderRadius: 1, background: p.text, opacity: 0.3 }} />
            <div style={{ height: 12, borderRadius: 2, background: p.bg, opacity: 0.6 }} />
            <div style={{ height: 12, borderRadius: 2, background: p.bg, opacity: 0.4 }} />
            <div style={{ height: 12, borderRadius: 2, background: p.bg, opacity: 0.3 }} />
          </div>
          <div
            style={{
              flex: 1,
              borderRadius: 3,
              background: p.bg,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <div
              style={{
                width: 16,
                height: 16,
                borderRadius: 3,
                border: `1px solid ${p.textMuted}40`,
                opacity: 0.3,
              }}
            />
          </div>
          <div
            style={{
              width: 46,
              borderRadius: 3,
              background: p.panel,
              paddingTop: 4,
              paddingBottom: 4,
              paddingLeft: 4,
              paddingRight: 4,
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'flex-end',
              gap: 3,
            }}
          >
            <div style={{ height: 6, width: '80%', borderRadius: 2, background: p.accent, opacity: 0.25, alignSelf: 'flex-end' }} />
            <div style={{ height: 8, width: '60%', borderRadius: 2, background: p.textMuted, opacity: 0.15 }} />
            <div style={{ height: 10, borderRadius: 3, background: p.bg, opacity: 0.5 }} />
          </div>
        </div>
      </div>

      <div style={{ height: 2, background: active ? RAMS_ACCENT : 'transparent' }} />

      <div
        style={{
          paddingTop: 10,
          paddingBottom: 12,
          paddingLeft: 14,
          paddingRight: 14,
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: 12,
        }}
      >
        <div style={{ fontSize: 13, fontWeight: 300, color: 'var(--t-text)', letterSpacing: '-0.01em' }}>
          {palette.name.toLowerCase()}
        </div>
        <div
          style={{
            fontFamily: APP_FONT_STACK,
            fontSize: 10,
            fontWeight: 400,
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
            color: active ? RAMS_ACCENT : RAMS_INK_QUIET,
          }}
        >
          {active ? '(active)' : ''}
        </div>
      </div>
    </button>
  );
}

// ── Session Timeline visibility toggle ──────────────────────────────────────

const noopSubscribe = () => () => {};
const falseSnapshot = () => false;

function useTimelineVisible(): [boolean, (next: boolean) => void] {
  const visible = useSyncExternalStore(
    typeof window !== 'undefined' ? subscribeTimelineVisible : noopSubscribe,
    typeof window !== 'undefined' ? readTimelineVisible : falseSnapshot,
    falseSnapshot,
  );
  return [visible, writeTimelineVisible];
}

// ── Dictation input mode toggle ───────────────────────────────────────────

const dictationModeFallback = (): DictationInputMode => DEFAULT_DICTATION_INPUT_MODE;

function useDictationInputMode(): [DictationInputMode, (next: DictationInputMode) => void] {
  const mode = useSyncExternalStore(
    typeof window !== 'undefined' ? subscribeDictationInputMode : noopSubscribe,
    typeof window !== 'undefined' ? readDictationInputMode : dictationModeFallback,
    dictationModeFallback,
  );
  return [mode, writeDictationInputMode];
}


// ── Appearance Tab ──────────────────────────────────────────────────────────

export function AppearanceTab() {
  const {
    paletteId,
    setPalette,
    palettes,
    reduceTransparency,
    setReduceTransparency,
  } = useTheme();
  const [timelineVisible, setTimelineVisible] = useTimelineVisible();
  const [dictationMode, setDictationMode] = useDictationInputMode();

  return (
    <div
      style={{
        paddingTop: 8,
        paddingLeft: 8,
        paddingRight: 32,
        paddingBottom: 40,
        maxWidth: SETTINGS_CONTENT_MAX_WIDTH,
        fontFamily: APP_FONT_STACK,
      }}
    >
      <TabBreadcrumb tab="appearance" />
      <TabHeading
        title="appearance"
        subtitle="Theme controls how o8 looks. Accent colors and status indicators stay consistent across themes."
      />

      <section>
        <GroupHeader>Palette</GroupHeader>

        <div style={{ display: 'flex', gap: 18, marginTop: 4, flexWrap: 'wrap' }}>
          {palettes.map((p) => (
            <PalettePreviewCard
              key={p.id}
              palette={p}
              active={paletteId === p.id}
              onSelect={() => setPalette(p.id)}
            />
          ))}
        </div>

      </section>

      <section style={{ marginTop: 36 }}>
        <SettingsGroup
          header="Interface"
          footnote="The session timeline is the live 24-hour activity strip below the title bar — every Codex and Claude session on this machine, red where errors showed up. Solid chrome swaps the translucent glass for opaque panels: easier on the eyes if the wallpaper bleed reads busy or low-contrast."
        >
          <SettingsRow
            icon={<ActivityIcon />}
            label="Session timeline"
            subtitle="Activity strip below the title bar"
            checked={timelineVisible}
            onToggle={setTimelineVisible}
            divider
          />
          <SettingsRow
            icon={<LayersIcon />}
            label="Window chrome"
            subtitle="Glass follows your wallpaper; solid is opaque"
            accessory={
              <SettingsSegmented
                value={reduceTransparency}
                onChange={(v) => setReduceTransparency(v as ReduceTransparency)}
                options={[
                  { value: 'system', label: 'System' },
                  { value: 'off', label: 'Glass' },
                  { value: 'on', label: 'Solid' },
                ]}
              />
            }
          />
        </SettingsGroup>
      </section>

      <section style={{ marginTop: 28 }}>
        <SettingsGroup
          header="Dictation"
          footnote="Tap: click the mic to start, click again to send. Hold: keep the mic (or Ctrl+Z) pressed while you speak, release to send. Ctrl+Z always behaves as hold."
        >
          <SettingsRow
            icon={<MicIcon />}
            label="Mic input"
            subtitle="How the mic button next to Send behaves"
            accessory={
              <SettingsSegmented
                value={dictationMode}
                onChange={(v) => setDictationMode(v as DictationInputMode)}
                options={[
                  { value: 'toggle', label: 'Tap' },
                  { value: 'hold', label: 'Hold' },
                ]}
              />
            }
          />
        </SettingsGroup>
      </section>
    </div>
  );
}
