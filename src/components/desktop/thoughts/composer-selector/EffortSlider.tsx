'use client';

import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { THINKING_EFFORT_LABELS } from '@/lib/orchestrator/thinking-effort';
import {
  composerEffortConsequence,
  isHotComposerEffort,
  type ResolvedComposerSelectorState,
} from './state';
import {
  effortSliderProgress,
  effortSliderStopAtPointer,
  orderedEffortSliderStops,
} from './effort-slider-geometry';

const FADE_EASE = 'cubic-bezier(.22,1,.36,1)';
const SPRING_EASE = 'cubic-bezier(.22,1,.36,1)';
const HOT_ACCENT = 'var(--t-brand-orange)';

function effortLabel(effort: ResolvedComposerSelectorState['effort']): string {
  return THINKING_EFFORT_LABELS[effort].long;
}

function effortConsequenceCopy(
  backend: ResolvedComposerSelectorState['leadBackend'],
  effort: ResolvedComposerSelectorState['effort'],
): string {
  const label = effortLabel(effort);
  const consequence = composerEffortConsequence(backend, effort);
  return consequence.startsWith(`${label} · `) ? consequence.slice(label.length + 3) : consequence;
}

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => (
    typeof window !== 'undefined'
      && Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches)
  ));
  useEffect(() => {
    const query = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!query) return;
    const update = () => setReduced(query.matches);
    query.addEventListener?.('change', update);
    return () => query.removeEventListener?.('change', update);
  }, []);
  return reduced;
}

function DirectionalCopy({
  value,
  index,
  distance,
  duration,
  reducedMotion,
}: {
  value: string;
  index: number;
  distance: number;
  duration: number;
  reducedMotion: boolean;
}) {
  const previousValueRef = useRef(value);
  const renderedIndexRef = useRef(index);
  const currentRef = useRef<HTMLSpanElement | null>(null);
  const outgoingRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    const previousValue = previousValueRef.current;
    if (value === previousValue) {
      renderedIndexRef.current = index;
      return;
    }
    const direction = Math.sign(index - renderedIndexRef.current) || 1;
    previousValueRef.current = value;
    renderedIndexRef.current = index;
    const outgoingNode = outgoingRef.current;
    if (outgoingNode) outgoingNode.textContent = previousValue;
    if (reducedMotion) return;
    const currentAnimation = currentRef.current?.animate?.(
      [
        { opacity: 0, transform: `translateY(${direction * distance}px)` },
        { opacity: 1, transform: 'translateY(0)' },
      ],
      { duration, easing: FADE_EASE },
    );
    const outgoingAnimation = outgoingNode?.animate?.(
      [
        { opacity: 1, transform: 'translateY(0)' },
        { opacity: 0, transform: `translateY(${-direction * distance}px)` },
      ],
      { duration, easing: FADE_EASE },
    );
    return () => {
      currentAnimation?.cancel();
      outgoingAnimation?.cancel();
    };
  }, [distance, duration, index, reducedMotion, value]);

  return (
    <span style={{ display: 'inline-grid', minWidth: 0 }}>
      <span ref={outgoingRef} aria-hidden style={{ gridArea: '1 / 1', opacity: 0 }} />
      <span ref={currentRef} style={{ gridArea: '1 / 1' }}>{value}</span>
    </span>
  );
}

export function EffortSlider({ state, onPick, disabled = false }: {
  state: ResolvedComposerSelectorState;
  onPick: (effort: ResolvedComposerSelectorState['effort']) => void;
  disabled?: boolean;
}) {
  const reducedMotion = useReducedMotion();
  const stops = orderedEffortSliderStops(state.effortOptions, state.lockedEffortOptions);
  const currentIndex = Math.max(0, stops.indexOf(state.effort));
  const [previewEffort, setPreviewEffort] = useState<ResolvedComposerSelectorState['effort'] | null>(null);
  const [dragging, setDragging] = useState(false);
  const [focused, setFocused] = useState(false);
  const [pointerMotion, setPointerMotion] = useState(false);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const fillRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);
  const animationRef = useRef<Animation | undefined>(undefined);
  useEffect(() => () => animationRef.current?.cancel(), []);
  const displayedEffort = dragging && previewEffort ? previewEffort : state.effort;
  const displayedIndex = Math.max(0, stops.indexOf(displayedEffort));
  const progress = effortSliderProgress(displayedIndex, stops.length);
  const hot = isHotComposerEffort(displayedEffort);
  const accent = hot ? HOT_ACCENT : 'var(--t-accent)';
  const still = reducedMotion || !pointerMotion;
  const transition = still || dragging ? '0ms' : '180ms';

  const selectEffort = (effort: ResolvedComposerSelectorState['effort'], pointer = false) => {
    if (disabled || !state.effortOptions.includes(effort) || state.lockedEffortOptions.includes(effort)) return;
    setPointerMotion(pointer);
    if (effort !== state.effort) onPick(effort);
    if (pointer && !reducedMotion) {
      animationRef.current?.cancel();
      animationRef.current = fillRef.current?.animate?.(
        [{ opacity: 0.7 }, { opacity: 1 }], { duration: 280, easing: FADE_EASE },
      );
    }
  };
  const effortAtPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return effortSliderStopAtPointer(event.clientX, bounds.left, bounds.width, stops);
  };
  const finishDrag = (event: ReactPointerEvent<HTMLDivElement>, commit: boolean) => {
    if (!draggingRef.current) return;
    const effort = effortAtPointer(event);
    draggingRef.current = false;
    setDragging(false);
    setPreviewEffort(null);
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (commit && effort) selectEffort(effort, true);
  };
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    let targetIndex: number | null = null;
    if (event.key === 'ArrowRight' || event.key === 'ArrowUp') targetIndex = Math.min(stops.length - 1, currentIndex + 1);
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') targetIndex = Math.max(0, currentIndex - 1);
    else if (event.key === 'Home') targetIndex = 0;
    else if (event.key === 'End') targetIndex = stops.length - 1;
    else if (/^[1-7]$/.test(event.key)) targetIndex = Number(event.key) - 1;
    if (targetIndex === null || !stops[targetIndex]) return;
    event.preventDefault();
    setPreviewEffort(null);
    selectEffort(stops[targetIndex]);
  };

  return <div data-testid="composer-selector-lead-effort" style={{ marginTop: 2, marginRight: 8, marginBottom: 6, marginLeft: 8, paddingTop: 10, paddingRight: 10, paddingBottom: 10, paddingLeft: 10, borderRadius: 12, background: 'var(--t-glass-muted)', userSelect: 'none' }}>
    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, minHeight: 24 }}>
      <span data-testid="composer-selector-slider-level" style={{ color: hot ? HOT_ACCENT : 'var(--t-text)', fontSize: 17, fontWeight: 400, letterSpacing: '-0.3px' }}>
        <DirectionalCopy value={effortLabel(displayedEffort)} index={displayedIndex} distance={5} duration={180} reducedMotion={still || dragging} />
      </span>
      {state.effort !== 'high' && state.effortOptions.includes('high') ? <button type="button" disabled={disabled} onClick={(event) => selectEffort('high', event.detail > 0)} style={{ borderWidth: 0, padding: 0, background: 'transparent', color: 'var(--t-accent)', fontFamily: 'var(--font-sans-system)', fontSize: 10, fontWeight: 300, cursor: disabled ? 'default' : 'pointer' }}>Reset to High</button> : null}
    </div>
    <div style={{ display: 'flex', justifyContent: 'space-between', paddingTop: 4, color: 'var(--t-text-faint)', fontSize: 10, fontWeight: 300 }}><span>Faster</span><span>More thinking</span></div>
    <div ref={trackRef} data-testid="composer-selector-effort-slider" role="slider" tabIndex={disabled ? -1 : 0} aria-label="Thinking effort" aria-valuemin={0} aria-valuemax={Math.max(0, stops.length - 1)} aria-valuenow={displayedIndex} aria-valuetext={effortLabel(displayedEffort)} aria-disabled={disabled ? true : undefined}
      onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} onKeyDown={onKeyDown}
      onPointerDown={(event) => {
        if (disabled || (event.button !== undefined && event.button !== 0) || draggingRef.current) return;
        event.preventDefault(); event.currentTarget.focus();
        setPointerMotion(true);
        draggingRef.current = true; setDragging(true); setPreviewEffort(effortAtPointer(event) ?? null);
        event.currentTarget.setPointerCapture?.(event.pointerId);
      }}
      onPointerMove={(event) => { if (!disabled) setPreviewEffort(effortAtPointer(event) ?? null); }}
      onPointerUp={(event) => finishDrag(event, true)} onPointerCancel={(event) => finishDrag(event, false)}
      onLostPointerCapture={() => { draggingRef.current = false; setDragging(false); setPreviewEffort(null); }}
      onPointerLeave={(event) => { if (!draggingRef.current) setPreviewEffort(null); else if (event.buttons === 0) finishDrag(event, false); }}
      style={{ position: 'relative', height: 42, touchAction: 'none', cursor: disabled ? 'default' : 'pointer', outline: 'none', borderRadius: 10, boxShadow: focused ? '0 0 0 2px var(--t-accent)' : 'none' }}>
      <div data-testid="composer-selector-slider-track" style={{ position: 'absolute', left: 0, right: 0, top: 12, height: 18, borderRadius: 999, background: 'color-mix(in srgb, var(--t-text-faint) 15%, transparent)', boxShadow: 'inset 0 1px 2px color-mix(in srgb, var(--t-text) 8%, transparent)' }} />
      <div ref={fillRef} data-testid="composer-selector-slider-fill" data-accent={hot ? 'swarm' : 'lead'} style={{ position: 'absolute', left: 0, top: 12, width: `calc(11px + (100% - 22px) * ${progress})`, height: 18, borderRadius: 999, background: `linear-gradient(90deg, color-mix(in srgb, var(--t-accent) 32%, transparent), ${accent})`, boxShadow: dragging ? `0 0 14px color-mix(in srgb, ${accent} 20%, transparent)` : 'none', transitionProperty: 'width, box-shadow', transitionDuration: `${transition}, ${transition}`, transitionTimingFunction: FADE_EASE, pointerEvents: 'none' }} />
      {stops.map((effort, index) => <span key={effort} aria-hidden style={{ position: 'absolute', left: `calc(11px + (100% - 22px) * ${effortSliderProgress(index, stops.length)})`, top: 19, width: 4, height: 4, marginLeft: -2, borderRadius: 999, background: index <= displayedIndex ? 'color-mix(in srgb, var(--t-accent-contrast) 55%, transparent)' : 'var(--t-text-faint)', opacity: state.lockedEffortOptions.includes(effort) ? 0.3 : 0.65, pointerEvents: 'none' }} />)}
      <div data-testid="composer-selector-slider-handle" style={{ position: 'absolute', zIndex: 2, left: `calc(11px + (100% - 22px) * ${progress})`, top: 10, width: 22, height: 22, marginLeft: -11, borderRadius: 999, background: accent, color: 'var(--t-accent-contrast)', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: `0 0 0 ${dragging ? 4 : 2}px color-mix(in srgb, ${accent} 18%, transparent), var(--t-panel-shadow)`, transform: dragging && !still ? 'scale(1.08)' : 'scale(1)', transitionProperty: 'left, transform, box-shadow', transitionDuration: `${transition}, ${transition}, ${transition}`, transitionTimingFunction: SPRING_EASE, pointerEvents: 'none' }}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M9 4a3 3 0 0 0-5 2.3 3.5 3.5 0 0 0-1 6.5 3.5 3.5 0 0 0 2 6.4A3 3 0 0 0 11 20V5a2 2 0 0 0-2-1Zm6 0a3 3 0 0 1 5 2.3 3.5 3.5 0 0 1 1 6.5 3.5 3.5 0 0 1-2 6.4A3 3 0 0 1 13 20V5a2 2 0 0 1 2-1ZM5 10h3m-1 6h4m8-6h-3m1 6h-4" /></svg>
      </div>
    </div>
    <div style={{ display: 'flex', marginTop: 0, marginRight: -6, marginLeft: -6 }}>
      {stops.map((effort) => <button key={effort} data-testid="composer-selector-effort-stop" data-effort={effort} type="button" aria-pressed={effort === state.effort} aria-disabled={state.lockedEffortOptions.includes(effort) ? true : undefined} disabled={disabled} onClick={(event) => selectEffort(effort, event.detail > 0)} onMouseEnter={() => setPreviewEffort(effort)} onMouseLeave={() => setPreviewEffort(null)} style={{ flex: '1 1 0', minWidth: 0, minHeight: 18, borderWidth: 0, padding: 0, background: 'transparent', color: effort === displayedEffort ? accent : 'var(--t-text-faint)', fontFamily: 'var(--font-sans-system)', fontSize: 9, fontWeight: 300, cursor: disabled || state.lockedEffortOptions.includes(effort) ? 'default' : 'pointer' }}>{effortLabel(effort)}</button>)}
    </div>
    <div data-testid="composer-selector-effort-consequence" style={{ marginTop: 8, minHeight: 15, color: isHotComposerEffort(previewEffort ?? state.effort) ? HOT_ACCENT : 'var(--t-text-muted)', fontSize: 11, fontWeight: 300, lineHeight: '15px', opacity: previewEffort && !dragging ? 0.7 : 1 }}>
      <DirectionalCopy value={effortConsequenceCopy(state.leadBackend, previewEffort ?? state.effort)} index={stops.indexOf(previewEffort ?? state.effort)} distance={3} duration={160} reducedMotion={still || dragging} />
    </div>
  </div>;
}
