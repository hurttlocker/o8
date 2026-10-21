'use client';

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { FloatingSurface } from '../FloatingSurface';
import { buildDiffBreakdown } from './diff-breakdown';

type Props = { files: readonly { path: string; additions: number; deletions: number }[]; totalFiles: number; additions: number; deletions: number };
const cellStyle: CSSProperties = { paddingTop: 5, paddingBottom: 5, paddingLeft: 0, paddingRight: 0, fontWeight: 300, textAlign: 'left' };

export function PrDiffStats({ files, totalFiles, additions, deletions }: Props) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const breakdown = buildDiffBreakdown(files, totalFiles, additions, deletions);
  const clearTimer = useCallback(() => { if (timer.current) clearTimeout(timer.current); timer.current = null; }, []);
  const close = useCallback(() => { clearTimer(); setOpen(false); setPinned(false); }, [clearTimer]);
  function leave() {
    clearTimer();
    if (!pinned && document.activeElement !== trigger.current) timer.current = setTimeout(() => setOpen(false), 180);
  }
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      if (!trigger.current || !panel.current) return;
      const configuredZoom = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ui-zoom'));
      const zoom = Number.isFinite(configuredZoom) && configuredZoom > 0 ? configuredZoom : 1;
      const rect = trigger.current.getBoundingClientRect();
      const width = panel.current.offsetWidth; const height = panel.current.offsetHeight;
      const viewportWidth = window.innerWidth / zoom; const viewportHeight = window.innerHeight / zoom;
      const left = Math.max(12, Math.min(rect.right / zoom - width, viewportWidth - width - 12));
      const below = rect.bottom / zoom + 6;
      const top = Math.max(12, Math.min(below + height <= viewportHeight - 12 ? below : rect.top / zoom - height - 6, viewportHeight - height - 12));
      setPosition(current => current?.left === left && current.top === top ? current : { left, top });
    };
    const dismiss = (event: Event) => {
      if (event.target instanceof Node && (trigger.current?.contains(event.target) || panel.current?.contains(event.target))) return;
      close();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault(); event.stopPropagation(); close();
    };
    place();
    const observer = new ResizeObserver(place);
    if (trigger.current) observer.observe(trigger.current);
    if (panel.current) observer.observe(panel.current);
    const zoomObserver = new MutationObserver(place);
    zoomObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
    window.addEventListener('resize', place); window.addEventListener('scroll', place, true);
    document.addEventListener('pointerdown', dismiss); document.addEventListener('keydown', escape, true);
    return () => {
      zoomObserver.disconnect(); observer.disconnect(); window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true);
      document.removeEventListener('pointerdown', dismiss); document.removeEventListener('keydown', escape, true);
    };
  }, [open, close]);
  const row = (label: string, added: number, removed: number, separated = false) => <tr key={label} style={{ borderTop: separated ? '1px solid var(--t-divider-subtle)' : undefined }}>
    <th scope="row" style={cellStyle}>{label}</th>
    <td style={{ ...cellStyle, textAlign: 'right', paddingLeft: 18, color: 'var(--t-success)' }}>+{added.toLocaleString()}</td>
    <td style={{ ...cellStyle, textAlign: 'right', paddingLeft: 12, color: 'var(--t-danger)' }}>−{removed.toLocaleString()}</td>
  </tr>;
  return <>
    <button ref={trigger} type="button" aria-label={`Change breakdown: ${additions} additions, ${deletions} deletions`} aria-expanded={open} aria-describedby={open ? id : undefined}
      onMouseEnter={() => { clearTimer(); timer.current = setTimeout(() => setOpen(true), 240); }} onMouseLeave={leave}
      onFocus={() => { clearTimer(); setOpen(true); }} onBlur={() => { if (!pinned) close(); }}
      onClick={() => { clearTimer(); setPinned(!pinned); setOpen(!pinned); }}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 5, paddingTop: 0, paddingRight: 0, paddingBottom: 0, paddingLeft: 0, minHeight: 26, border: 0, borderRadius: 7, fontFamily: 'var(--font-sans-system)', fontSize: 11, fontWeight: 300, letterSpacing: '-0.1px', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', background: open ? 'var(--t-hover)' : 'transparent', cursor: 'pointer' }}>
      <span style={{ color: 'var(--t-success)' }}>+{additions.toLocaleString()}</span><span style={{ color: 'var(--t-danger)' }}>−{deletions.toLocaleString()}</span>
    </button>
    {open ? createPortal(<FloatingSurface ref={panel} id={id} role="tooltip" onMouseEnter={clearTimer} onMouseLeave={leave}
      style={{ position: 'fixed', zIndex: 1000, left: position?.left ?? -9999, top: position?.top ?? -9999, width: 250, maxWidth: 'calc(100vw - 24px)', borderRadius: 12 }}
      contentStyle={{ paddingTop: 12, paddingRight: 12, paddingBottom: 12, paddingLeft: 12 }}>
      <table aria-label="Changes by file category" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, lineHeight: 1.25, letterSpacing: '-0.1px', fontVariantNumeric: 'tabular-nums' }}>
        <tbody>{breakdown.rows.map(entry => row(entry.category, entry.additions, entry.deletions))}
          {!breakdown.complete ? row('Loaded files', breakdown.loaded.additions, breakdown.loaded.deletions, true) : null}
          {row(breakdown.complete ? 'Total' : 'PR total', additions, deletions, true)}
        </tbody>
      </table>
      <div style={{ marginTop: 8, fontSize: 10, fontWeight: 300, lineHeight: 1.35, color: 'var(--t-text-muted)' }}>
        {breakdown.complete ? 'Grouped by file path.' : `${files.length} of ${totalFiles} files loaded. ${files.length === totalFiles ? 'File counts differ from the PR total. ' : ''}Categories cover loaded files only.`}
      </div>
    </FloatingSurface>, document.body) : null}
  </>;
}
