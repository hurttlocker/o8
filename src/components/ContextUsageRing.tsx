import type { CSSProperties } from 'react';

interface ContextUsageRingProps {
  percent?: number | null;
  size?: number;
  strokeWidth?: number;
  label?: string;
}

type RingTone = {
  stroke: string;
  text: string;
  track: string;
};

function ringTone(percent: number): RingTone {
  if (percent >= 95) {
    return {
      stroke: '#ef4444',
      text: '#b91c1c',
      track: 'rgba(239, 68, 68, 0.16)',
    };
  }

  if (percent >= 80) {
    return {
      stroke: '#f59e0b',
      text: '#b45309',
      track: 'rgba(245, 158, 11, 0.16)',
    };
  }

  return {
    stroke: 'rgba(22, 163, 74, 0.88)',
    text: '#166534',
    track: 'rgba(22, 163, 74, 0.12)',
  };
}

export function ContextUsageRing({
  percent,
  size = 26,
  strokeWidth = 2.5,
  label,
}: ContextUsageRingProps) {
  const normalizedPercent = Math.max(0, Math.min(100, Math.round(percent ?? 0)));
  const tone = ringTone(normalizedPercent);
  const radius = Math.max(1, (size - strokeWidth * 2) / 2);
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset = circumference - (normalizedPercent / 100) * circumference;

  const wrapperStyle: CSSProperties = {
    position: 'relative',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: size,
    height: size,
    flexShrink: 0,
  };

  const textStyle: CSSProperties = {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: Math.max(8, Math.round(size * 0.32)),
    fontWeight: 700,
    letterSpacing: '-0.02em',
    color: tone.text,
    fontFamily: '"SF Mono", ui-monospace, monospace',
    lineHeight: 1,
    pointerEvents: 'none',
  };

  const title = label ?? `${normalizedPercent}% context used`;

  return (
    <span style={wrapperStyle} title={title} aria-label={title}>
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        style={{ display: 'block', transform: 'rotate(-90deg)' }}
        aria-hidden="true"
      >
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={tone.track}
          strokeWidth={strokeWidth}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={tone.stroke}
          strokeWidth={strokeWidth}
          strokeDasharray={circumference}
          strokeDashoffset={strokeDashoffset}
          strokeLinecap="round"
          style={{ transitionProperty: 'stroke-dashoffset, stroke', transitionDuration: '180ms', transitionTimingFunction: 'ease' } as React.CSSProperties}
        />
      </svg>
      <span style={textStyle}>{normalizedPercent}</span>
    </span>
  );
}
