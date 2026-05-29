'use client';

/**
 * Shared raw-SVG glyphs for orchestrator status surfaces (card badge + detail
 * modal header). Lives in its own file so both can import it without a cycle
 * (the card imports the modal). House rule: raw SVG, no icon components.
 */

import type { OrchestratorStatusEventData } from '@/lib/orchestrator/status-events';

export function StatusGlyph({
  event,
  stroke,
  size = 15,
  animate = true,
}: {
  event: OrchestratorStatusEventData;
  stroke: string;
  size?: number;
  animate?: boolean;
}) {
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke,
    strokeWidth: 1.9,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  };
  const draw = animate
    ? { strokeDasharray: 22, strokeDashoffset: 22, animation: 'o8StatusGlyphDraw 460ms cubic-bezier(0.22, 1, 0.36, 1) 140ms forwards' }
    : undefined;

  if (event.kind === 'merge') {
    return (
      <svg {...common}>
        <circle cx="4" cy="4" r="1.7" style={draw} />
        <circle cx="4" cy="12" r="1.7" style={draw} />
        <circle cx="12" cy="8" r="1.7" style={draw} />
        <path d="M4 5.7 V10.3 M5.6 4 H8 a2.4 2.4 0 0 1 2.4 2.4 V6.3" style={draw} />
      </svg>
    );
  }
  if (event.kind === 'heal' && event.outcome === 'needs-human') {
    return (
      <svg {...common}>
        <path d="M8 2.6 L14 12.4 H2 Z" style={draw} />
        <path d="M8 6.4 V9" style={draw} />
        <path d="M8 11 H8.01" style={draw} />
      </svg>
    );
  }
  if (event.kind === 'heal') {
    return (
      <svg {...common}>
        <path d="M12.6 6.2 A5 5 0 1 0 13 9.2" style={draw} />
        <path d="M12.8 3.2 V6.3 H9.7" style={draw} />
        <path d="M5.6 8.2 L7.2 9.8 L10.4 6.2" style={draw} />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <path d="M3.4 8.4 L6.5 11.5 L12.6 4.6" style={draw} />
    </svg>
  );
}
