'use client';

/**
 * Stats tab — local usage stats derived from the dictation history
 * (`~/.o8/dictation-history.json`). Symon-style: a Time-Saved hero + a grid of
 * usage cards. Honest — o8 keeps only the recent-history ledger (no per-dictation
 * duration), so Time Saved is modeled (typing 40 wpm vs speaking 150 wpm), not
 * measured. Everything else is counted directly.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { dictationHistoryGet, type DictationHistoryEntry } from '@/lib/tauri/bridge';
import {
  TEXT_PRIMARY, TEXT_TERTIARY, ACCENT_LIGHT, SECTION_BG, SECTION_BORDER,
  INK_ON_GLASS_1, INK_ON_GLASS_2, INK_ON_GLASS_3,
} from '../tokens';
import { ICONS } from '../tokens';
import { SectionCard, SectionTitle, SectionHint, GhostButton, Icon, PageHeader } from '../primitives';
import type { IconComp } from '../icons';

const TYPING_WPM = 40;
const SPEAKING_WPM = 150;

// o8 motion vocabulary C — the binary orbit (two dots 180° apart circling a
// center). Slowed to a calm cadence for the time-saved hero (vs the 1.6s
// loading speed) so it reads as time flowing, the o8 way. Honors reduced-motion.
function OrbitMark({ size = 14, color }: { size?: number; color: string }) {
  const dot = 3;
  return (
    <span aria-hidden style={{ position: 'relative', display: 'inline-block', width: size, height: size, flexShrink: 0, color }}>
      <style>{'@keyframes vsOrbitSpin{to{transform:rotate(360deg)}}.vsOrbitRing{animation:vsOrbitSpin 7s linear infinite}@media (prefers-reduced-motion:reduce){.vsOrbitRing{animation:none}}'}</style>
      <span className="vsOrbitRing" style={{ position: 'absolute', inset: 0 }}>
        <span style={{ position: 'absolute', top: 0, left: '50%', width: dot, height: dot, marginLeft: -dot / 2, borderRadius: '50%', background: 'currentColor' }} />
        <span style={{ position: 'absolute', bottom: 0, left: '50%', width: dot, height: dot, marginLeft: -dot / 2, borderRadius: '50%', background: 'currentColor', opacity: 0.55 }} />
      </span>
    </span>
  );
}

function wordCount(text: string): number {
  const t = text.trim();
  return t ? t.split(/\s+/).length : 0;
}
function dayKey(ts: number): string {
  const d = new Date(ts * 1000);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}
function isToday(ts: number, nowSec: number): boolean {
  return dayKey(ts) === dayKey(nowSec);
}
function appName(bundleId: string): string {
  if (!bundleId) return '';
  const parts = bundleId.split('.');
  const last = parts[parts.length - 1] || bundleId;
  return last.charAt(0).toUpperCase() + last.slice(1);
}
function fmtDuration(min: number): string {
  if (min < 1) return '<1m';
  if (min < 60) return `${Math.round(min)}m`;
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return m ? `${h}h ${m}m` : `${h}h`;
}

export default function StatsTab() {
  const [history, setHistory] = useState<DictationHistoryEntry[]>([]);
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));
  const load = useCallback(async () => {
    const nextHistory = await dictationHistoryGet();
    setNowSec(Math.floor(Date.now() / 1000));
    setHistory(nextHistory);
  }, []);
  useEffect(() => { void load(); }, [load]);

  const totalWords = history.reduce((s, e) => s + wordCount(e.text), 0);
  const wordsToday = history.filter((e) => isToday(e.ts, nowSec)).reduce((s, e) => s + wordCount(e.text), 0);
  const askCount = history.filter((e) => e.mode === 'ask').length;
  const dictCount = history.length - askCount;
  const avgWords = history.length ? Math.round(totalWords / history.length) : 0;

  const thisWeek = history.filter((e) => e.ts >= nowSec - 7 * 86400).length;
  const activeDays = new Set(history.map((e) => dayKey(e.ts))).size;

  const appCounts = new Map<string, number>();
  for (const e of history) { const a = appName(e.app); if (a) appCounts.set(a, (appCounts.get(a) ?? 0) + 1); }
  const topApp = [...appCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '—';

  const savedMin = Math.max(0, totalWords / TYPING_WPM - totalWords / SPEAKING_WPM);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <PageHeader icon={ICONS.chartBar} title="Stats" right={<GhostButton label="Refresh" onClick={() => { void load(); }} />} />

      {/* Time-saved hero */}
      <div style={{
        position: 'relative', overflow: 'hidden', padding: '18px 20px', borderRadius: 18,
        border: `1px solid rgba(90,132,255,0.28)`,
        background: 'radial-gradient(circle at 88% 18%, rgba(64,88,255,0.22), transparent 52%), linear-gradient(180deg, rgba(64,88,255,0.12), rgba(255,255,255,0.02))',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 12, fontSize: 10, fontWeight: 300, letterSpacing: '0.12em', textTransform: 'uppercase', color: INK_ON_GLASS_2 }}>
          <OrbitMark size={14} color={INK_ON_GLASS_2} />
          Time saved
        </div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 38, fontWeight: 400, letterSpacing: '-0.03em', color: INK_ON_GLASS_1, textShadow: '0 1px 4px rgba(0,0,0,0.28)', lineHeight: 1 }}>{fmtDuration(savedMin)}</span>
          <span style={{ fontSize: 12.5, color: INK_ON_GLASS_3, textShadow: '0 1px 2px rgba(0,0,0,0.22)' }}>
            vs typing {totalWords.toLocaleString()} words by hand
          </span>
        </div>
      </div>

      {/* Usage grid */}
      <SectionCard>
        <SectionTitle icon={ICONS.chartBar}>Usage</SectionTitle>
        <SectionHint>Derived from your local dictation history (kept on this Mac, capped to the most recent entries).</SectionHint>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 10, marginTop: 4 }}>
          <Stat icon={ICONS.words} label="Total words" value={totalWords.toLocaleString()} />
          <Stat icon={ICONS.microphone} label="Total dictations" value={String(history.length)} />
          <Stat icon={ICONS.flash} label="Words today" value={wordsToday.toLocaleString()} accent />
          <Stat icon={ICONS.calendar} label="This week" value={String(thisWeek)} />
          <Stat icon={ICONS.type} label="Avg per dictation" value={`${avgWords} words`} />
          <Stat icon={ICONS.calendar} label="Active days" value={String(activeDays)} />
          <Stat icon={ICONS.robot} label="Top app" value={topApp} />
          <Stat icon={ICONS.sparkle} label="Held-Fn / Asked" value={`${dictCount} / ${askCount}`} />
        </div>
      </SectionCard>
    </div>
  );
}

function Stat({ icon, label, value, accent }: { icon: IconComp; label: string; value: ReactNode; accent?: boolean }) {
  return (
    <div style={{
      padding: '13px 15px', borderRadius: 14, border: `1px solid ${SECTION_BORDER}`,
      background: SECTION_BG, display: 'flex', flexDirection: 'column', gap: 8,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        <span style={{ color: TEXT_TERTIARY, display: 'flex', opacity: 0.8 }}><Icon icon={icon} size={13} /></span>
        <span style={{ fontSize: 10, fontWeight: 300, letterSpacing: '0.1em', textTransform: 'uppercase', color: TEXT_TERTIARY }}>{label}</span>
      </div>
      <span style={{ fontSize: 22, fontWeight: 400, letterSpacing: '-0.02em', color: accent ? ACCENT_LIGHT : TEXT_PRIMARY, lineHeight: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{value}</span>
    </div>
  );
}
