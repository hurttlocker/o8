'use client';

import { useState } from 'react';

interface TabCleanupButtonProps {
  finishedTabCount: number;
  onCleanup: () => void;
}

export function TabCleanupButton({
  finishedTabCount,
  onCleanup,
}: TabCleanupButtonProps) {
  const [hovered, setHovered] = useState(false);
  if (finishedTabCount < 1) return null;

  const label = `Clean up ${finishedTabCount} finished ${finishedTabCount === 1 ? 'tab' : 'tabs'}`;

  return (
    <button
      type="button"
      data-no-drag
      onClick={onCleanup}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      aria-label={label}
      title={label}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 5,
        minWidth: 44,
        height: 28,
        paddingLeft: 8,
        paddingRight: 7,
        borderRadius: 7,
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: hovered ? 'var(--t-divider)' : 'var(--t-divider-subtle)',
        background: hovered ? 'var(--t-hover)' : 'var(--t-input-bg)',
        color: hovered ? 'var(--t-text)' : 'var(--t-text-secondary)',
        cursor: 'pointer',
        fontFamily: 'var(--font-sans-system)',
        fontSize: 11,
        fontWeight: 500,
        lineHeight: 1,
        paddingTop: 0,
        paddingBottom: 0,
        flexShrink: 0,
        transition: 'background 120ms ease, border-color 120ms ease, color 120ms ease',
      }}
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width={14}
        height={14}
        fill="currentColor"
        viewBox="0 0 256 256"
        aria-hidden="true"
        style={{ display: 'block', flexShrink: 0 }}
      >
        <path d="M235.5,216.81c-22.56-11-35.5-34.58-35.5-64.8V134.73a15.94,15.94,0,0,0-10.09-14.87L165,110a8,8,0,0,1-4.48-10.34l21.32-53a28,28,0,0,0-16.1-37,28.14,28.14,0,0,0-35.82,16,.61.61,0,0,0,0,.12L108.9,79a8,8,0,0,1-10.37,4.49L73.11,73.14A15.89,15.89,0,0,0,55.74,76.8C34.68,98.45,24,123.75,24,152a111.45,111.45,0,0,0,31.18,77.53A8,8,0,0,0,61,232H232a8,8,0,0,0,3.5-15.19ZM67.14,88l25.41,10.3a24,24,0,0,0,31.23-13.45l21-53c2.56-6.11,9.47-9.27,15.43-7a12,12,0,0,1,6.88,15.92L145.69,93.76a24,24,0,0,0,13.43,31.14L184,134.73V152c0,.33,0,.66,0,1L55.77,101.71A108.84,108.84,0,0,1,67.14,88Zm48,128a87.53,87.53,0,0,1-24.34-42,8,8,0,0,0-15.49,4,105.16,105.16,0,0,0,18.36,38H64.44A95.54,95.54,0,0,1,40,152a85.9,85.9,0,0,1,7.73-36.29l137.8,55.12c3,18,10.56,33.48,21.89,45.16Z" />
      </svg>
      <span
        aria-hidden="true"
        style={{
          minWidth: 14,
          height: 14,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: 7,
          background: 'var(--t-panel)',
          color: 'var(--t-text)',
          paddingLeft: 4,
          paddingRight: 4,
          fontSize: 10,
          fontWeight: 600,
          lineHeight: 1,
        }}
      >
        {finishedTabCount}
      </span>
    </button>
  );
}
