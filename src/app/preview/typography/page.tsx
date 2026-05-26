'use client';

import { useState, type CSSProperties } from 'react';

const FONT_SYSTEM = 'var(--font-sans-system)';

const SAMPLE_ROWS = [
  { title: 'Ingest spec files to improve retrieval awareness', meta: 'main · idle' },
  { title: 'Review API rejection payload and trading mechanics', meta: 'main · 12m ago' },
  { title: 'Add image links and vacation theme to wedding page', meta: 'main · 38m ago' },
  { title: 'Analyze Discord MCP public chat messages', meta: 'main · 1h ago' },
  { title: 'Debug Symon voice command detection issue', meta: 'main · May 22' },
  { title: 'Check token limits and software evaluation', meta: 'main · May 20' },
  { title: 'MNQ futures trading plan and wellness goals', meta: 'main · Older' },
  { title: 'Clean up uncommitted files and fix stale docstring', meta: 'main · Older' },
  { title: 'Ship v0.1.66 and v0.1.67 releases', meta: 'main · Older' },
];

interface TypoState {
  titleSize: number;
  titleWeight: number;
  titleLetterSpacing: number;
  metaSize: number;
  metaWeight: number;
  metaLetterSpacing: number;
  lineHeight: number;
  headerSize: number;
  headerWeight: number;
  headerLetterSpacing: number;
  rowGap: number;
  rowPaddingY: number;
}

const DEFAULTS: TypoState = {
  titleSize: 13.5,
  titleWeight: 440,
  titleLetterSpacing: 0,
  metaSize: 11,
  metaWeight: 400,
  metaLetterSpacing: 0,
  lineHeight: 1.35,
  headerSize: 12.5,
  headerWeight: 440,
  headerLetterSpacing: 0,
  rowGap: 0,
  rowPaddingY: 5,
};

const PRESETS: { name: string; description: string; values: TypoState }[] = [
  {
    name: 'Current',
    description: 'What just landed in AgentPanel today.',
    values: DEFAULTS,
  },
  {
    name: 'Thinner',
    description: 'Lighter strokes, slightly larger, more breathing room.',
    values: {
      titleSize: 14,
      titleWeight: 380,
      titleLetterSpacing: -0.1,
      metaSize: 11.5,
      metaWeight: 380,
      metaLetterSpacing: 0,
      lineHeight: 1.45,
      headerSize: 13,
      headerWeight: 400,
      headerLetterSpacing: 0,
      rowGap: 0,
      rowPaddingY: 6,
    },
  },
  {
    name: 'Claude-like',
    description: 'Approximating the Claude desktop chat list we benchmarked.',
    values: {
      titleSize: 14.5,
      titleWeight: 420,
      titleLetterSpacing: -0.2,
      metaSize: 12,
      metaWeight: 400,
      metaLetterSpacing: 0,
      lineHeight: 1.4,
      headerSize: 13.5,
      headerWeight: 420,
      headerLetterSpacing: 0,
      rowGap: 2,
      rowPaddingY: 7,
    },
  },
  {
    name: 'Cursor-dense',
    description: 'Tighter, more rows on screen, slightly heavier.',
    values: {
      titleSize: 12.5,
      titleWeight: 460,
      titleLetterSpacing: 0,
      metaSize: 10.5,
      metaWeight: 420,
      metaLetterSpacing: 0,
      lineHeight: 1.3,
      headerSize: 11.5,
      headerWeight: 460,
      headerLetterSpacing: 0,
      rowGap: 0,
      rowPaddingY: 4,
    },
  },
];

export default function TypographyPreviewPage() {
  const [state, setState] = useState<TypoState>(DEFAULTS);

  const update = <K extends keyof TypoState>(key: K, value: TypoState[K]) =>
    setState((prev) => ({ ...prev, [key]: value }));

  return (
    <div
      style={{
        minHeight: '100vh',
        background: 'var(--t-bg, #f8f8f6)',
        color: 'var(--t-text, #111827)',
        fontFamily: FONT_SYSTEM,
        display: 'grid',
        gridTemplateColumns: '320px 1fr',
        gap: 0,
      }}
    >
      {/* Sidebar = customizer */}
      <aside
        style={{
          borderRight: '1px solid var(--t-divider, #e5e7eb)',
          padding: 20,
          display: 'flex',
          flexDirection: 'column',
          gap: 18,
          background: 'var(--t-panel, #ffffff)',
          overflowY: 'auto',
        }}
      >
        <header style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <h1 style={{ fontSize: 16, fontWeight: 540, margin: 0, letterSpacing: -0.2 }}>
            Typography lab
          </h1>
          <p style={{ fontSize: 12, color: 'var(--t-text-muted, #6b7280)', margin: 0, lineHeight: 1.4 }}>
            Tune the chat-row pattern live. Same font family as the app (system stack). Pick a preset, then nudge sliders to dial in the look. Settings are local to this page — apply them in code when you find what you like.
          </p>
        </header>

        <section style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <Label>Presets</Label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {PRESETS.map((preset) => (
              <button
                key={preset.name}
                type="button"
                onClick={() => setState(preset.values)}
                title={preset.description}
                style={{
                  padding: '5px 10px',
                  fontSize: 11.5,
                  borderRadius: 6,
                  border: '1px solid var(--t-divider, #e5e7eb)',
                  background: 'transparent',
                  cursor: 'pointer',
                  fontFamily: FONT_SYSTEM,
                  color: 'var(--t-text, #111827)',
                }}
              >
                {preset.name}
              </button>
            ))}
          </div>
        </section>

        <Slider label="Title size" suffix="px" value={state.titleSize} min={10} max={18} step={0.5}
          onChange={(v) => update('titleSize', v)} />
        <Slider label="Title weight" value={state.titleWeight} min={200} max={700} step={20}
          onChange={(v) => update('titleWeight', v)} />
        <Slider label="Title letter-spacing" suffix="px" value={state.titleLetterSpacing} min={-1} max={1} step={0.05}
          onChange={(v) => update('titleLetterSpacing', v)} />

        <Slider label="Meta size" suffix="px" value={state.metaSize} min={8} max={14} step={0.5}
          onChange={(v) => update('metaSize', v)} />
        <Slider label="Meta weight" value={state.metaWeight} min={200} max={700} step={20}
          onChange={(v) => update('metaWeight', v)} />
        <Slider label="Meta letter-spacing" suffix="px" value={state.metaLetterSpacing} min={-1} max={1} step={0.05}
          onChange={(v) => update('metaLetterSpacing', v)} />

        <Slider label="Line height" value={state.lineHeight} min={1.0} max={1.8} step={0.05}
          onChange={(v) => update('lineHeight', v)} />

        <Slider label="Header size" suffix="px" value={state.headerSize} min={10} max={18} step={0.5}
          onChange={(v) => update('headerSize', v)} />
        <Slider label="Header weight" value={state.headerWeight} min={200} max={700} step={20}
          onChange={(v) => update('headerWeight', v)} />
        <Slider label="Header letter-spacing" suffix="px" value={state.headerLetterSpacing} min={-1} max={1} step={0.05}
          onChange={(v) => update('headerLetterSpacing', v)} />

        <Slider label="Row gap" suffix="px" value={state.rowGap} min={0} max={12} step={1}
          onChange={(v) => update('rowGap', v)} />
        <Slider label="Row vertical padding" suffix="px" value={state.rowPaddingY} min={2} max={14} step={1}
          onChange={(v) => update('rowPaddingY', v)} />

        <section>
          <Label>Computed CSS</Label>
          <pre
            style={{
              fontSize: 10.5,
              lineHeight: 1.45,
              background: 'var(--t-input-bg, #fafafa)',
              border: '1px solid var(--t-divider, #e5e7eb)',
              borderRadius: 6,
              padding: 10,
              margin: 0,
              overflowX: 'auto',
              fontFamily: 'SF Mono, ui-monospace, monospace',
              color: 'var(--t-text, #111827)',
            }}
          >{`/* title */
fontSize: ${state.titleSize}px;
fontWeight: ${state.titleWeight};
letterSpacing: ${state.titleLetterSpacing}px;
lineHeight: ${state.lineHeight};

/* meta */
fontSize: ${state.metaSize}px;
fontWeight: ${state.metaWeight};
letterSpacing: ${state.metaLetterSpacing}px;

/* header */
fontSize: ${state.headerSize}px;
fontWeight: ${state.headerWeight};
letterSpacing: ${state.headerLetterSpacing}px;
textTransform: none;

/* row */
gap: ${state.rowGap}px;
padding: ${state.rowPaddingY}px 12px;`}</pre>
        </section>
      </aside>

      {/* Preview area = renders the sidebar shape with current settings */}
      <main style={{ padding: 32, display: 'flex', justifyContent: 'center', alignItems: 'flex-start' }}>
        <div
          style={{
            width: 320,
            background: 'var(--t-panel, #ffffff)',
            border: '1px solid var(--t-divider, #e5e7eb)',
            borderRadius: 12,
            padding: 4,
            paddingTop: 12,
            paddingBottom: 12,
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
            boxShadow: '0 1px 2px rgba(0,0,0,0.04)',
          }}
        >
          <SectionLabel state={state}>Today</SectionLabel>
          {SAMPLE_ROWS.slice(0, 4).map((r, i) => (
            <ChatRow key={`today-${i}`} row={r} state={state} />
          ))}
          <SectionLabel state={state}>May 22</SectionLabel>
          {SAMPLE_ROWS.slice(4, 5).map((r, i) => (
            <ChatRow key={`m22-${i}`} row={r} state={state} />
          ))}
          <SectionLabel state={state}>May 20</SectionLabel>
          {SAMPLE_ROWS.slice(5, 6).map((r, i) => (
            <ChatRow key={`m20-${i}`} row={r} state={state} />
          ))}
          <SectionLabel state={state}>Older</SectionLabel>
          {SAMPLE_ROWS.slice(6).map((r, i) => (
            <ChatRow key={`older-${i}`} row={r} state={state} />
          ))}
        </div>
      </main>
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{
        fontSize: 10.5,
        fontWeight: 540,
        letterSpacing: 0.04,
        textTransform: 'uppercase',
        color: 'var(--t-text-muted, #6b7280)',
        display: 'block',
        marginBottom: 4,
      }}
    >
      {children}
    </span>
  );
}

function Slider({
  label,
  value,
  min,
  max,
  step,
  suffix,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  suffix?: string;
  onChange: (value: number) => void;
}) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', fontSize: 11.5 }}>
        <span style={{ color: 'var(--t-text, #111827)', fontWeight: 440 }}>{label}</span>
        <span style={{ color: 'var(--t-text-muted, #6b7280)', fontFamily: 'SF Mono, ui-monospace, monospace', fontSize: 10.5 }}>
          {value}{suffix ?? ''}
        </span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ width: '100%' }}
      />
    </label>
  );
}

function SectionLabel({ state, children }: { state: TypoState; children: React.ReactNode }) {
  const style: CSSProperties = {
    paddingTop: 10,
    paddingRight: 12,
    paddingBottom: 4,
    paddingLeft: 12,
    fontSize: state.headerSize,
    fontWeight: state.headerWeight,
    letterSpacing: state.headerLetterSpacing,
    color: 'var(--t-text-faint, #9ca3af)',
    fontFamily: FONT_SYSTEM,
  };
  return <div style={style}>{children}</div>;
}

function ChatRow({ row, state }: { row: { title: string; meta: string }; state: TypoState }) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 1,
        paddingTop: state.rowPaddingY,
        paddingRight: 12,
        paddingBottom: state.rowPaddingY,
        paddingLeft: 12,
        marginBottom: state.rowGap,
        cursor: 'pointer',
        borderRadius: 6,
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--t-hover, #f4f4f5)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
    >
      <span
        style={{
          fontSize: state.titleSize,
          fontWeight: state.titleWeight,
          letterSpacing: state.titleLetterSpacing,
          lineHeight: state.lineHeight,
          color: 'var(--t-text, #111827)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          fontFamily: FONT_SYSTEM,
        }}
      >
        {row.title}
      </span>
      <span
        style={{
          fontSize: state.metaSize,
          fontWeight: state.metaWeight,
          letterSpacing: state.metaLetterSpacing,
          lineHeight: state.lineHeight,
          color: 'var(--t-text-faint, #9ca3af)',
          fontFamily: FONT_SYSTEM,
        }}
      >
        {row.meta}
      </span>
    </div>
  );
}
