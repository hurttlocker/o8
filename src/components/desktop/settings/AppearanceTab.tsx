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
  MONO_FONT_STACK,
  RAMS_ACCENT,
  RAMS_HAIRLINE_SOFT,
  RAMS_INK_QUIET,
  RAMS_CONTROL_ACTIVE_BG,
  RAMS_CONTROL_ACTIVE_BORDER,
  RAMS_CONTROL_BG,
  RAMS_CONTROL_BORDER,
  HairlineRule,
  SectionLabel,
  TabBreadcrumb,
  TabHeading,
  SETTINGS_CONTENT_MAX_WIDTH,
} from './shared';

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
            fontFamily: MONO_FONT_STACK,
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

// ── Reduce Transparency selector ────────────────────────────────────────────

interface TransparencyOption {
  id: ReduceTransparency;
  label: string;
  caption: string;
}

const TRANSPARENCY_OPTIONS: TransparencyOption[] = [
  {
    id: 'system',
    label: 'match system',
    caption: 'Follow macOS Accessibility setting.',
  },
  {
    id: 'off',
    label: 'off — glass chrome',
    caption: 'Translucent chrome over the OS vibrancy backdrop. Default look.',
  },
  {
    id: 'on',
    label: 'on — solid chrome',
    caption: 'Fully opaque chrome. Reduces motion-induced visual fatigue and improves contrast for low vision.',
  },
];

function TransparencyOptionRow({
  option,
  active,
  onSelect,
}: {
  option: TransparencyOption;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 12,
        width: '100%',
        textAlign: 'left',
        padding: 14,
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: active ? RAMS_CONTROL_ACTIVE_BORDER : RAMS_CONTROL_BORDER,
        borderRadius: 6,
        background: active ? RAMS_CONTROL_ACTIVE_BG : RAMS_CONTROL_BG,
        cursor: 'pointer',
        fontFamily: APP_FONT_STACK,
        transition: 'border-color 160ms, background 160ms',
      }}
    >
      <span
        aria-hidden
        style={{
          width: 14,
          height: 14,
          borderRadius: '50%',
          flexShrink: 0,
          marginTop: 2,
          border: `1.5px solid ${active ? RAMS_ACCENT : 'var(--t-text-muted, #9A968E)'}`,
          background: active ? RAMS_ACCENT : 'transparent',
          boxShadow: active ? 'inset 0 0 0 3px var(--t-bg-card, rgba(255,255,255,0.4))' : 'none',
          transition: 'background 160ms, border-color 160ms',
        }}
      />
      <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span
          style={{
            fontFamily: MONO_FONT_STACK,
            fontSize: 11.5,
            fontWeight: 300,
            letterSpacing: '0.04em',
            textTransform: 'uppercase',
            color: active ? RAMS_ACCENT : 'var(--t-text)',
          }}
        >
          {option.label}
        </span>
        <span style={{ fontSize: 12.5, color: RAMS_INK_QUIET, lineHeight: 1.45 }}>
          {option.caption}
        </span>
      </span>
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

function DictationInputModeToggle() {
  const [mode, setMode] = useDictationInputMode();
  const options: Array<{ value: DictationInputMode; label: string; caption: string }> = [
    {
      value: 'toggle',
      label: 'tap — click to start, click to send',
      caption: 'Single tap on the mic icon starts recording. Tap again to stop and submit. Easier on the hands for long dictations.',
    },
    {
      value: 'hold',
      label: 'hold — press and hold while speaking',
      caption: 'Press and hold the mic icon (or Ctrl+Z) for the duration of your phrase. Release to submit. Ctrl+Z always uses hold even in tap mode.',
    },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 620 }}>
      {options.map((opt) => {
        const active = mode === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => setMode(opt.value)}
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 12,
              width: '100%',
              textAlign: 'left',
              padding: 14,
              borderWidth: 1,
              borderStyle: 'solid',
              borderColor: active ? RAMS_CONTROL_ACTIVE_BORDER : RAMS_CONTROL_BORDER,
              borderRadius: 6,
              background: active ? RAMS_CONTROL_ACTIVE_BG : RAMS_CONTROL_BG,
              cursor: 'pointer',
              fontFamily: APP_FONT_STACK,
              transition: 'border-color 160ms, background 160ms',
            }}
          >
            <span
              aria-hidden
              style={{
                width: 14,
                height: 14,
                borderRadius: '50%',
                flexShrink: 0,
                marginTop: 2,
                border: `1.5px solid ${active ? RAMS_ACCENT : 'var(--t-text-muted, #9A968E)'}`,
                background: active ? RAMS_ACCENT : 'transparent',
                boxShadow: active ? 'inset 0 0 0 3px var(--t-bg-card, rgba(255,255,255,0.4))' : 'none',
                transition: 'background 160ms, border-color 160ms',
              }}
            />
            <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <span
                style={{
                  fontFamily: MONO_FONT_STACK,
                  fontSize: 11.5,
                  fontWeight: 300,
                  letterSpacing: '0.04em',
                  textTransform: 'uppercase',
                  color: active ? RAMS_ACCENT : 'var(--t-text)',
                }}
              >
                {opt.label}
              </span>
              <span style={{ fontSize: 12.5, color: RAMS_INK_QUIET, lineHeight: 1.45 }}>
                {opt.caption}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

function TimelineVisibilityToggle() {
  const [visible, setVisible] = useTimelineVisible();
  const options: Array<{ value: boolean; label: string; caption: string }> = [
    {
      value: true,
      label: 'show — strip below title bar',
      caption: 'Live 24-hour activity strip. Click red cells to drill into errors.',
    },
    {
      value: false,
      label: 'hide — reclaim the row',
      caption: 'Frees ~32px at the top of every workspace. Toggle back here anytime.',
    },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 620 }}>
      {options.map((opt) => {
        const active = visible === opt.value;
        return (
          <button
            key={String(opt.value)}
            type="button"
            onClick={() => setVisible(opt.value)}
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 12,
              width: '100%',
              textAlign: 'left',
              padding: 14,
              borderWidth: 1,
              borderStyle: 'solid',
              borderColor: active ? RAMS_CONTROL_ACTIVE_BORDER : RAMS_CONTROL_BORDER,
              borderRadius: 6,
              background: active ? RAMS_CONTROL_ACTIVE_BG : RAMS_CONTROL_BG,
              cursor: 'pointer',
              fontFamily: APP_FONT_STACK,
              transition: 'border-color 160ms, background 160ms',
            }}
          >
            <span
              aria-hidden
              style={{
                width: 14,
                height: 14,
                borderRadius: '50%',
                flexShrink: 0,
                marginTop: 2,
                border: `1.5px solid ${active ? RAMS_ACCENT : 'var(--t-text-muted, #9A968E)'}`,
                background: active ? RAMS_ACCENT : 'transparent',
                boxShadow: active ? 'inset 0 0 0 3px var(--t-bg-card, rgba(255,255,255,0.4))' : 'none',
                transition: 'background 160ms, border-color 160ms',
              }}
            />
            <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <span
                style={{
                  fontFamily: MONO_FONT_STACK,
                  fontSize: 11.5,
                  fontWeight: 300,
                  letterSpacing: '0.04em',
                  textTransform: 'uppercase',
                  color: active ? RAMS_ACCENT : 'var(--t-text)',
                }}
              >
                {opt.label}
              </span>
              <span style={{ fontSize: 12.5, color: RAMS_INK_QUIET, lineHeight: 1.45 }}>
                {opt.caption}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
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
        <SectionLabel number="01">PALETTE</SectionLabel>

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

        <div style={{ marginTop: 28 }}>
          <HairlineRule />
        </div>
      </section>

      <section style={{ marginTop: 32 }}>
        <SectionLabel number="02">SESSION TIMELINE</SectionLabel>
        <p
          style={{
            margin: 0,
            marginTop: 4,
            marginBottom: 14,
            fontSize: 13,
            lineHeight: 1.55,
            color: 'var(--t-text-secondary)',
            maxWidth: 620,
          }}
        >
          The 24-hour activity strip that lives below the title bar. Surfaces every
          Codex and Claude Code session on this machine — colored by what each
          minute was spent on (thinking, coding, testing) and red when an error
          showed up. Hide it if you&apos;d rather work without the live signal.
        </p>

        <TimelineVisibilityToggle />

        <div style={{ marginTop: 28 }}>
          <HairlineRule />
        </div>
      </section>

      <section style={{ marginTop: 32 }}>
        <SectionLabel number="03">REDUCE TRANSPARENCY</SectionLabel>
        <p
          style={{
            margin: 0,
            marginTop: 4,
            marginBottom: 14,
            fontSize: 13,
            lineHeight: 1.55,
            color: 'var(--t-text-secondary)',
            maxWidth: 620,
          }}
        >
          Glass chrome bleeds the desktop wallpaper through panels and the title bar.
          Some users find that visually fatiguing or low-contrast — solid mode swaps every
          chrome surface to an opaque palette color.
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 620 }}>
          {TRANSPARENCY_OPTIONS.map((opt) => (
            <TransparencyOptionRow
              key={opt.id}
              option={opt}
              active={reduceTransparency === opt.id}
              onSelect={() => setReduceTransparency(opt.id)}
            />
          ))}
        </div>

        <div style={{ marginTop: 28 }}>
          <HairlineRule />
        </div>
      </section>

      <section style={{ marginTop: 32 }}>
        <SectionLabel number="04">DICTATION</SectionLabel>
        <p
          style={{
            margin: 0,
            marginTop: 4,
            marginBottom: 14,
            fontSize: 13,
            lineHeight: 1.55,
            color: 'var(--t-text-secondary)',
            maxWidth: 620,
          }}
        >
          The mic icon next to Send drops voice input into the composer. We
          transcribe with Whisper Turbo, then a Gemini polish pass formats
          file paths and code identifiers correctly. Choose how clicking the
          mic should feel.
        </p>

        <DictationInputModeToggle />

        <div style={{ marginTop: 28 }}>
          <HairlineRule />
        </div>
      </section>
    </div>
  );
}
