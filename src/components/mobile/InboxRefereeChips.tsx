'use client';

import { useRef, useState, type CSSProperties } from 'react';
import type { MobileInboxRefereeChip } from '@/lib/mobile/types';

const SYSTEM_FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", system-ui, sans-serif';
const LONG_PRESS_MS = 450;
const CHIP_LABEL: Record<MobileInboxRefereeChip['kind'], string> = { 'docs-only': 'Docs only' };

interface ChipPalette {
  background: string;
  cardBorder: string;
  textSecondary: string;
  textTertiary: string;
}

function RefereeChip({ chip, palette }: { chip: MobileInboxRefereeChip; palette: ChipPalette }) {
  const [revealed, setRevealed] = useState(false);
  const timer = useRef<number | null>(null);
  const cancel = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
      <button
        type="button"
        aria-label={`${CHIP_LABEL[chip.kind]}, referee advisory. Long-press for the probability.`}
        onPointerDown={() => {
          cancel();
          timer.current = window.setTimeout(() => setRevealed((current) => !current), LONG_PRESS_MS);
        }}
        onPointerUp={cancel}
        onPointerLeave={cancel}
        onPointerCancel={cancel}
        onContextMenu={(event) => event.preventDefault()}
        style={{
          minHeight: 44,
          display: 'inline-flex',
          alignItems: 'center',
          paddingTop: 0,
          paddingBottom: 0,
          paddingLeft: 0,
          paddingRight: 0,
          border: 'none',
          background: 'transparent',
          cursor: 'pointer',
          WebkitTapHighlightColor: 'transparent',
          WebkitTouchCallout: 'none',
          userSelect: 'none',
        } as CSSProperties}
      >
        <span
          style={{
            height: 26,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            paddingLeft: 10,
            paddingRight: 10,
            borderRadius: 7,
            border: `1px solid ${palette.cardBorder}`,
            background: palette.background,
            color: palette.textSecondary,
            fontSize: 12,
            fontWeight: 400,
            letterSpacing: '-0.1px',
            lineHeight: 1.25,
            fontFamily: SYSTEM_FONT,
          }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <path d="M14 2v6h6" />
            <path d="M16 13H8" />
            <path d="M16 17H8" />
          </svg>
          {CHIP_LABEL[chip.kind]}
        </span>
      </button>
      {revealed ? (
        <span
          style={{
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontSize: 12,
            color: palette.textTertiary,
            fontFamily: SYSTEM_FONT,
            userSelect: 'text',
          }}
        >
          {chip.probability.toFixed(2)}
          {chip.receiptId ? ` · receipt ${chip.receiptId}` : ''}
        </span>
      ) : null}
    </div>
  );
}

/** Advisory referee chips on an approval card. Renders nothing without chips. */
export function InboxRefereeChips({ chips, palette }: { chips?: MobileInboxRefereeChip[]; palette: ChipPalette }) {
  if (!chips?.length) return null;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 6 }}>
      {chips.map((chip) => <RefereeChip key={chip.kind} chip={chip} palette={palette} />)}
    </div>
  );
}
