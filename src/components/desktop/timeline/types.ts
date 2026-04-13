export type SegmentKind = 'thinking' | 'coding' | 'testing' | 'error' | 'idle';

export interface TimelineSegment {
  kind: SegmentKind;
  startMin: number;
  durationMin: number;
  label?: string;
  agent?: string;
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
