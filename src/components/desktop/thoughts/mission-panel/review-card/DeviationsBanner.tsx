'use client';

import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import { FONT_FAMILY } from './shared';

/**
 * #1490 — worker deviations, rendered ABOVE the diff in every human review
 * surface. `packet.deviations` is captured at review time from the lane
 * worktree's ignored packet notes artifact. Empty/absent renders an asserted
 * "No deviations reported" line, never nothing — silence here is a real signal.
 */
export function DeviationsBanner({ packet }: { packet: OrchestratorPacket }) {
  const entries = packet.deviations?.entries ?? [];
  const hasDeviations = entries.length > 0;

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      gap: 4,
      paddingTop: 6,
      paddingRight: 8,
      paddingBottom: 6,
      paddingLeft: 8,
      borderRadius: 8,
      borderWidth: 1,
      borderStyle: 'solid',
      borderColor: hasDeviations ? 'rgba(245, 158, 11, 0.22)' : 'var(--t-divider)',
      background: hasDeviations ? 'rgba(245, 158, 11, 0.08)' : 'var(--t-bg-subtle)',
    }}>
      <div style={{
        fontSize: 9.5,
        fontWeight: 700,
        letterSpacing: '0.04em',
        textTransform: 'uppercase',
        color: hasDeviations ? '#b45309' : 'var(--t-text-faint)',
        fontFamily: FONT_FAMILY,
      }}>
        Deviations from brief
      </div>
      {hasDeviations ? (
        <ul style={{ margin: 0, paddingLeft: 16, display: 'flex', flexDirection: 'column', gap: 2 }}>
          {entries.map((entry, idx) => (
            <li key={idx} style={{
              fontSize: 10.5,
              color: 'var(--t-text-secondary)',
              fontFamily: FONT_FAMILY,
              lineHeight: 1.4,
            }}>
              {entry}
            </li>
          ))}
        </ul>
      ) : (
        <div style={{ fontSize: 10.5, color: 'var(--t-text-muted)', fontFamily: FONT_FAMILY }}>
          No deviations reported.
        </div>
      )}
    </div>
  );
}
