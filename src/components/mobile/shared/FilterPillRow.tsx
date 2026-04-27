'use client';

import type { CSSProperties } from 'react';
import {
  MOBILE_BODY_TRACKING,
  mobileFontFamily,
  type MobilePalette,
} from '@/app/mobile/mobile-approvals-shared';

export interface FilterPillOption<T extends string> {
  value: T;
  label: string;
  count?: number;
}

interface FilterPillRowProps<T extends string> {
  options: ReadonlyArray<FilterPillOption<T>>;
  value: T;
  onChange: (next: T) => void;
  palette: MobilePalette;
  style?: CSSProperties;
}

export function FilterPillRow<T extends string>({
  options,
  value,
  onChange,
  palette,
  style,
}: FilterPillRowProps<T>) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'row',
        flexWrap: 'nowrap',
        gap: 8,
        overflowX: 'auto',
        overflowY: 'hidden',
        paddingLeft: 16,
        paddingRight: 16,
        paddingTop: 8,
        paddingBottom: 8,
        WebkitOverflowScrolling: 'touch',
        scrollbarWidth: 'none',
        msOverflowStyle: 'none',
        ...style,
      } as CSSProperties}
    >
      {options.map((option) => {
        const active = option.value === value;
        const showCount = typeof option.count === 'number';

        return (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            style={{
              flexShrink: 0,
              minHeight: 44,
              minWidth: 44,
              height: 32,
              paddingLeft: 14,
              paddingRight: 14,
              paddingTop: 0,
              paddingBottom: 0,
              borderRadius: 999,
              border: active
                ? `1px solid ${palette.rootText}`
                : `1px solid ${palette.cardBorder}`,
              background: active ? palette.rootText : palette.cardBackground,
              color: active ? palette.rootBackground : palette.mutedText,
              fontSize: 13,
              fontWeight: active ? 700 : 600,
              letterSpacing: MOBILE_BODY_TRACKING,
              fontFamily: mobileFontFamily(),
              cursor: 'pointer',
              touchAction: 'manipulation',
              WebkitTapHighlightColor: 'transparent',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 6,
              transition: 'background 160ms ease, color 160ms ease, border-color 160ms ease',
            }}
          >
            <span>{option.label}</span>
            {showCount ? (
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  opacity: active ? 0.86 : 0.7,
                }}
              >
                {option.count}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
