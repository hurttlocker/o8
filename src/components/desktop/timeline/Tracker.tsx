'use client';

/**
 * Tracker — flex-row strip of variable-width blocks.
 *
 * Adapted from the IntentUI Tracker recipe (https://intentui.com/docs/components/visualizations/tracker)
 * for inline-styles + theme tokens. Strip pattern:
 *
 *   - Fixed-height row, each block flexes by `weight` (so a long activity
 *     gets a long block, a short one gets a short block).
 *   - Tiny horizontal padding between blocks → they sit near-touching
 *     with a 1px hair gap.
 *   - First / last blocks get rounded outer edges; inner blocks have
 *     1px rounded inner corners.
 *   - Hover dims the block to ~50% by default; consumers can override
 *     per-block via `hoveredOpacity`/`hovered` for cross-fade highlights.
 *
 * No tooltip baked in — consumers wire their own (rich hover card,
 * portal popover, scrubber, drill-down). The primitive only paints.
 */

import { useCallback, useRef, type CSSProperties, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';

export interface TrackerBlock {
  /** Stable React key. */
  key: string;
  /**
   * Width weight (typically `durationMin`). Block width =
   * `weight / sum(weights) * trackWidth`. Use `0` to render as a
   * 1px hairline — useful for instant-marker events.
   */
  weight: number;
  /** Background color of the block (any CSS color value). */
  color: string;
  /**
   * Optional cap on opacity. 1 = fully opaque (default).
   * Use values < 1 to render lower-priority bands as ghosted.
   */
  opacity?: number;
}

export interface TrackerHoverInfo {
  /** Index of the block under the cursor. */
  blockIndex: number;
  /** Cursor x in px relative to the track's left edge. */
  x: number;
  /** Total track width in px. */
  trackWidth: number;
  /** 0..1 fraction of total width under the cursor. */
  fraction: number;
  /** 0..1 fraction within the hovered block. */
  blockFraction: number;
  /** Cursor's clientX (page coords) for portal positioning. */
  clientX: number;
  /** Track's bounding-rect top, in client coords. */
  trackTop: number;
  /** Track's bounding-rect bottom, in client coords. */
  trackBottom: number;
}

interface TrackerProps {
  blocks: TrackerBlock[];
  /** Track height in px. Default 20 to match TIMELINE_BAR_HEIGHT. */
  height?: number;
  /** Track background. Defaults to `var(--t-timeline-bar)`. */
  trackBackground?: string;
  /** Outer corner radius (rounds first/last blocks' outer edges). Default 4. */
  trackRadius?: number;
  /** Inner corner radius for each block. Default 1 (matches Tracker). */
  blockRadius?: number;
  /** Horizontal hair-gap padding per side, in px. Default 0.5. */
  blockGap?: number;
  /** External hover index (e.g. driven by keyboard nav). */
  hoveredIndex?: number | null;
  /** Multiplier applied to a hovered block's opacity. Default 0.55. */
  hoverDim?: number;
  /** Continuous mouse-move callback — fires for every pointer move on the track. */
  onHoverMove?: (info: TrackerHoverInfo | null) => void;
  /** Click callback — fires once per click; receives same shape as hover. */
  onBlockClick?: (info: TrackerHoverInfo) => void;
  /** Inline style overrides for the outer track. */
  style?: CSSProperties;
  /** Optional overlay rendered ON TOP of the strip (scrubber line, etc). */
  overlay?: ReactNode;
  /**
   * When true, the LAST block gets a `timelineNowPulse` CSS animation
   * applied to its inner color fill. Lets the rightmost cell read as
   * "live now" without painting an extra tick outside the strip.
   * Requires the keyframe to be defined globally (see globals.css).
   */
  pulseLastBlock?: boolean;
}

export function Tracker({
  blocks,
  height = 20,
  trackBackground = 'var(--t-timeline-bar)',
  trackRadius = 4,
  blockRadius = 1,
  blockGap = 0.5,
  hoveredIndex = null,
  hoverDim = 0.55,
  onHoverMove,
  onBlockClick,
  style,
  overlay,
  pulseLastBlock = false,
}: TrackerProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const totalWeight = blocks.reduce((sum, b) => sum + Math.max(0, b.weight), 0);

  const computeHoverInfo = useCallback((event: ReactMouseEvent<HTMLDivElement>): TrackerHoverInfo | null => {
    const node = trackRef.current;
    if (!node || totalWeight <= 0 || blocks.length === 0) return null;
    const rect = node.getBoundingClientRect();
    const x = Math.max(0, Math.min(rect.width, event.clientX - rect.left));
    const fraction = rect.width > 0 ? x / rect.width : 0;
    let cursor = 0;
    let blockIndex = 0;
    let blockFraction = 0;
    for (let i = 0; i < blocks.length; i += 1) {
      const slice = (Math.max(0, blocks[i].weight) / totalWeight) * rect.width;
      if (x <= cursor + slice || i === blocks.length - 1) {
        blockIndex = i;
        blockFraction = slice > 0 ? Math.max(0, Math.min(1, (x - cursor) / slice)) : 0;
        break;
      }
      cursor += slice;
    }
    return {
      blockIndex,
      x,
      trackWidth: rect.width,
      fraction,
      blockFraction,
      clientX: event.clientX,
      trackTop: rect.top,
      trackBottom: rect.bottom,
    };
  }, [blocks, totalWeight]);

  const handleMouseMove = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if (!onHoverMove) return;
    onHoverMove(computeHoverInfo(event));
  }, [computeHoverInfo, onHoverMove]);

  const handleMouseLeave = useCallback(() => {
    onHoverMove?.(null);
  }, [onHoverMove]);

  const handleClick = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if (!onBlockClick) return;
    const info = computeHoverInfo(event);
    if (info) onBlockClick(info);
  }, [computeHoverInfo, onBlockClick]);

  const lastIndex = blocks.length - 1;

  return (
    <div
      ref={trackRef}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      onClick={handleClick}
      style={{
        display: 'flex',
        alignItems: 'stretch',
        height,
        width: '100%',
        background: trackBackground,
        borderRadius: trackRadius,
        overflow: 'hidden',
        position: 'relative',
        cursor: onBlockClick || onHoverMove ? 'crosshair' : 'default',
        ...style,
      }}
    >
      {blocks.map((block, index) => {
        const isFirst = index === 0;
        const isLast = index === lastIndex;
        const weight = Math.max(0, block.weight);
        const isHovered = hoveredIndex === index;
        const baseOpacity = block.opacity ?? 1;
        const effectiveOpacity = isHovered ? baseOpacity * hoverDim : baseOpacity;
        const cellPaddingLeft = isFirst ? 0 : blockGap;
        const cellPaddingRight = isLast ? 0 : blockGap;
        return (
          <div
            key={block.key}
            style={{
              flexGrow: weight,
              flexShrink: 0,
              flexBasis: weight === 0 ? 1 : 0,
              minWidth: weight === 0 ? 1 : 0,
              paddingLeft: cellPaddingLeft,
              paddingRight: cellPaddingRight,
            }}
          >
            <div
              style={{
                width: '100%',
                height: '100%',
                background: block.color,
                opacity: effectiveOpacity,
                transition: 'opacity 120ms cubic-bezier(0.22, 1, 0.36, 1)',
                borderTopLeftRadius: isFirst ? trackRadius : blockRadius,
                borderBottomLeftRadius: isFirst ? trackRadius : blockRadius,
                borderTopRightRadius: isLast ? trackRadius : blockRadius,
                borderBottomRightRadius: isLast ? trackRadius : blockRadius,
                animation: isLast && pulseLastBlock
                  ? 'timelineNowPulse 1.6s ease-in-out infinite'
                  : undefined,
              }}
            />
          </div>
        );
      })}
      {overlay}
    </div>
  );
}
