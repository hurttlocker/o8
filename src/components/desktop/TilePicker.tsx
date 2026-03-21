'use client';

import type { TileContentKind } from '@/lib/tiles/types';

interface TilePickerOption {
  kind: TileContentKind;
  label: string;
  description: string;
  disabled?: boolean;
}

interface TilePickerProps {
  options: TilePickerOption[];
  onSelect: (kind: TileContentKind) => void;
  onCancel?: () => void;
}

export function TilePicker({ options, onSelect, onCancel }: TilePickerProps) {
  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      flexGrow: 1,
      flexShrink: 1,
      flexBasis: '0%',
      minHeight: 0,
      minWidth: 0,
      backgroundColor: 'var(--t-bg-subtle)',
    }}>
      <div style={{
        paddingTop: 18,
        paddingRight: 18,
        paddingBottom: 10,
        paddingLeft: 18,
        borderBottomWidth: 1,
        borderBottomStyle: 'solid',
        borderBottomColor: 'var(--t-divider)',
      }}>
        <div style={{
          fontSize: 14,
          fontWeight: 700,
          color: 'var(--t-text)',
          letterSpacing: '-0.02em',
          marginBottom: 4,
        }}>
          Choose tile content
        </div>
        <div style={{
          fontSize: 12,
          color: 'var(--t-text-muted)',
          lineHeight: 1.5,
        }}>
          Each panel is modular. Pick the surface you want this tile to host.
        </div>
      </div>

      <div style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        paddingTop: 16,
        paddingRight: 16,
        paddingBottom: 16,
        paddingLeft: 16,
        overflowY: 'auto',
        overflowX: 'hidden',
        flexGrow: 1,
        flexShrink: 1,
        flexBasis: '0%',
        minHeight: 0,
      }}>
        {options.map((option) => (
          <button
            key={option.kind}
            type="button"
            disabled={option.disabled}
            onClick={() => onSelect(option.kind)}
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'flex-start',
              gap: 5,
              width: '100%',
              paddingTop: 14,
              paddingRight: 14,
              paddingBottom: 14,
              paddingLeft: 14,
              borderRadius: 14,
              borderWidth: 1,
              borderStyle: 'solid',
              borderColor: option.disabled ? 'rgba(148,163,184,0.1)' : 'rgba(148,163,184,0.16)',
              backgroundColor: option.disabled ? 'rgba(148,163,184,0.05)' : 'rgba(255,255,255,0.82)',
              color: option.disabled ? 'var(--t-text-faint)' : 'var(--t-text)',
              textAlign: 'left',
              cursor: option.disabled ? 'default' : 'pointer',
            }}
          >
            <div style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              width: '100%',
              gap: 12,
            }}>
              <span style={{
                fontSize: 13,
                fontWeight: 700,
                letterSpacing: '-0.01em',
              }}>
                {option.label}
              </span>
              {option.disabled ? (
                <span style={{
                  fontSize: 10,
                  fontWeight: 700,
                  color: 'var(--t-text-faint)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.04em',
                }}>
                  In use
                </span>
              ) : null}
            </div>
            <span style={{
              fontSize: 12,
              color: option.disabled ? 'var(--t-text-faint)' : 'var(--t-text-muted)',
              lineHeight: 1.5,
            }}>
              {option.description}
            </span>
          </button>
        ))}
      </div>

      {onCancel ? (
        <div style={{
          paddingTop: 0,
          paddingRight: 16,
          paddingBottom: 16,
          paddingLeft: 16,
          flexShrink: 0,
        }}>
          <button
            type="button"
            onClick={onCancel}
            style={{
              width: '100%',
              height: 36,
              borderRadius: 12,
              borderWidth: 1,
              borderStyle: 'solid',
              borderColor: 'rgba(148,163,184,0.16)',
              backgroundColor: 'rgba(255,255,255,0.82)',
              color: 'var(--t-text-secondary)',
              fontSize: 12,
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Keep current content
          </button>
        </div>
      ) : null}
    </div>
  );
}
