'use client';

// #772 — Linear-style sectioned packet list for Mission Control.
// Wraps the packet render output in collapsible status sections. Pure
// presentation: takes a renderPacket callback so the parent Mission panel
// keeps owning PacketCard / ComparisonCard wiring.

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import {
  PACKET_GROUP_ORDER,
  groupPacketsByStatus,
  type PacketGroupId,
} from './groupPackets';

const GROUP_OPEN_LS_PREFIX = 'cortex-ide:mission:group-open:';

function readPersistedOpen(id: PacketGroupId, fallback: boolean): boolean {
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = window.localStorage.getItem(`${GROUP_OPEN_LS_PREFIX}${id}`);
    if (raw === null) return fallback;
    return raw === '1';
  } catch {
    return fallback;
  }
}

function writePersistedOpen(id: PacketGroupId, open: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(`${GROUP_OPEN_LS_PREFIX}${id}`, open ? '1' : '0');
  } catch {
    // localStorage write failed — not a problem, next session falls back to default.
  }
}

interface StatusGroupedLanesProps {
  packets: OrchestratorPacket[];
  /**
   * Render-prop for each packet. Returning `null` skips the row — the parent
   * uses this to dedupe comparison-group siblings. Skipped rows are NOT
   * counted toward the section header, since the rendered ComparisonCard
   * appears at the position of the first sibling and counts as one row.
   */
  renderPacket: (packet: OrchestratorPacket) => ReactNode;
}

/**
 * Renders packets grouped by status. Empty sections are skipped entirely
 * so the operator never sees `DONE · 0` headers. Open/closed state is
 * persisted to localStorage per-group key.
 */
export function StatusGroupedLanes({ packets, renderPacket }: StatusGroupedLanesProps) {
  // Initialise open state per group from localStorage, falling back to the
  // default in PACKET_GROUP_ORDER. Done once at mount — toggling persists
  // back via the click handler.
  const [openByGroup, setOpenByGroup] = useState<Record<PacketGroupId, boolean>>(() => {
    const seed = {} as Record<PacketGroupId, boolean>;
    for (const def of PACKET_GROUP_ORDER) {
      seed[def.id] = readPersistedOpen(def.id, def.defaultOpen);
    }
    return seed;
  });

  // Cross-tab sync: if another window flips a group, mirror it here.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onStorage = (event: StorageEvent) => {
      if (!event.key || !event.key.startsWith(GROUP_OPEN_LS_PREFIX)) return;
      const id = event.key.slice(GROUP_OPEN_LS_PREFIX.length) as PacketGroupId;
      const def = PACKET_GROUP_ORDER.find((d) => d.id === id);
      if (!def) return;
      const next = event.newValue === '1' ? true : event.newValue === '0' ? false : def.defaultOpen;
      setOpenByGroup((prev) => (prev[id] === next ? prev : { ...prev, [id]: next }));
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const toggleGroup = useCallback((id: PacketGroupId) => {
    setOpenByGroup((prev) => {
      const next = !prev[id];
      writePersistedOpen(id, next);
      return { ...prev, [id]: next };
    });
  }, []);

  const grouped = groupPacketsByStatus(packets);

  return (
    <>
      {PACKET_GROUP_ORDER.map((def) => {
        const groupPackets = grouped[def.id];
        // Empty sections collapse — never render a `DONE · 0` header.
        if (groupPackets.length === 0) return null;

        // Render the packet rows once so we can count "visible" rows for
        // the header badge. A child returning null (e.g. a comparison-group
        // sibling already rendered above) doesn't count toward the badge.
        const renderedRows: ReactNode[] = [];
        let visibleCount = 0;
        for (const packet of groupPackets) {
          const node = renderPacket(packet);
          if (node === null || node === undefined || node === false) continue;
          renderedRows.push(node);
          visibleCount += 1;
        }
        // Edge case: every packet in this group was deduped (e.g. a
        // comparison group whose representative was rendered in another
        // section). Treat as empty.
        if (visibleCount === 0) return null;

        const open = openByGroup[def.id];
        return (
          <div key={def.id} style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
            <button
              type="button"
              onClick={() => toggleGroup(def.id)}
              aria-expanded={open}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                height: 28,
                paddingTop: 0,
                paddingRight: 8,
                paddingBottom: 0,
                paddingLeft: 8,
                border: 'none',
                background: 'transparent',
                cursor: 'pointer',
                position: 'sticky',
                top: 0,
                zIndex: 1,
                fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
              }}
            >
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  textTransform: 'uppercase' as const,
                  letterSpacing: '0.05em',
                  color: 'var(--t-text-muted)',
                }}
              >
                {def.label}
              </span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span
                  style={{
                    paddingTop: 1,
                    paddingRight: 6,
                    paddingBottom: 1,
                    paddingLeft: 6,
                    borderRadius: 999,
                    background: 'var(--t-divider-subtle)',
                    color: 'var(--t-text-secondary)',
                    fontSize: 10,
                    fontWeight: 700,
                    fontFamily: 'var(--font-mono, "SF Mono", Menlo, monospace)',
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  {visibleCount}
                </span>
                <svg
                  width={10}
                  height={10}
                  viewBox="0 0 10 10"
                  fill="none"
                  stroke="var(--t-text-muted)"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  style={{
                    transform: open ? 'rotate(0deg)' : 'rotate(-90deg)',
                    transition: 'transform 150ms cubic-bezier(0.22, 1, 0.36, 1)',
                  }}
                >
                  <path d="M2.5 3.5L5 6L7.5 3.5" />
                </svg>
              </div>
            </button>
            {open ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {renderedRows}
              </div>
            ) : null}
          </div>
        );
      })}
    </>
  );
}
