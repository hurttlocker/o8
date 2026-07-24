'use client';

import { useMemo, useState } from 'react';
import {
  IconCaretDown,
  MOBILE_TOUCH_TARGET,
  MobilePalette,
  mobileCardStyle,
} from './mobile-approvals-shared';
import { getMobileRepoLabel, type MobileRepoOption } from './mobile-chat-repos';

export function MobileRepoPicker({
  palette,
  repoOptions,
  selectedRepoPath,
  onSelectRepoPath,
  allowCurrentProject = true,
  alwaysVisible = false,
}: {
  palette: MobilePalette;
  repoOptions: MobileRepoOption[];
  selectedRepoPath: string | null;
  onSelectRepoPath: (repoPath: string | null) => void;
  allowCurrentProject?: boolean;
  alwaysVisible?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const selectedLabel = useMemo(
    () => selectedRepoPath
      ? getMobileRepoLabel(selectedRepoPath, repoOptions)
      : allowCurrentProject
        ? 'Current project'
        : 'Choose repository',
    [allowCurrentProject, repoOptions, selectedRepoPath],
  );
  const options = useMemo(
    () => [
      ...(allowCurrentProject ? [{ label: 'Current project', repoPath: null }] : []),
      ...repoOptions.map((repo) => ({ label: repo.name, repoPath: repo.localPath })),
    ],
    [allowCurrentProject, repoOptions],
  );

  if (!alwaysVisible && repoOptions.length <= 1) return null;
  if (options.length === 0) return null;

  return (
    <div style={{ position: 'relative', padding: '8px 4px 12px' }}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-label={`Repository: ${selectedLabel}`}
        style={mobileCardStyle(palette, {
          minHeight: MOBILE_TOUCH_TARGET,
          maxWidth: '100%',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 8,
          padding: '9px 12px',
          borderRadius: 16,
          background: palette.panelElevated,
          color: palette.rootText,
          cursor: 'pointer',
        })}
      >
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: 999,
            backgroundColor: palette.warning,
            flexShrink: 0,
          }}
        />
        <span style={{ fontSize: 12, fontWeight: 700, color: palette.rootText, whiteSpace: 'nowrap' }}>
          {selectedLabel}
        </span>
        <IconCaretDown
          fill={palette.iconFill}
          size={14}
          style={{ transform: open ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.2s ease' }}
        />
      </button>

      {open ? (
        <div
          style={mobileCardStyle(palette, {
            position: 'absolute',
            top: 'calc(100% + 8px)',
            left: 4,
            minWidth: 220,
            maxWidth: 'min(280px, calc(100vw - 56px))',
            padding: 6,
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
            zIndex: 10,
            background: palette.panelElevated,
          })}
        >
          {options.map((option) => {
            const isActive = option.repoPath === selectedRepoPath;

            return (
              <button
                key={option.repoPath ?? 'current-project'}
                type="button"
                onClick={() => {
                  onSelectRepoPath(option.repoPath);
                  setOpen(false);
                }}
                style={{
                  minHeight: MOBILE_TOUCH_TARGET,
                  borderRadius: 14,
                  border: `1px solid ${isActive ? palette.accentBorder : 'transparent'}`,
                  background: isActive ? palette.accentSoft : 'transparent',
                  color: palette.rootText,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '0 12px',
                  textAlign: 'left',
                }}
              >
                <span
                  style={{
                    width: 10,
                    height: 10,
                    borderRadius: 999,
                    border: `1px solid ${isActive ? palette.accent : palette.cardBorder}`,
                    backgroundColor: isActive ? palette.accent : 'transparent',
                    flexShrink: 0,
                  }}
                />
                <span style={{ fontSize: 12, fontWeight: isActive ? 700 : 600, lineHeight: 1.4 }}>
                  {option.label}
                </span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
