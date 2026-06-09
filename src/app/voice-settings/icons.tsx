'use client';

/**
 * Voice-settings icons — Iconoir, per the hurttlocker icon vocabulary. Iconoir's
 * React components render correctly inside the Tauri webview (unlike Lucide /
 * Phosphor / Tabler React components), so we import them directly. Keys mirror
 * the old semantic names so callers change minimally.
 */
import {
  Settings, Book, DataTransferBoth, EditPencil, ClockRotateRight, Reports,
  Microphone, SoundHigh, Eye, WarningTriangle, User, Crown, Computer, Sparks, Check,
  Copy, Timer, Calendar, Flash, Type, Xmark, Droplet,
} from 'iconoir-react';
import type { ComponentType } from 'react';

export type IconComp = ComponentType<{ width?: number | string; height?: number | string; color?: string; strokeWidth?: number }>;

export const ICONS = {
  gear: Settings,
  bookOpen: Book,
  arrowsLeftRight: DataTransferBoth,
  notePencil: EditPencil,
  clock: ClockRotateRight,
  chartBar: Reports,
  microphone: Microphone,
  speakerHigh: SoundHigh,
  eye: Eye,
  warning: WarningTriangle,
  user: User,
  crown: Crown,
  robot: Computer,
  sparkle: Sparks,
  check: Check,
  copy: Copy,
  close: Xmark,
  timer: Timer,
  calendar: Calendar,
  flash: Flash,
  type: Type,
  words: Type,
  droplet: Droplet,
} as const satisfies Record<string, IconComp>;

export function Icon({ icon: C, size = 16, color, strokeWidth = 1.7 }: {
  icon: IconComp; size?: number; color?: string; strokeWidth?: number;
}) {
  return <C width={size} height={size} color={color ?? 'currentColor'} strokeWidth={strokeWidth} />;
}
