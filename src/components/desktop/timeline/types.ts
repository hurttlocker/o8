export type SegmentKind = 'thinking' | 'coding' | 'testing' | 'error' | 'idle';

export interface TimelineSegment {
  kind: SegmentKind;
  startMin: number;
  durationMin: number;
  label?: string;
  agent?: string;
  /**
   * First ERROR_PATTERN-matched line within an error block, captured by
   * the server accumulator. Lets the hover card surface a real snippet
   * (e.g. "Process exited with code 1") instead of generic "ERRORS".
   */
  errorMessage?: string;
}

export interface TimelineSegmentGeometry {
  index: number;
  seg: TimelineSegment;
  leftPct: number;
  widthPct: number;
  actualLeftPx: number;
  actualWidthPx: number;
  displayLeftPx: number;
  displayWidthPx: number;
  color: string;
  layer: number;
}
