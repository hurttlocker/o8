'use client';

import { useEffect, useRef } from 'react';

const KEYFRAMES = `
@keyframes o8-dash-travel {
  0%   { stroke-dashoffset: 0; }
  100% { stroke-dashoffset: -100; }
}
`;

const INFINITY_PATH = 'M-12,0 C-12,-7 -4,-7 0,0 C4,7 12,7 12,0 C12,-7 4,-7 0,0 C-4,7 -12,7 -12,0Z';

type Mode = 'idle' | 'thinking' | 'working' | 'attention' | 'error' | 'offline';

function InfinityGlow({ color, mode = 'idle', size = 1 }: { color: string; mode?: Mode; size?: number }) {
  const w = Math.round(28 * size);
  const h = Math.round(14 * size);
  const stroke = 1.2 * size;

  if (mode === 'idle') {
    return (
      <svg width={w} height={h} viewBox="-14 -8 28 16" style={{ overflow: 'visible' }}>
        <path d={INFINITY_PATH} fill="none" stroke={`${color}33`} strokeWidth={stroke} strokeLinecap="round" />
      </svg>
    );
  }
  if (mode === 'offline') {
    return (
      <svg width={w} height={h} viewBox="-14 -8 28 16" style={{ overflow: 'visible', opacity: 0.35 }}>
        <path d={INFINITY_PATH} fill="none" stroke={`${color}22`} strokeWidth={stroke} strokeLinecap="round" />
      </svg>
    );
  }

  const config = {
    thinking:  { speed: 3.2, dashOn: 10, dashOff: 40, glow: 0.4, pathOpacity: '18' },
    working:   { speed: 1.8, dashOn: 14, dashOff: 36, glow: 0.7, pathOpacity: '22' },
    attention: { speed: 1.2, dashOn: 18, dashOff: 32, glow: 0.9, pathOpacity: '28' },
    error:     { speed: 0.8, dashOn: 20, dashOff: 30, glow: 1.0, pathOpacity: '30' },
  }[mode] ?? { speed: 3, dashOn: 10, dashOff: 40, glow: 0.4, pathOpacity: '18' };

  return (
    <svg width={w} height={h} viewBox="-14 -8 28 16" style={{ overflow: 'visible' }}>
      <path d={INFINITY_PATH} fill="none" stroke={`${color}${config.pathOpacity}`} strokeWidth={stroke} strokeLinecap="round" />
      <path d={INFINITY_PATH} fill="none" stroke={color} strokeWidth={stroke + 2} strokeLinecap="round"
        strokeDasharray={`${config.dashOn} ${config.dashOff}`}
        style={{ animation: `o8-dash-travel ${config.speed}s linear infinite`, filter: 'blur(3px)', opacity: config.glow * 0.5 }} />
      <path d={INFINITY_PATH} fill="none" stroke={color} strokeWidth={stroke} strokeLinecap="round"
        strokeDasharray={`${config.dashOn} ${config.dashOff}`}
        style={{ animation: `o8-dash-travel ${config.speed}s linear infinite`, filter: `drop-shadow(0 0 2px ${color})` }} />
    </svg>
  );
}

const MODES: { mode: Mode; label: string; desc: string; color: string }[] = [
  { mode: 'working',   label: 'Working',   desc: 'Actively coding — fast, confident loop',   color: '#22c55e' },
  { mode: 'thinking',  label: 'Thinking',  desc: 'Reviewing, waiting, planning — slow drift', color: '#3b82f6' },
  { mode: 'attention', label: 'Attention',  desc: 'Merge ready, needs operator — urgent glow', color: '#16a34a' },
  { mode: 'error',     label: 'Blocked',    desc: 'Error or blocked — rapid, hot',             color: '#ef4444' },
  { mode: 'idle',      label: 'Idle',       desc: 'Connected but quiet — dim static path',     color: '#64748b' },
  { mode: 'offline',   label: 'Offline',    desc: 'Disconnected — barely visible',             color: '#6b7280' },
];

const SIZES = [0.5, 0.65, 0.8, 1, 1.4, 2];

export default function PreviewPage() {
  const injected = useRef(false);
  useEffect(() => {
    if (!injected.current) {
      const s = document.createElement('style');
      s.textContent = KEYFRAMES;
      document.head.appendChild(s);
      injected.current = true;
    }
  }, []);

  return (
    <div style={{
      minHeight: '100vh',
      background: '#0a0a0a',
      color: '#e2e8f0',
      fontFamily: 'system-ui, -apple-system, sans-serif',
      padding: 48,
      display: 'flex',
      flexDirection: 'column',
      gap: 48,
    }}>
      <div>
        <h1 style={{ fontSize: 24, fontWeight: 700, letterSpacing: '-0.02em', margin: 0 }}>
          Infinity Glow — Fine Tuning
        </h1>
        <p style={{ fontSize: 13, color: '#94a3b8', marginTop: 6 }}>
          Each state at multiple sizes. Tweak speed, dash length, glow intensity.
        </p>
      </div>

      {/* ── Each mode row with size variants ── */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 36 }}>
        {MODES.map(({ mode, label, desc, color }) => (
          <div key={mode} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div>
              <span style={{ fontSize: 15, fontWeight: 700 }}>{label}</span>
              <span style={{ fontSize: 11, color: '#64748b', marginLeft: 10 }}>{desc}</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 24, paddingLeft: 8, flexWrap: 'wrap' }}>
              {SIZES.map((sz) => (
                <div key={sz} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
                  <div style={{
                    minWidth: 64,
                    height: 44,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    borderRadius: 12,
                    background: 'rgba(255,255,255,0.04)',
                    border: '1px solid rgba(255,255,255,0.06)',
                    padding: '0 8px',
                  }}>
                    <InfinityGlow color={color} mode={mode} size={sz} />
                  </div>
                  <span style={{ fontSize: 9, color: '#475569' }}>{sz}x</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* ── Simulated agent chips ── */}
      <div>
        <h2 style={{ fontSize: 16, fontWeight: 700, margin: '0 0 16px' }}>In Agent Chips (0.5x)</h2>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {MODES.filter((m) => m.mode !== 'offline').map(({ mode, label, color }) => {
            const chipLabel = mode === 'working' ? '2 active' : mode === 'thinking' ? '1 in review' : mode === 'attention' ? '1 merge ready' : mode === 'error' ? '1 blocked' : '3 idle';
            return (
              <div key={mode} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <span style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 5,
                  padding: '3px 8px',
                  borderRadius: 999,
                  background: `${color}14`,
                  color,
                  border: `1px solid ${color}24`,
                  fontSize: 11,
                  fontWeight: 700,
                  letterSpacing: '0.01em',
                }}>
                  <InfinityGlow color={color} mode={mode} size={0.5} />
                  {chipLabel}
                </span>
                <span style={{ fontSize: 10, color: '#475569' }}>{label}</span>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Simulated agent rows (0.65x) ── */}
      <div>
        <h2 style={{ fontSize: 16, fontWeight: 700, margin: '0 0 16px' }}>In Agent Rows (0.65x)</h2>
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
          background: 'rgba(255,255,255,0.03)',
          borderRadius: 14,
          padding: 12,
          border: '1px solid rgba(255,255,255,0.06)',
          maxWidth: 400,
        }}>
          {[
            { label: 'Codex worktree/feat-auth', mode: 'working' as Mode, color: '#22c55e', status: 'Working' },
            { label: 'Claude Code main', mode: 'thinking' as Mode, color: '#3b82f6', status: 'In Review' },
            { label: 'Codex worktree/fix-nav', mode: 'attention' as Mode, color: '#16a34a', status: 'Merge Ready' },
            { label: 'Hawk heartbeat', mode: 'idle' as Mode, color: '#64748b', status: '' },
          ].map((agent, i) => (
            <div key={i} style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 8,
              padding: '8px 10px',
              borderRadius: 8,
              background: agent.mode === 'working' ? 'rgba(34,197,94,0.08)' : agent.mode === 'thinking' ? 'rgba(59,130,246,0.06)' : agent.mode === 'attention' ? 'rgba(22,163,74,0.06)' : 'transparent',
              border: agent.mode !== 'idle' ? `1px solid ${agent.color}22` : '1px solid transparent',
            }}>
              <span style={{ flexShrink: 0, marginTop: 3, display: 'flex', alignItems: 'center' }}>
                <InfinityGlow color={agent.color} mode={agent.mode} size={0.65} />
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: '#e2e8f0', letterSpacing: '-0.01em' }}>
                    {agent.label.split(' ')[0]}
                  </span>
                  {agent.status && (
                    <span style={{ fontSize: 10, fontWeight: 600, color: agent.color }}>{agent.status}</span>
                  )}
                </div>
                <div style={{ fontSize: 10, color: '#64748b', marginTop: 1, fontFamily: '"SF Mono", ui-monospace, monospace' }}>
                  {agent.label.split(' ').slice(1).join(' ')}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* ── Light background ── */}
      <div style={{
        background: '#f5f7fb',
        borderRadius: 14,
        padding: 32,
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
      }}>
        <h2 style={{ fontSize: 16, fontWeight: 700, margin: 0, color: '#111827' }}>Light Background</h2>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 20, alignItems: 'center' }}>
          {MODES.map(({ mode, label, color }) => (
            <div key={mode} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
              <InfinityGlow color={color} mode={mode} size={1} />
              <span style={{ fontSize: 9, color: '#64748b' }}>{label}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
