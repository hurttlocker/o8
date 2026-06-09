'use client';

/**
 * Stats tab — read-only local stats derived from the dictation history
 * (`~/.o8/dictation-history.json`). Honest subset of Symon's Stats: o8 keeps
 * only the recent-history ledger (no long-term WPM/streak telemetry), so we
 * surface what that ledger can prove — counts, words, today, top app, split.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { dictationHistoryGet, type DictationHistoryEntry } from '@/lib/tauri/bridge';
import { ICONS, TEXT_PRIMARY, TEXT_TERTIARY, ACCENT_LIGHT, SECTION_BG, SECTION_BORDER } from '../tokens';
import { SectionCard, SectionTitle, SectionHint, GhostButton, PAGE_TITLE_STYLE } from '../primitives';

function wordCount(text: string): number {
  const t = text.trim();
  return t ? t.split(/\s+/).length : 0;
}
function isToday(tsSeconds: number): boolean {
  const d = new Date(tsSeconds * 1000), n = new Date();
  return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
}
function appName(bundleId: string): string {
  if (!bundleId) return '';
  const parts = bundleId.split('.');
  const last = parts[parts.length - 1] || bundleId;
  return last.charAt(0).toUpperCase() + last.slice(1);
}

export default function StatsTab() {
  const [history, setHistory] = useState<DictationHistoryEntry[]>([]);
  const load = useCallback(async () => { setHistory(await dictationHistoryGet()); }, []);
  useEffect(() => { void load(); }, [load]);

  const totalWords = history.reduce((s, e) => s + wordCount(e.text), 0);
  const wordsToday = history.filter((e) => isToday(e.ts)).reduce((s, e) => s + wordCount(e.text), 0);
  const askCount = history.filter((e) => e.mode === 'ask').length;
  const dictCount = history.length - askCount;

  const appCounts = new Map<string, number>();
  for (const e of history) { const a = appName(e.app); if (a) appCounts.set(a, (appCounts.get(a) ?? 0) + 1); }
  const topApp = [...appCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '—';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center' }}>
        <h1 style={PAGE_TITLE_STYLE}>Stats</h1>
        <span style={{ marginLeft: 'auto' }}><GhostButton label="Refresh" onClick={() => { void load(); }} /></span>
      </div>
      <SectionCard>
        <SectionTitle icon={ICONS.chartBar}>This Mac</SectionTitle>
        <SectionHint>Derived from your local dictation history (kept on this Mac, capped to the most recent entries).</SectionHint>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 10, marginTop: 4 }}>
          <Stat label="Total dictations" value={String(history.length)} />
          <Stat label="Total words" value={totalWords.toLocaleString()} />
          <Stat label="Words today" value={wordsToday.toLocaleString()} accent />
          <Stat label="Top app" value={topApp} />
          <Stat label="Held-Fn dictations" value={String(dictCount)} />
          <Stat label="Asked" value={String(askCount)} />
        </div>
      </SectionCard>
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: ReactNode; accent?: boolean }) {
  return (
    <div style={{
      padding: '14px 16px', borderRadius: 14, border: `1px solid ${SECTION_BORDER}`,
      background: SECTION_BG, display: 'flex', flexDirection: 'column', gap: 6,
    }}>
      <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.12em', textTransform: 'uppercase', color: TEXT_TERTIARY }}>{label}</span>
      <span style={{ fontSize: 24, fontWeight: 560, letterSpacing: '-0.02em', color: accent ? ACCENT_LIGHT : TEXT_PRIMARY, lineHeight: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{value}</span>
    </div>
  );
}
