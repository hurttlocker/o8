'use client';

import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { MODEL_EFFORT_LABELS } from '../ModelThinkingChip';
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
const SPRING_EASE = 'cubic-bezier(.34,1.56,.64,1)';
const HOT_ACCENT = 'var(--t-brand-orange)';

function effortLabel(effort: ResolvedComposerSelectorState['effort']): string {
  const label = MODEL_EFFORT_LABELS[effort];
  return `${label[0].toUpperCase()}${label.slice(1)}`;
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

export function EffortSlider({
  state,
  onPick,
  disabled = false,
}: {
  state: ResolvedComposerSelectorState;
  onPick: (effort: ResolvedComposerSelectorState['effort']) => void;
  disabled?: boolean;
}) {
  const reducedMotion = useReducedMotion();
  const stops = orderedEffortSliderStops(state.effortOptions, state.lockedEffortOptions);
  const currentIndex = Math.max(0, stops.indexOf(state.effort));
  const progress = effortSliderProgress(currentIndex, stops.length);
  const [previewEffort, setPreviewEffort] = useState<ResolvedComposerSelectorState['effort'] | null>(null);
  const [dragging, setDragging] = useState(false);
  const [focused, setFocused] = useState(false);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const handleRef = useRef<HTMLDivElement | null>(null);
  const ultraDotRef = useRef<HTMLSpanElement | null>(null);
  const draggingRef = useRef(false);
  const displayedEffort = previewEffort ?? state.effort;
  const displayedIndex = Math.max(0, stops.indexOf(displayedEffort));
  const hot = isHotComposerEffort(state.effort);
  const displayedHot = isHotComposerEffort(displayedEffort);
  const handleDuration = reducedMotion ? '0ms' : dragging ? '60ms' : '300ms';
  const fillDuration = reducedMotion ? '0ms' : dragging ? '60ms' : '260ms';
  const movementEase = dragging ? 'linear' : SPRING_EASE;

  useEffect(() => {
    if (state.effort !== 'ultra' || reducedMotion) return;
    const animation = ultraDotRef.current?.animate?.(
      [{ opacity: 1 }, { opacity: 0.35 }, { opacity: 1 }],
      { duration: 1200, iterations: Infinity, easing: 'ease-in-out' },
    );
    return () => animation?.cancel();
  }, [reducedMotion, state.effort]);

  const bumpToward = (effort: ResolvedComposerSelectorState['effort']) => {
    if (reducedMotion) return;
    const targetIndex = stops.indexOf(effort);
    const direction = targetIndex < currentIndex ? -4 : 4;
    handleRef.current?.animate?.(
      [
        { transform: 'translateX(0) scale(1)' },
        { transform: `translateX(${direction}px) scale(1.06)`, offset: 0.4 },
        { transform: 'translateX(0) scale(1)' },
      ],
      { duration: 260, easing: SPRING_EASE },
    );
  };

  const selectEffort = (effort: ResolvedComposerSelectorState['effort']) => {
    if (disabled) return;
    if (state.lockedEffortOptions.includes(effort)) {
      bumpToward(effort);
      return;
    }
    if (state.effortOptions.includes(effort) && effort !== state.effort) onPick(effort);
  };

  const effortAtPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return effortSliderStopAtPointer(event.clientX, bounds.left, bounds.width, stops);
  };

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    setDragging(false);
    setPreviewEffort(null);
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (disabled) return;
    event.preventDefault();
    event.currentTarget.focus();
    const effort = effortAtPointer(event);
    if (!effort) return;
    if (state.lockedEffortOptions.includes(effort)) {
      bumpToward(effort);
      setPreviewEffort(effort);
      return;
    }
    draggingRef.current = true;
    setDragging(true);
    event.currentTarget.setPointerCapture?.(event.pointerId);
    selectEffort(effort);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (disabled) return;
    const effort = effortAtPointer(event);
    if (!effort) return;
    if (draggingRef.current) selectEffort(effort);
    else setPreviewEffort(effort === state.effort ? null : effort);
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
    selectEffort(stops[targetIndex]);
  };

  return (
    <div
      data-testid="composer-selector-lead-effort"
      style={{
        marginTop: 2,
        marginRight: 6,
        marginBottom: 6,
        marginLeft: 31,
        paddingTop: 10,
        paddingRight: 12,
        paddingBottom: 10,
        paddingLeft: 12,
        borderRadius: 9,
        background: 'var(--t-bg-card)',
        userSelect: 'none',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, minHeight: 22 }}>
        <span
          data-testid="composer-selector-slider-level"
          style={{
            color: hot ? HOT_ACCENT : 'var(--t-text)',
            fontSize: 17,
            fontWeight: 400,
            letterSpacing: '-0.3px',
          }}
        >
          <DirectionalCopy
            value={effortLabel(state.effort)}
            index={currentIndex}
            distance={8}
            duration={reducedMotion ? 0 : 260}
            reducedMotion={reducedMotion}
          />
        </span>
        <span style={{ marginLeft: 'auto', color: 'var(--t-text-faint)', fontSize: 10 }}>
          {`${currentIndex + 1} of ${stops.length}`}
        </span>
        {state.effort !== 'high' && state.effortOptions.includes('high') ? (
          <button
            type="button"
            disabled={disabled}
            onClick={() => selectEffort('high')}
            style={{
              borderWidth: 0,
              paddingTop: 0,
              paddingRight: 0,
              paddingBottom: 0,
              paddingLeft: 0,
              background: 'transparent',
              color: 'var(--t-accent)',
              fontFamily: 'var(--font-sans-system)',
              fontSize: 10,
              fontWeight: 300,
              lineHeight: '12px',
              whiteSpace: 'nowrap',
              cursor: disabled ? 'default' : 'pointer',
              opacity: disabled ? 0.6 : 1,
            }}
          >
            Reset to High
          </button>
        ) : null}
      </div>
      <div
        ref={trackRef}
        data-testid="composer-selector-effort-slider"
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label="Thinking effort"
        aria-valuemin={0}
        aria-valuemax={Math.max(0, stops.length - 1)}
        aria-valuenow={currentIndex}
        aria-valuetext={effortLabel(state.effort)}
        aria-disabled={disabled ? true : undefined}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onKeyDown={onKeyDown}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onPointerLeave={(event) => {
          if (!draggingRef.current) setPreviewEffort(null);
          if (draggingRef.current && event.buttons === 0) endDrag(event);
        }}
        style={{
          position: 'relative',
          height: 44,
          touchAction: 'none',
          cursor: disabled ? 'default' : 'pointer',
          outline: 'none',
          borderRadius: 10,
          boxShadow: focused ? '0 0 0 2px var(--t-accent)' : 'none',
        }}
      >
        <div style={{ position: 'absolute', left: 11, right: 11, top: 18, height: 8, borderRadius: 999, background: 'color-mix(in srgb, var(--t-text-faint) 22%, transparent)' }} />
        <div
          data-testid="composer-selector-slider-fill"
          data-accent={hot ? 'swarm' : 'lead'}
          style={{
            position: 'absolute',
            left: 11,
            top: 18,
            width: `calc((100% - 22px) * ${progress})`,
            height: 8,
            borderRadius: 999,
            background: hot
              ? `linear-gradient(90deg, var(--t-accent), ${HOT_ACCENT})`
              : 'var(--t-accent)',
            transitionProperty: 'width, background',
            transitionDuration: `${fillDuration}, ${reducedMotion ? '0ms' : '260ms'}`,
            transitionTimingFunction: `${movementEase}, ${FADE_EASE}`,
          }}
        />
        {stops.map((effort, index) => {
          const stopProgress = effortSliderProgress(index, stops.length);
          const lit = index <= currentIndex;
          const near = Math.abs(index - currentIndex) === 1;
          return (
            <span
              key={effort}
              aria-hidden
              style={{
                position: 'absolute',
                zIndex: 1,
                left: `calc(11px + (100% - 22px) * ${stopProgress})`,
                top: 20,
                width: 4,
                height: 4,
                marginLeft: -2,
                borderRadius: 999,
                background: lit
                  ? 'color-mix(in srgb, var(--t-input-bg) 70%, transparent)'
                  : 'color-mix(in srgb, var(--t-text-faint) 55%, transparent)',
                transform: lit ? 'scale(0.7)' : near ? 'scale(1.6)' : 'scale(1)',
                transitionProperty: 'transform, background',
                transitionDuration: reducedMotion ? '0ms' : '240ms, 200ms',
                transitionTimingFunction: `${SPRING_EASE}, ${FADE_EASE}`,
              }}
            />
          );
        })}
        <div
          ref={handleRef}
          data-testid="composer-selector-slider-handle"
          style={{
            position: 'absolute',
            zIndex: 2,
            left: `calc(11px + (100% - 22px) * ${progress})`,
            top: 11,
            width: 22,
            height: 22,
            marginLeft: -11,
            borderRadius: 999,
            borderWidth: 2.5,
            borderStyle: 'solid',
            borderColor: hot ? HOT_ACCENT : 'var(--t-accent)',
            background: 'var(--t-input-bg)',
            boxShadow: hot
              ? `var(--t-panel-shadow), 0 0 0 6px color-mix(in srgb, ${HOT_ACCENT} 18%, transparent)`
              : 'var(--t-panel-shadow)',
            transform: dragging ? 'scale(1.12)' : 'scale(1)',
            transitionProperty: 'left, border-color, box-shadow, transform',
            transitionDuration: `${handleDuration}, ${reducedMotion ? '0ms' : '220ms'}, ${reducedMotion ? '0ms' : '220ms'}, ${reducedMotion ? '0ms' : '160ms'}`,
            transitionTimingFunction: `${movementEase}, ${FADE_EASE}, ${FADE_EASE}, ${FADE_EASE}`,
            pointerEvents: 'none',
          }}
        />
      </div>
      <div style={{ display: 'flex', marginTop: -4, marginRight: -6, marginLeft: -6 }}>
        {stops.map((effort) => {
          const selected = effort === state.effort;
          const locked = state.lockedEffortOptions.includes(effort);
          return (
            <button
              key={effort}
              data-testid="composer-selector-effort-stop"
              data-effort={effort}
              type="button"
              aria-pressed={selected}
              aria-disabled={locked ? true : undefined}
              disabled={disabled}
              onClick={() => selectEffort(effort)}
              onMouseEnter={() => setPreviewEffort(effort === state.effort ? null : effort)}
              onMouseLeave={() => setPreviewEffort(null)}
              onFocus={() => setPreviewEffort(effort === state.effort ? null : effort)}
              onBlur={() => setPreviewEffort(null)}
              style={{
                flex: '1 1 0',
                minWidth: 0,
                borderWidth: 0,
                height: 11,
                paddingTop: 0,
                paddingRight: 0,
                paddingBottom: 0,
                paddingLeft: 0,
                background: 'transparent',
                color: locked
                  ? 'var(--t-text-faint)'
                  : selected && isHotComposerEffort(effort)
                    ? HOT_ACCENT
                    : selected ? 'var(--t-text)' : 'var(--t-text-faint)',
                fontFamily: 'var(--font-sans-system)',
                fontSize: 9,
                fontWeight: 300,
                lineHeight: '11px',
                whiteSpace: 'nowrap',
                cursor: disabled || locked ? 'default' : 'pointer',
                opacity: disabled ? 0.6 : locked ? 0.45 : 1,
                transitionProperty: 'color, opacity',
                transitionDuration: reducedMotion ? '0ms' : '180ms',
                transitionTimingFunction: FADE_EASE,
              }}
            >
              {effortLabel(effort)}
            </button>
          );
        })}
      </div>
      <div
        data-testid="composer-selector-effort-consequence"
        style={{
          display: 'flex',
          alignItems: 'center',
          marginTop: 8,
          minHeight: 15,
          color: displayedHot ? HOT_ACCENT : 'var(--t-text-muted)',
          fontSize: 11,
          fontWeight: 300,
          lineHeight: '15px',
          opacity: previewEffort ? 0.7 : 1,
          transitionProperty: 'color, opacity',
          transitionDuration: reducedMotion ? '0ms' : '200ms',
          transitionTimingFunction: FADE_EASE,
        }}
      >
        {state.effort === 'ultra' ? (
          <span
            ref={ultraDotRef}
            aria-hidden
            style={{
              flexShrink: 0,
              width: 6,
              height: 6,
              marginRight: 6,
              borderRadius: 999,
              background: HOT_ACCENT,
            }}
          />
        ) : null}
        <DirectionalCopy
          value={composerEffortConsequence(state.leadBackend, displayedEffort)}
          index={displayedIndex}
          distance={4}
          duration={reducedMotion ? 0 : 220}
          reducedMotion={reducedMotion}
        />
      </div>
    </div>
  );
}
