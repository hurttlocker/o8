'use client';

import type { RippleChoice, RippleChoiceResolution } from '@/lib/mobile/ripple-contract';
import {
  MOBILE_GLASS_BLUR,
  type MobilePalette,
  mobileFontFamily,
} from './mobile-approvals-shared';

export function MobileRippleOverlay({
  palette,
  resolution,
  onResolve,
  onDismiss,
}: {
  palette: MobilePalette;
  resolution: RippleChoiceResolution;
  onResolve: (choice: RippleChoice) => void;
  onDismiss: () => void;
}) {
  return (
    <div
      role="group"
      aria-label="Resolve intent"
      style={{
        marginBottom: 8,
        borderRadius: 18,
        border: `1px solid ${palette.cardBorder}`,
        background: palette.panelElevated,
        backdropFilter: `blur(${MOBILE_GLASS_BLUR}px)`,
        WebkitBackdropFilter: `blur(${MOBILE_GLASS_BLUR}px)`,
        boxShadow: palette.shadow,
        paddingTop: 10,
        paddingBottom: 10,
        paddingLeft: 12,
        paddingRight: 12,
        fontFamily: mobileFontFamily(),
      }}
    >
      <div
        aria-live="polite"
        style={{
          color: palette.rootText,
          fontSize: 13,
          fontWeight: 400,
          letterSpacing: '-0.1px',
          lineHeight: 1.35,
          marginBottom: 8,
        }}
      >
        {resolution.question}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
        {resolution.options.map((choice) => (
          <button
            key={choice.value}
            type="button"
            onClick={() => onResolve(choice)}
            style={{
              minHeight: 44,
              borderRadius: 14,
              border: `1px solid ${palette.cardBorder}`,
              background: palette.cardBackground,
              color: palette.rootText,
              paddingTop: 0,
              paddingBottom: 0,
              paddingLeft: 12,
              paddingRight: 12,
              fontFamily: mobileFontFamily(),
              fontSize: 12,
              fontWeight: 300,
              letterSpacing: '-0.1px',
              cursor: 'pointer',
              touchAction: 'manipulation',
              WebkitTapHighlightColor: 'transparent',
            }}
          >
            {choice.label}
          </button>
        ))}
        <button
          type="button"
          onClick={onDismiss}
          style={{
            minHeight: 44,
            border: 'none',
            background: 'transparent',
            color: palette.subduedText,
            paddingTop: 0,
            paddingBottom: 0,
            paddingLeft: 8,
            paddingRight: 8,
            fontFamily: mobileFontFamily(),
            fontSize: 11,
            fontWeight: 300,
            cursor: 'pointer',
            touchAction: 'manipulation',
            WebkitTapHighlightColor: 'transparent',
          }}
        >
          Not now
        </button>
      </div>
    </div>
  );
}
