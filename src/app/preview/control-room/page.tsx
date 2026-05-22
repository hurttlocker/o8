'use client';

/**
 * /preview/control-room — MOCKUP (visual only, hardcoded data).
 *
 * Proposes a wider "control-room mode" for the left project panel: same
 * left-anchored side panel, but expanded so the Control Room can breathe —
 * two-column layout (intake | pipeline+decisions), full issue titles, a
 * compact pipeline bar, and clearly-labelled Dispatch / Queue actions.
 * Not wired to anything. For visual review of the layout direction.
 */

import { useState, type CSSProperties, type ReactNode } from 'react';

const ACCENT = '#FF5A1F'; // Rams "one orange"
const PANEL_W = 760; // "control-room mode" width (vs ~330 in the normal drawer)

const UI = 'var(--font-sans-system)';
const MONO = "'iA Writer Mono', 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace";

interface IntakeIssue {
  title: string;
  repo: string;
  number: number;
  age: string;
  comments: number;
  kind: 'issue' | 'epic';
}

const ISSUES: IntakeIssue[] = [
  { title: 'o8.md review: move from pre-fill to background one-shot lane', repo: 'cortex-ide', number: 1102, age: '12h', comments: 2, kind: 'issue' },
  { title: 'Dev-mode cold reload is slow (~5–8s before workspace populates) — verify prod baseline', repo: 'cortex-ide', number: 1101, age: '1d', comments: 0, kind: 'issue' },
  { title: 'Audit: chat-title source of truth — tab.label vs chat-history.title vs threadId vs tabId', repo: 'cortex-ide', number: 1100, age: '1d', comments: 0, kind: 'issue' },
  { title: 'Consolidate project storage: drop JSON ledger for project↔repo mapping', repo: 'cortex-ide', number: 1099, age: '1d', comments: 0, kind: 'epic' },
  { title: 'Desktop status bar: tighten wiring + responsive layout', repo: 'cortex-ide', number: 1098, age: '1d', comments: 0, kind: 'issue' },
  { title: "Turn-summary cards — 'Worked for X min' rolled-up transcript blocks", repo: 'o8-site', number: 1096, age: '2d', comments: 0, kind: 'issue' },
];

// ── tiny raw-SVG icons (no react icon components in the webview) ──
function Icon({ d, size = 14, color = 'currentColor', sw = 2 }: { d: string; size?: number; color?: string; sw?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      {d.split('|').map((p, i) => <path key={i} d={p} />)}
    </svg>
  );
}
const I_CHEVRON_LEFT = 'm15 18-6-6 6-6';
const I_PLAY = 'm6 3 14 9-14 9V3z';
const I_PLUS = 'M12 5v14|M5 12h14';
const I_LOCK = 'M5 11h14v10H5z|M8 11V7a4 4 0 0 1 8 0v4';
const I_FOLDER = 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z';
const I_ARROW_R = 'M5 12h14|m12 5 7 7-7 7';

function SectionLabel({ index, children, count }: { index: string; children: ReactNode; count?: ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 12 }}>
      <span style={{ fontFamily: MONO, fontSize: 10.5, color: ACCENT, letterSpacing: '0.12em' }}>[{index}]</span>
      <span style={{ fontFamily: MONO, fontSize: 11, fontWeight: 500, color: 'var(--t-text)', textTransform: 'uppercase', letterSpacing: '0.18em' }}>{children}</span>
      {count != null ? <span style={{ fontFamily: MONO, fontSize: 10.5, color: 'var(--t-text-faint)', letterSpacing: '0.04em' }}>{count}</span> : null}
    </div>
  );
}

function RepoPill({ label, active }: { label: string; active?: boolean }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5, height: 24, paddingLeft: 9, paddingRight: 10,
      borderRadius: 7, fontFamily: UI, fontSize: 11.5, fontWeight: active ? 600 : 500,
      color: active ? 'var(--t-text)' : 'var(--t-text-muted)',
      background: active ? 'var(--t-hover)' : 'transparent',
      border: `0.5px solid ${active ? 'var(--t-divider)' : 'transparent'}`,
    }}>
      {active ? <span style={{ width: 5, height: 5, borderRadius: 999, background: ACCENT }} /> : null}
      {label}
    </span>
  );
}

function PipelineStat({ label, count, tone }: { label: string; count: number; tone?: string }) {
  const dim = count === 0;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontFamily: UI, fontSize: 11.5 }}>
      <span style={{ width: 6, height: 6, borderRadius: 999, background: dim ? 'var(--t-text-faint)' : (tone ?? ACCENT), opacity: dim ? 0.4 : 1 }} />
      <span style={{ fontWeight: 650, color: dim ? 'var(--t-text-faint)' : 'var(--t-text)' }}>{count}</span>
      <span style={{ color: dim ? 'var(--t-text-faint)' : 'var(--t-text-muted)' }}>{label}</span>
    </span>
  );
}

function IssueCard({ issue }: { issue: IntakeIssue }) {
  const [hover, setHover] = useState(false);
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        borderRadius: 12, border: '0.5px solid var(--t-divider-subtle)',
        background: hover ? 'var(--t-hover)' : 'var(--t-bg-card)',
        paddingTop: 11, paddingBottom: 11, paddingLeft: 13, paddingRight: 13,
        display: 'flex', flexDirection: 'column', gap: 9, transition: 'background 120ms',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 9 }}>
        <span style={{
          marginTop: 1, width: 16, height: 16, borderRadius: 5, flexShrink: 0,
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          background: issue.kind === 'epic' ? 'color-mix(in srgb, ' + ACCENT + ' 16%, transparent)' : 'var(--t-panel)',
          color: issue.kind === 'epic' ? ACCENT : 'var(--t-text-muted)',
          fontFamily: MONO, fontSize: 9, fontWeight: 700,
        }}>{issue.kind === 'epic' ? 'E' : '#'}</span>
        {/* full title — no truncation */}
        <span style={{ flex: 1, minWidth: 0, fontFamily: UI, fontSize: 13, fontWeight: 550, lineHeight: '18px', color: 'var(--t-text)', letterSpacing: '-0.01em' }}>
          {issue.title}
        </span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, paddingLeft: 25 }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontFamily: MONO, fontSize: 10.5, color: 'var(--t-text-muted)' }}>
          <Icon d={I_FOLDER} size={11} color="var(--t-text-faint)" sw={1.6} /> {issue.repo}
        </span>
        <span style={{ fontFamily: MONO, fontSize: 10.5, color: 'var(--t-text-faint)' }}>#{issue.number}</span>
        <span style={{ fontFamily: MONO, fontSize: 10.5, color: 'var(--t-text-faint)' }}>{issue.age}</span>
        {issue.comments > 0 ? <span style={{ fontFamily: MONO, fontSize: 10.5, color: 'var(--t-text-faint)' }}>{issue.comments} comments</span> : null}
        <span style={{ flex: 1 }} />
        {/* clear, labelled actions */}
        <button type="button" style={{
          display: 'inline-flex', alignItems: 'center', gap: 5, height: 26, paddingLeft: 9, paddingRight: 10,
          borderRadius: 7, border: '0.5px solid var(--t-divider)', background: 'transparent',
          color: 'var(--t-text-muted)', fontFamily: UI, fontSize: 11.5, fontWeight: 550, cursor: 'pointer',
        }}>
          <Icon d={I_PLUS} size={12} sw={2.2} /> Queue
        </button>
        <button type="button" style={{
          display: 'inline-flex', alignItems: 'center', gap: 6, height: 26, paddingLeft: 11, paddingRight: 12,
          borderRadius: 7, border: 'none', background: ACCENT, color: '#fff',
          fontFamily: UI, fontSize: 11.5, fontWeight: 650, cursor: 'pointer',
        }}>
          <Icon d={I_PLAY} size={11} color="#fff" sw={0} /> Dispatch
        </button>
      </div>
    </div>
  );
}

export default function ControlRoomWidePreview() {
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'var(--t-bg)', display: 'flex', fontFamily: UI }}>
      {/* the wide control-room side panel */}
      <div style={{
        width: PANEL_W, flexShrink: 0, height: '100%', display: 'flex', flexDirection: 'column',
        background: 'var(--t-panel-solid, var(--t-bg-card))', borderRight: '1px solid var(--t-divider)',
        boxShadow: '1px 0 0 var(--t-divider-subtle)',
      }}>
        {/* header */}
        <div style={{ paddingTop: 16, paddingBottom: 12, paddingLeft: 18, paddingRight: 16, borderBottom: '1px solid var(--t-divider-subtle)' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <button type="button" style={{ display: 'inline-flex', width: 24, height: 24, alignItems: 'center', justifyContent: 'center', borderRadius: 7, border: 'none', background: 'transparent', color: 'var(--t-text-muted)', cursor: 'pointer' }} title="Collapse to normal width">
                <Icon d={I_CHEVRON_LEFT} size={16} />
              </button>
              <div>
                <div style={{ fontFamily: MONO, fontSize: 9.5, letterSpacing: '0.22em', color: 'var(--t-text-faint)', textTransform: 'uppercase' }}>Project</div>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                  <span style={{ fontFamily: UI, fontSize: 17, fontWeight: 680, color: 'var(--t-text)', letterSpacing: '-0.02em' }}>o8</span>
                  <span style={{ fontFamily: MONO, fontSize: 11, color: 'var(--t-text-faint)' }}>3 repos</span>
                </div>
              </div>
            </div>
            {/* Control / Chats tabs */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 2, background: 'var(--t-panel)', borderRadius: 9, padding: 3, border: '0.5px solid var(--t-divider-subtle)' }}>
              <span style={{ height: 26, paddingLeft: 12, paddingRight: 12, display: 'inline-flex', alignItems: 'center', borderRadius: 7, fontFamily: UI, fontSize: 12, fontWeight: 600, color: 'var(--t-text)', background: 'var(--t-bg-card)', boxShadow: '0 1px 2px rgba(0,0,0,0.06)' }}>Control</span>
              <span style={{ height: 26, paddingLeft: 12, paddingRight: 12, display: 'inline-flex', alignItems: 'center', borderRadius: 7, fontFamily: UI, fontSize: 12, fontWeight: 500, color: 'var(--t-text-muted)' }}>Chats</span>
            </div>
          </div>
          {/* repo anchors */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <RepoPill label="All" active />
            <RepoPill label="cortex-ide" />
            <RepoPill label="o8-site" />
            <RepoPill label="o8-mobile" />
          </div>
        </div>

        {/* compact pipeline bar */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 16, height: 38, paddingLeft: 18, paddingRight: 16,
          borderBottom: '1px solid var(--t-divider-subtle)', background: 'var(--t-panel)',
        }}>
          <span style={{ fontFamily: MONO, fontSize: 9.5, letterSpacing: '0.18em', color: 'var(--t-text-faint)', textTransform: 'uppercase' }}>Pipeline</span>
          <PipelineStat label="blocked" count={1} tone="#ef4444" />
          <PipelineStat label="review" count={0} />
          <PipelineStat label="running" count={0} tone="#22c55e" />
          <PipelineStat label="ready" count={0} />
          <span style={{ flex: 1 }} />
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontFamily: UI, fontSize: 10.5, color: 'var(--t-text-muted)' }} title="Codex-only dispatch lock — 1 open">
            <Icon d={I_LOCK} size={11} color="var(--t-text-faint)" sw={1.8} /> Codex-only · 1 open
          </span>
        </div>

        {/* two-column body */}
        <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
          {/* LEFT — intake */}
          <div className="cortex-themed-scroll" style={{ flex: 1.7, minWidth: 0, overflowY: 'auto', paddingTop: 16, paddingBottom: 20, paddingLeft: 18, paddingRight: 16, borderRight: '1px solid var(--t-divider-subtle)' }}>
            <SectionLabel index="01" count="18 issues · 3 repos">GitHub Intake</SectionLabel>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {ISSUES.map((iss) => <IssueCard key={iss.number} issue={iss} />)}
            </div>
            <button type="button" style={{ marginTop: 10, width: '100%', height: 32, borderRadius: 9, border: '0.5px dashed var(--t-divider)', background: 'transparent', color: 'var(--t-text-muted)', fontFamily: UI, fontSize: 11.5, fontWeight: 550, cursor: 'pointer' }}>
              + 12 more issues in this scope
            </button>
          </div>

          {/* RIGHT — decisions + archive rail */}
          <div className="cortex-themed-scroll" style={{ flex: 1, minWidth: 0, overflowY: 'auto', paddingTop: 16, paddingBottom: 20, paddingLeft: 16, paddingRight: 18, display: 'flex', flexDirection: 'column', gap: 22 }}>
            <div>
              <SectionLabel index="02" count="1">Needs Decision</SectionLabel>
              <div style={{ borderRadius: 12, border: `0.5px solid color-mix(in srgb, #ef4444 40%, var(--t-divider))`, background: 'color-mix(in srgb, #ef4444 7%, var(--t-bg-card))', paddingTop: 12, paddingBottom: 12, paddingLeft: 13, paddingRight: 13, display: 'flex', flexDirection: 'column', gap: 9 }}>
                <div style={{ fontFamily: UI, fontSize: 13, fontWeight: 600, color: 'var(--t-text)', lineHeight: '18px' }}>Daily standup (edited)</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontFamily: MONO, fontSize: 10.5, color: 'var(--t-text-muted)' }}>
                  <span>cortex-ide</span><span style={{ color: 'var(--t-text-faint)' }}>·</span><span>Codex</span><span style={{ color: 'var(--t-text-faint)' }}>·</span><span>8h</span>
                </div>
                <div style={{ display: 'inline-flex', alignSelf: 'flex-start', alignItems: 'center', gap: 5, height: 20, paddingLeft: 7, paddingRight: 8, borderRadius: 6, background: 'color-mix(in srgb, #ef4444 14%, transparent)', color: '#ef4444', fontFamily: MONO, fontSize: 10, fontWeight: 600 }}>
                  silent_exit · autocommit_failed
                </div>
                <div style={{ display: 'flex', gap: 7, marginTop: 2 }}>
                  <button type="button" style={{ flex: 1, height: 28, borderRadius: 7, border: 'none', background: ACCENT, color: '#fff', fontFamily: UI, fontSize: 11.5, fontWeight: 650, cursor: 'pointer' }}>Retry</button>
                  <button type="button" style={{ flex: 1, height: 28, borderRadius: 7, border: '0.5px solid var(--t-divider)', background: 'transparent', color: 'var(--t-text)', fontFamily: UI, fontSize: 11.5, fontWeight: 550, cursor: 'pointer' }}>View log</button>
                </div>
              </div>
            </div>

            <div>
              <SectionLabel index="03">Done / Archived</SectionLabel>
              <button type="button" style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', height: 44, paddingLeft: 13, paddingRight: 12, borderRadius: 12, border: '0.5px solid var(--t-divider-subtle)', background: 'var(--t-bg-card)', cursor: 'pointer' }}>
                <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 1 }}>
                  <span style={{ fontFamily: UI, fontSize: 13, fontWeight: 650, color: 'var(--t-text)' }}>324</span>
                  <span style={{ fontFamily: MONO, fontSize: 10, color: 'var(--t-text-faint)', textTransform: 'uppercase', letterSpacing: '0.12em' }}>completed</span>
                </span>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontFamily: UI, fontSize: 11.5, color: 'var(--t-text-muted)' }}>
                  Browse <Icon d={I_ARROW_R} size={13} color="var(--t-text-faint)" sw={1.8} />
                </span>
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* faux dimmed workspace behind, to show this is the side panel expanded */}
      <div style={{ flex: 1, minWidth: 0, background: 'var(--t-bg)', display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative' }}>
        <div style={{ position: 'absolute', inset: 0, background: 'color-mix(in srgb, var(--t-text) 4%, transparent)' }} />
        <span style={{ fontFamily: MONO, fontSize: 11, color: 'var(--t-text-faint)', letterSpacing: '0.06em', position: 'relative' }}>workspace · dimmed while Control Room is wide</span>
      </div>
    </div>
  );
}
