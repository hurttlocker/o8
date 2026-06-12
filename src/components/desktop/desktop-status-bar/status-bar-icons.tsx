'use client';

import type { CSSProperties, ReactNode } from 'react';
import { motion } from 'framer-motion';
import { FolderPlus, MobileDevMode } from 'iconoir-react';

// Bespoke per-icon micro-motion. Variants propagate down from ChromeButton's
// motion.button (which declares whileHover="hover" / whileTap="tap"), so any
// motion children with matching variant keys play their signature gesture.
// Pattern lifted from title-bar/icons.tsx (IconPanelLeft / IconSearch).
const ICON_SPRING = { type: 'spring' as const, stiffness: 520, damping: 22, mass: 0.6 };

interface StatusBarIconProps {
  size?: number;
  color?: string;
  style?: CSSProperties;
}

function PhosphorSvg({
  size = 15,
  color = 'currentColor',
  children,
  style,
}: StatusBarIconProps & { children: ReactNode }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 256 256"
      fill={color}
      aria-hidden="true"
      focusable="false"
      style={style}
    >
      {children}
    </svg>
  );
}

export function GearSixIcon({ size = 15, color = 'currentColor', style }: StatusBarIconProps) {
  // Signature motion: the gear ROTATES on hover — the most natural gesture
  // for a gear. 60° feels mechanical without going full spin.
  return (
    <motion.svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 256 256"
      fill={color}
      aria-hidden="true"
      focusable="false"
      style={{ display: 'block', flexShrink: 0, ...style }}
      variants={{
        rest: { rotate: 0 },
        hover: { rotate: 60 },
        tap: { rotate: 78 },
      }}
      transition={ICON_SPRING}
    >
      <path d="M128,76a52,52,0,1,0,52,52A52.06,52.06,0,0,0,128,76Zm0,80a28,28,0,1,1,28-28A28,28,0,0,1,128,156Zm113.86-49.57A12,12,0,0,0,236,98.34L208.21,82.49l-.11-31.31a12,12,0,0,0-4.25-9.12,116,116,0,0,0-38-21.41,12,12,0,0,0-9.68.89L128,37.27,99.83,21.53a12,12,0,0,0-9.7-.9,116.06,116.06,0,0,0-38,21.47,12,12,0,0,0-4.24,9.1l-.14,31.34L20,98.35a12,12,0,0,0-5.85,8.11,110.7,110.7,0,0,0,0,43.11A12,12,0,0,0,20,157.66l27.82,15.85.11,31.31a12,12,0,0,0,4.25,9.12,116,116,0,0,0,38,21.41,12,12,0,0,0,9.68-.89L128,218.73l28.14,15.74a12,12,0,0,0,9.7.9,116.06,116.06,0,0,0,38-21.47,12,12,0,0,0,4.24-9.1l.14-31.34,27.81-15.81a12,12,0,0,0,5.85-8.11A110.7,110.7,0,0,0,241.86,106.43Zm-22.63,33.18-26.88,15.28a11.94,11.94,0,0,0-4.55,4.59c-.54,1-1.11,1.93-1.7,2.88a12,12,0,0,0-1.83,6.31L184.13,199a91.83,91.83,0,0,1-21.07,11.87l-27.15-15.19a12,12,0,0,0-5.86-1.53h-.29c-1.14,0-2.3,0-3.44,0a12.08,12.08,0,0,0-6.14,1.51L93,210.82A92.27,92.27,0,0,1,71.88,199l-.11-30.24a12,12,0,0,0-1.83-6.32c-.58-.94-1.16-1.91-1.7-2.88A11.92,11.92,0,0,0,63.7,155L36.8,139.63a86.53,86.53,0,0,1,0-23.24l26.88-15.28a12,12,0,0,0,4.55-4.58c.54-1,1.11-1.94,1.7-2.89a12,12,0,0,0,1.83-6.31L71.87,57A91.83,91.83,0,0,1,92.94,45.17l27.15,15.19a11.92,11.92,0,0,0,6.15,1.52c1.14,0,2.3,0,3.44,0a12.08,12.08,0,0,0,6.14-1.51L163,45.18A92.27,92.27,0,0,1,184.12,57l.11,30.24a12,12,0,0,0,1.83,6.32c.58.94,1.16,1.91,1.7,2.88A11.92,11.92,0,0,0,192.3,101l26.9,15.33A86.53,86.53,0,0,1,219.23,139.61Z" />
    </motion.svg>
  );
}

export function FolderPlusIcon({ size = 15, color = 'currentColor', style }: StatusBarIconProps) {
  // Signature motion: the "+" badge pops up + the folder flap opens a hair.
  // Iconoir markup is opaque to us, so we ride the wrapping motion.div with
  // a small upward translate + tilt of the whole icon — reads as "lift to
  // accept a new repo".
  return (
    <motion.div
      style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', lineHeight: 0, ...style }}
      variants={{
        rest: { rotate: 0, y: 0 },
        hover: { rotate: -8, y: -1.4 },
        tap: { rotate: -3, y: -0.4 },
      }}
      transition={ICON_SPRING}
    >
      <FolderPlus width={size} height={size} color={color} strokeWidth={2} />
    </motion.div>
  );
}

export function DeviceMobileIcon({ size = 15, color = 'currentColor', style }: StatusBarIconProps) {
  // Signature motion: a phone "ring" wobble — small left-right tilt that
  // feels like a notification shake. Single 8° lean (not a back-and-forth)
  // keeps it from being noisy on every cursor pass.
  return (
    <motion.div
      style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', lineHeight: 0, ...style }}
      variants={{
        rest: { rotate: 0 },
        hover: { rotate: 8 },
        tap: { rotate: -4 },
      }}
      transition={ICON_SPRING}
    >
      <MobileDevMode width={size} height={size} color={color} strokeWidth={2} />
    </motion.div>
  );
}

export function CanvasModeIcon({ size = 15, color = 'currentColor', style }: StatusBarIconProps) {
  // Signature motion: a gentle scale pop — entering a mode, not pressing a tool.
  return (
    <motion.div
      style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', lineHeight: 0, ...style }}
      variants={{
        rest: { scale: 1 },
        hover: { scale: 1.12 },
        tap: { scale: 0.94 },
      }}
      transition={ICON_SPRING}
    >
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke={color}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
      >
        <rect x="3" y="3" width="18" height="18" rx="5" />
        <circle cx="9" cy="9" r="0.5" />
        <circle cx="15" cy="9" r="0.5" />
        <circle cx="9" cy="15" r="0.5" />
        <circle cx="15" cy="15" r="0.5" />
      </svg>
    </motion.div>
  );
}

export function WarningCircleIcon({ filled = false, ...props }: StatusBarIconProps & { filled?: boolean }) {
  return (
    <PhosphorSvg {...props}>
      <path d={filled ? 'M128,24A104,104,0,1,0,232,128,104.11,104.11,0,0,0,128,24Zm-8,56a8,8,0,0,1,16,0v56a8,8,0,0,1-16,0Zm8,104a12,12,0,1,1,12-12A12,12,0,0,1,128,184Z' : 'M128,20A108,108,0,1,0,236,128,108.12,108.12,0,0,0,128,20Zm0,192a84,84,0,1,1,84-84A84.09,84.09,0,0,1,128,212Zm-12-80V80a12,12,0,0,1,24,0v52a12,12,0,0,1-24,0Zm28,40a16,16,0,1,1-16-16A16,16,0,0,1,144,172Z'} />
    </PhosphorSvg>
  );
}
