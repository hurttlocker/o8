'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { DoubleCheck } from 'iconoir-react';
import { useTheme } from '@/lib/theme/context';
import { cleanupOrphanedRoughdraftAnnotations } from '@/lib/o8md/cleanup';
import { O8SpecEditor } from './O8SpecEditor';
import { TitleBarButton } from '../title-bar/TitleBarButton';

interface O8SpecPaneProps {
  repoPath?: string | null;
  /**
   * Is this pane the visible tab?
   *
   * O8Panel keeps every pane MOUNTED and toggles `display: none` rather than
   * unmounting, so without this the background o8.md poll and the relative-time
   * clock tick run forever for a surface nobody is looking at. Measured on the
   * idle app, `/api/repo-spec` was the single busiest endpoint at ~15 req/min —
   * from a pane that was not even on screen.
   *
   * Defaults to true for the canvas/embedded mounts, which only exist while
   * they are visible.
   */
  active?: boolean;
  /** Slot for the Ask-o8 chat trigger so it sits IN the toolbar next to
   *  Ask-to-review + Settings rather than floating below the header. */
  toolbarSlot?: ReactNode;
  /** Canvas treatment: the GlassCardShell already IS the card frame + header,
   *  so drop the inner bordered editor box (border / radius / fill / maxWidth /
   *  frame padding) and let the editor fill the modal body directly — same as
   *  the terminal card. Dashboard (O8Panel) leaves this off and keeps its inset
   *  editor frame. */
  embedded?: boolean;
}

const SAVE_DEBOUNCE_MS = 800;
const UI_FONT = 'var(--font-sans-system)';
const MONO_FONT = '"SF Mono", ui-monospace, "Cascadia Code", Menlo, monospace';

// Canvas scales the card via CSS `zoom` (--cnv-zoom on <html>). Under `zoom`,
// getBoundingClientRect() returns LAYOUT px while a pointer's clientX is VISUAL
// px — so any (clientX - rect.left) hit-math (the note-color hue picker) lands
// wrong unless clientX is divided by the zoom. Returns 1 off-canvas (var unset).
function canvasZoomFactor(): number {
  if (typeof document === 'undefined') return 1;
  const v = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--cnv-zoom'));
  return Number.isFinite(v) && v > 0 ? v : 1;
}

function savedLabel(savedAt: number | null, now: number) {
  if (!savedAt) return 'Loaded';
  const seconds = Math.max(0, Math.floor((now - savedAt) / 1000));
  if (seconds < 60) return `Saved ${seconds}s ago`;
  return `Saved ${Math.floor(seconds / 60)}m ago`;
}

function linesForDiff(value: string) {
  return value.replace(/\r\n/g, '\n').split('\n');
}

function countChangedLines(base: string, next: string) {
  if (base === next) return { additions: 0, deletions: 0 };

  const before = linesForDiff(base);
  const after = linesForDiff(next);
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) {
    start += 1;
  }

  let beforeEnd = before.length - 1;
  let afterEnd = after.length - 1;
  while (beforeEnd >= start && afterEnd >= start && before[beforeEnd] === after[afterEnd]) {
    beforeEnd -= 1;
    afterEnd -= 1;
  }

  return {
    additions: Math.max(0, afterEnd - start + 1),
    deletions: Math.max(0, beforeEnd - start + 1),
  };
}

export function O8SpecPane({ repoPath, toolbarSlot, embedded, active = true }: O8SpecPaneProps) {
  const [content, setContent] = useState('');
  const [loadedContent, setLoadedContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [savePending, setSavePending] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(0);
  // Per-user note styling for the o8.md rail. customColor=null → brand orange;
  // else any CSS color string (a rainbow hue OR a neutral swatch incl. black).
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [customColor, setCustomColor] = useState<string | null>(() => {
    try {
      if (typeof window === 'undefined') return null;
      const raw = window.localStorage.getItem('o8:spec:note-color');
      return raw && raw !== '' ? raw : null;
    } catch {
      return null;
    }
  });
  const [reviewing, setReviewing] = useState(false);
  const debounceRef = useRef<number | null>(null);
  // Last content we know o8.md holds on disk. Lets a background poll adopt the
  // orchestrator's annotations without a manual reload — and never clobber the
  // operator's unsaved edits (we only swap when local === last-saved).
  const serverContentRef = useRef('');
  const prewarmedReposRef = useRef(new Set<string>());

  // Sparkle → headless one-shot review. An LLM turn server-side annotates o8.md
  // and writes the markers; it never touches the orchestrator session, so
  // nothing shows in the chat. New notes land on the rail — we refetch the
  // annotated doc immediately (the 4s poll is the backstop).
  const requestReview = useCallback(async () => {
    if (!repoPath || reviewing) return;
    setReviewing(true);
    setError(null);
    try {
      const res = await fetch(`/api/repo-spec?action=review&repoPath=${encodeURIComponent(repoPath)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      const data = await res.json();
      if (!data?.ok) {
        setError(typeof data?.error === 'string' ? data.error : 'Review failed');
        return;
      }
      // Pull the freshly annotated doc in now — only when there are no unsaved
      // local edits to clobber (same guard as the background poll).
      const fresh = await fetch(`/api/repo-spec?repoPath=${encodeURIComponent(repoPath)}`).then((r) => r.json()).catch(() => null);
      if (fresh?.ok && typeof fresh.content === 'string' && content === serverContentRef.current) {
        serverContentRef.current = fresh.content;
        setContent(fresh.content);
        setLoadedContent(fresh.content);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setReviewing(false);
    }
  }, [repoPath, reviewing, content]);

  // Warm a review proc when the pane opens so the FIRST "Ask o8 to review" click
  // is instant, not a cold spawn. Fire-and-forget, once per repo; the pool reaps
  // the idle proc if it's never used (issue #1332 follow-up). (2026-07-02)
  useEffect(() => {
    if (!active || !repoPath || prewarmedReposRef.current.has(repoPath)) return;
    prewarmedReposRef.current.add(repoPath);
    void fetch(`/api/repo-spec?action=prewarm-review&repoPath=${encodeURIComponent(repoPath)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    }).catch(() => {});
  }, [active, repoPath]);

  useEffect(() => {
    // Only tick the relative-time labels while the pane is actually on screen.
    // It stays mounted behind display:none otherwise, and a hidden clock is a
    // re-render every 5s for nobody.
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 5_000);
    return () => window.clearInterval(timer);
  }, [active]);

  const pickColor = useCallback((c: string) => {
    setCustomColor(c);
    try { window.localStorage.setItem('o8:spec:note-color', c); } catch { /* ignore */ }
  }, []);
  const pickHue = useCallback((h: number) => {
    pickColor(`hsl(${Math.max(0, Math.min(360, Math.round(h)))}, 80%, 55%)`);
  }, [pickColor]);
  const resetColor = useCallback(() => {
    setCustomColor(null);
    try { window.localStorage.removeItem('o8:spec:note-color'); } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    if (debounceRef.current) {
      window.clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    if (!repoPath) {
      setContent('');
      setLoadedContent('');
      setLoading(false);
      setSavePending(false);
      setError('Select a repo to edit o8.md.');
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    setSavedAt(null);
    fetch(`/api/repo-spec?repoPath=${encodeURIComponent(repoPath)}`)
      .then((res) => res.json())
      .then((data) => {
        if (cancelled) return;
        if (data?.ok && typeof data.content === 'string') {
          setContent(data.content);
          setLoadedContent(data.content);
          serverContentRef.current = data.content;
        } else {
          setLoadedContent('');
          setError(data?.error || 'Failed to load notes');
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [repoPath]);

  const persist = useCallback((next: string) => {
    if (!repoPath) return;
    setSavePending(true);
    setError(null);
    fetch(`/api/repo-spec?repoPath=${encodeURIComponent(repoPath)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: next }),
    })
      .then((res) => res.json())
      .then((data) => {
        if (data?.ok) {
          const saved = typeof data.content === 'string' ? data.content : next;
          setSavedAt(Date.now());
          serverContentRef.current = saved;
          if (saved !== next) setContent(saved);
        } else setError(data?.error || 'Save failed');
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        setSavePending(false);
      });
  }, [repoPath]);

  const handleChange = useCallback((next: string) => {
    const cleaned = cleanupOrphanedRoughdraftAnnotations(next).content;
    setContent(cleaned);
    setSavePending(true);
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => {
      persist(cleaned);
    }, SAVE_DEBOUNCE_MS) as unknown as number;
  }, [persist]);

  // Per-note server actions write immediately. Adopt their authoritative
  // content without scheduling a second autosave or leaving the poller's
  // last-known server snapshot behind.
  const handleServerMutation = useCallback((next: string) => {
    if (debounceRef.current) {
      window.clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    serverContentRef.current = next;
    setContent(next);
    setLoadedContent(next);
    setSavePending(false);
    setSavedAt(Date.now());
    setError(null);
  }, []);

  // Adopt external writes to o8.md (the orchestrator's annotations) without a
  // manual reload. Read-only against the server — never writes back — and only
  // swaps in new content when local === last-saved (no unsaved edits), so it
  // can never clobber the operator mid-thought. This is also the panel-side
  // seed for the eventual one-shot review lane (loading state + fade-in).
  const pollStateRef = useRef({ repoPath, content, loading, savePending });
  pollStateRef.current = { repoPath, content, loading, savePending };

  // Pull o8.md from the server if it moved underneath us. Shared by the
  // background poll and by the moment the pane becomes visible.
  const adoptServerContent = useCallback(() => {
    const s = pollStateRef.current;
    if (!s.repoPath || s.loading || s.savePending) return;
    if (s.content !== serverContentRef.current) return; // unsaved local edits — leave them be
    if (typeof document !== 'undefined' && document.hidden) return;
    fetch(`/api/repo-spec?repoPath=${encodeURIComponent(s.repoPath)}`)
      .then((res) => res.json())
      .then((data) => {
        const next = data?.ok && typeof data.content === 'string' ? data.content : null;
        if (next == null || next === serverContentRef.current) return;
        const cur = pollStateRef.current;
        if (cur.savePending || cur.content !== serverContentRef.current) return; // raced a local edit
        serverContentRef.current = next;
        setContent(next);
        setLoadedContent(next);
      })
      .catch(() => { /* transient */ });
  }, []);

  useEffect(() => {
    // PERF: this pane stays MOUNTED when its tab is not selected — O8Panel hides
    // it with display:none rather than unmounting — so an un-gated interval polls
    // the server forever for a surface nobody is looking at. On the idle app this
    // was the single busiest endpoint, ~15 requests/minute, entirely invisible.
    //
    // `document.hidden` (checked inside adoptServerContent) only catches the whole
    // WINDOW being hidden. It says nothing about whether this pane is on screen.
    if (!repoPath || !active) return;
    // Adopt any external edit immediately on open, so gating the poll costs the
    // operator nothing: the content is fresh the moment they can actually see it.
    adoptServerContent();
    const id = window.setInterval(adoptServerContent, 4000);
    return () => window.clearInterval(id);
  }, [repoPath, active, adoptServerContent]);

  useEffect(() => () => {
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
  }, []);

  const status = loading
    ? 'Loading notes'
    : error
      ? error
      : savePending
        ? 'Saving...'
        : savedLabel(savedAt, now);
  const diffStats = useMemo(() => countChangedLines(loadedContent, content), [content, loadedContent]);

  // The wide O8 Panel root carries data-chrome-surface="true". In SOLID
  // surface mode the spec editor renders as CONTENT (paper bg, dark text),
  // so we re-bind the common text tokens back to chat-surface content
  // values. In GLASS mode we want the editor to read as glass like every
  // other o8 panel tab — let the chrome-surface scope win (white text on
  // translucent vibrancy), no re-binding.
  const { surface, paletteId } = useTheme();
  const isLight = paletteId === 'light';
  // Note accent: brand orange by default, else the chosen color (rainbow hue or
  // a neutral incl. black). The anchor highlight tracks it at low opacity via
  // color-mix so the pairing stays cohesive for any color.
  const noteColor = customColor ?? 'var(--t-brand-orange, #FF5A1F)';
  const noteHilite = customColor == null ? 'rgba(232, 150, 40, 0.20)' : `color-mix(in srgb, ${customColor} 22%, transparent)`;
  // Rainbow thumb position — only meaningful for a hue color (default sits near
  // orange ≈ 16); null when a neutral swatch is active so the thumb hides.
  const hueThumb = customColor == null ? 16 : (/^hsl\(\s*\d+\s*,\s*80%/.test(customColor) ? Number(/^hsl\(\s*(\d+)/.exec(customColor)?.[1] ?? '16') : null);
  const contentRebinds = surface === 'solid'
    ? {
        ['--t-text' as unknown as string]: 'var(--t-chat-surface-text)',
        ['--t-text-secondary' as unknown as string]: 'var(--t-chat-surface-text-secondary)',
        ['--t-text-muted' as unknown as string]: 'var(--t-chat-surface-text-muted)',
        ['--t-text-faint' as unknown as string]: 'var(--t-chat-surface-text-muted)',
        ['--t-input-bg' as unknown as string]: 'var(--t-chat-surface-input-bg)',
      }
    : {};
  // Diff stats (+adds / -dels) — shared between the dashboard header (inline
  // with the "Workspace Notes" title) and the canvas/embedded header (in the
  // slim right-aligned control cluster next to review + settings).
  const diffStatsEl = (
    <div
      aria-label={`Notes diff ${diffStats.additions} additions, ${diffStats.deletions} deletions`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        fontFamily: MONO_FONT,
        fontSize: 9.5,
        fontWeight: 300,
        letterSpacing: '-0.2px',
        fontVariantNumeric: 'tabular-nums',
        flexShrink: 0,
      }}
    >
      {diffStats.additions > 0 ? <span style={{ color: 'var(--t-terminal-ansi-bright-green, #16a34a)' }}>+{diffStats.additions}</span> : null}
      {diffStats.deletions > 0 ? <span style={{ color: 'var(--t-terminal-ansi-bright-red, #ef4444)' }}>-{diffStats.deletions}</span> : null}
      {diffStats.additions === 0 && diffStats.deletions === 0 ? <span style={{ color: 'var(--t-text-faint)' }}>0</span> : null}
    </div>
  );
  return (
    <div style={{
      display: 'flex',
      flex: 1,
      flexDirection: 'column',
      minHeight: 0,
      // Glass-panel model, matching the left AgentPanel: in glass mode paint the
      // translucent --t-bg so the notes read as the SAME glass as the rest of the
      // chrome (left panel + right chrome). --t-canvas-bg is fully transparent in
      // glass (floating-canvas token) → washed-out bleed; the embedded canvas card
      // keeps it (its shell owns the frame); solid mode keeps opaque paper.
      background: embedded ? 'var(--t-canvas-bg)' : surface === 'solid' ? 'var(--t-chat-surface-bg)' : 'transparent',
      color: surface === 'solid' ? 'var(--t-chat-surface-text)' : 'var(--t-text)',
      ...contentRebinds,
    } as CSSProperties}>
      <div style={embedded ? {
        // Canvas: the GlassCardShell already IS the card frame + "o8.md" title,
        // so this collapses to a slim, borderless, right-aligned control strip
        // (diff · review · settings) that reads as part of the card header —
        // no "Workspace Notes" label, no status line, no divider.
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        minHeight: 34,
        paddingTop: 2,
        paddingLeft: 16,
        paddingRight: 10,
        justifyContent: 'flex-end',
        fontFamily: UI_FONT,
      } : {
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        minHeight: 58,
        paddingLeft: 18,
        // Right padding matches the panel header strip above (ColumnHeaderStrip
        // = 8) so the Workspace Notes toolbar icons (review / settings) line up
        // vertically with the panel header icons instead of sitting 10px left.
        paddingRight: 8,
        borderBottom: '1px solid var(--t-divider-subtle)',
        fontFamily: UI_FONT,
      }}>
        {embedded ? (
          diffStatsEl
        ) : (
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, minWidth: 0 }}>
              <div style={{
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                color: surface === 'solid' ? 'var(--t-chat-surface-text)' : 'var(--t-text)',
                fontSize: 13.5,
                fontWeight: 350,
                letterSpacing: '-0.1px',
                lineHeight: 1.25,
              }}>
                Workspace Notes
              </div>
              {diffStatsEl}
            </div>
            <div style={{
              marginTop: 3,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              color: error ? 'var(--t-brand-red)' : reviewing ? noteColor : 'var(--t-text-faint)',
              fontSize: 9.5,
              fontWeight: 260,
              letterSpacing: '-0.4px',
            }}>
              {reviewing ? 'o8 is reading your notes…' : status}
            </div>
          </div>
        )}
        {toolbarSlot}
        <TitleBarButton
          label="Ask o8 to review"
          onClick={requestReview}
          // Iconoir DoubleCheck — operator-locked for the "Ask o8 to
          // review" affordance. Two checks reads as "agent verified" /
          // "AI-validated" better than the old sparkle mark.
          icon={<DoubleCheck width={15} height={15} color="currentColor" strokeWidth={2} />}
        />
        <div style={{ position: 'relative', flexShrink: 0, display: 'inline-flex' }}>
          <TitleBarButton
            label="Notes settings"
            onClick={() => setSettingsOpen((v) => !v)}
            icon={(
              <svg width={14} height={14} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                <path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 00.12-.61l-1.92-3.32a.488.488 0 00-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 00-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 00-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z" />
              </svg>
            )}
          />
          {settingsOpen ? (
            <>
              <div onClick={() => setSettingsOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 49 }} />
              <div style={{
                position: 'absolute', top: 'calc(100% + 8px)', right: 0, zIndex: 50, width: 224,
                paddingTop: 12, paddingBottom: 12, paddingLeft: 14, paddingRight: 14, borderRadius: 12,
                background: isLight ? '#ffffff' : '#22262d',
                border: isLight ? '1px solid rgba(0, 0, 0, 0.10)' : '1px solid rgba(255, 255, 255, 0.12)',
                boxShadow: '0 10px 30px rgba(0, 0, 0, 0.22)',
                color: isLight ? '#1a1e24' : '#e8ecf2',
              }}>
                <div style={{ fontSize: 9, fontWeight: 300, letterSpacing: '0.04em', textTransform: 'uppercase', color: isLight ? '#8a93a3' : '#9aa3b2', marginBottom: 10 }}>Note color</div>
                <div
                  // embedded (canvas) divides clientX by the zoom so the picked
                  // hue matches the pointer — getBoundingClientRect is layout px
                  // under CSS zoom but clientX is visual px (1:1 off-canvas).
                  onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); const r = e.currentTarget.getBoundingClientRect(); const z = embedded ? canvasZoomFactor() : 1; pickHue((((e.clientX / z) - r.left) / r.width) * 360); }}
                  onPointerMove={(e) => { if (e.buttons === 1) { const r = e.currentTarget.getBoundingClientRect(); const z = embedded ? canvasZoomFactor() : 1; pickHue((((e.clientX / z) - r.left) / r.width) * 360); } }}
                  style={{
                    position: 'relative', height: 16, borderRadius: 8, cursor: 'pointer', touchAction: 'none',
                    background: 'linear-gradient(to right, hsl(0, 80%, 55%), hsl(60, 80%, 55%), hsl(120, 80%, 55%), hsl(180, 80%, 55%), hsl(240, 80%, 55%), hsl(300, 80%, 55%), hsl(360, 80%, 55%))',
                  }}
                >
                  {hueThumb != null ? (
                    <div style={{ position: 'absolute', left: `${(hueThumb / 360) * 100}%`, top: -3, marginLeft: -6, width: 12, height: 22, borderRadius: 5, background: noteColor, border: '2px solid #fff', boxShadow: '0 1px 3px rgba(0, 0, 0, 0.4)' }} />
                  ) : null}
                </div>
                <div style={{ display: 'flex', gap: 7, marginTop: 10 }}>
                  {['#000000', '#52525b', '#9ca3af', '#d1d5db', '#ffffff'].map((c) => {
                    const active = (customColor || '').toLowerCase() === c;
                    return (
                      <button
                        key={c}
                        type="button"
                        aria-label={`Note color ${c}`}
                        onClick={() => pickColor(c)}
                        style={{ width: 22, height: 22, borderRadius: 6, padding: 0, cursor: 'pointer', background: c, border: active ? '2px solid #2563eb' : '1px solid rgba(128, 128, 128, 0.4)' }}
                      />
                    );
                  })}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 12 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                    <span style={{ width: 14, height: 14, borderRadius: 4, background: noteColor, flexShrink: 0, border: '1px solid rgba(128, 128, 128, 0.4)' }} />
                    <span style={{ fontSize: 11, fontWeight: 300, letterSpacing: '-0.1px', color: isLight ? '#5b6475' : '#9aa3b2' }}>{customColor == null ? 'Default' : 'Custom'}</span>
                  </div>
                  <button type="button" onClick={resetColor} style={{ cursor: 'pointer', background: 'transparent', border: 'none', paddingTop: 0, paddingBottom: 0, paddingLeft: 0, paddingRight: 0, fontSize: 11, fontWeight: 350, letterSpacing: '-0.1px', color: isLight ? '#2563eb' : '#8ab4ff' }}>Reset</button>
                </div>
              </div>
            </>
          ) : null}
        </div>
      </div>
      <div style={{ display: 'flex', flex: 1, minHeight: 0, overflow: 'hidden', paddingTop: embedded ? 0 : 14, paddingRight: embedded ? 0 : 14, paddingBottom: embedded ? 0 : 14, paddingLeft: embedded ? 0 : 14 }}>
        <div style={{
          display: 'flex',
          flex: 1,
          minWidth: 0,
          minHeight: 0,
          // Canvas (embedded): no inner frame — the editor fills the modal body
          // directly, so the card reads as one surface like the terminal card.
          maxWidth: embedded ? undefined : 920,
          marginLeft: embedded ? undefined : 'auto',
          marginRight: embedded ? undefined : 'auto',
          borderRadius: embedded ? 0 : 18,
          border: embedded ? 'none' : '1px solid var(--t-divider-subtle)',
          background: embedded ? 'transparent' : (surface === 'solid' ? 'var(--t-chat-surface-input-bg)' : 'transparent'),
          overflow: 'hidden',
        }}>
          {loading ? (
            <div style={{ paddingTop: 18, paddingLeft: 18, color: 'var(--t-chat-surface-text-muted)', fontFamily: UI_FONT, fontSize: 12 }}>Loading notes...</div>
          ) : (
            <div
              className="cortex-scroll-fade-y cortex-themed-scroll cortex-inset-scroll o8-notes-scroll"
              style={{
                flex: 1,
                minHeight: 0,
                overflowY: 'auto',
                marginTop: 7,
                marginRight: 7,
                marginBottom: 7,
                marginLeft: 7,
                paddingLeft: 16,
                paddingRight: 8,
                // map the editor's theme-agnostic vars onto the panel's surface tokens
                ['--o8ed-ink' as string]: surface === 'solid' ? 'var(--t-chat-surface-text)' : 'var(--t-text)',
                ['--o8ed-ink-soft' as string]: 'var(--t-chat-surface-text-secondary)',
                ['--o8ed-ink-faint' as string]: 'var(--t-chat-surface-text-muted)',
                ['--o8ed-orange' as string]: noteColor,
                ['--o8ed-add' as string]: 'var(--t-terminal-ansi-bright-green, #16a34a)',
                ['--o8ed-del' as string]: 'var(--t-brand-red, #ef4444)',
                ['--o8ed-hilite' as string]: noteHilite,
                // Canvas: size the handwritten margin-note (agent) text to a
                // "good middle" — a touch above the boosted prose so the Caveat
                // hand reads as an annotation, not the headline. 0.89 → ~16px at
                // the 0.7 ("100%") canvas zoom. The rail font sizes multiply by
                // this var (1 off-canvas). Tune here.
                ['--o8ed-note-scale' as string]: embedded ? 0.89 : 1,
              } as CSSProperties}
            >
              <O8SpecEditor
                value={content}
                onChange={handleChange}
                onServerMutation={handleServerMutation}
                repoPath={repoPath}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
