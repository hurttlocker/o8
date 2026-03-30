import type { CSSProperties } from 'react';
import type { MobileOrchestratorStatus } from './types';

type Tone = 'blue' | 'red' | 'slate' | 'green' | 'orange';
type MobileConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | undefined;

const TONE_MAP: Record<Tone, {
  text: string;
  top: string;
  bottom: string;
  highlight: string;
  shadow: string;
  insetShadow: string;
}> = {
  blue: {
    text: '#1d4ed8',
    top: 'rgba(251, 253, 255, 0.96)',
    bottom: 'rgba(226, 236, 255, 0.96)',
    highlight: 'rgba(255, 255, 255, 0.98)',
    shadow: 'rgba(37, 99, 235, 0.18)',
    insetShadow: 'rgba(148, 163, 184, 0.14)',
  },
  red: {
    text: '#b91c1c',
    top: 'rgba(255, 252, 252, 0.96)',
    bottom: 'rgba(255, 231, 231, 0.96)',
    highlight: 'rgba(255, 255, 255, 0.98)',
    shadow: 'rgba(239, 68, 68, 0.16)',
    insetShadow: 'rgba(239, 68, 68, 0.12)',
  },
  slate: {
    text: '#334155',
    top: 'rgba(250, 252, 255, 0.96)',
    bottom: 'rgba(235, 241, 248, 0.96)',
    highlight: 'rgba(255, 255, 255, 0.98)',
    shadow: 'rgba(148, 163, 184, 0.18)',
    insetShadow: 'rgba(148, 163, 184, 0.12)',
  },
  green: {
    text: '#15803d',
    top: 'rgba(250, 255, 252, 0.96)',
    bottom: 'rgba(228, 247, 235, 0.96)',
    highlight: 'rgba(255, 255, 255, 0.98)',
    shadow: 'rgba(34, 197, 94, 0.16)',
    insetShadow: 'rgba(34, 197, 94, 0.12)',
  },
  orange: {
    text: '#c2410c',
    top: 'rgba(255, 253, 250, 0.96)',
    bottom: 'rgba(255, 239, 224, 0.96)',
    highlight: 'rgba(255, 255, 255, 0.98)',
    shadow: 'rgba(249, 115, 22, 0.16)',
    insetShadow: 'rgba(249, 115, 22, 0.12)',
  },
};

export const MOBILE_SYSTEM_FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", system-ui, sans-serif';
export const MOBILE_MONO_FONT = '"SF Mono", "SFMono-Regular", ui-monospace, Menlo, monospace';

export const mobileShellStyle: CSSProperties = {
  minHeight: '100vh',
  backgroundColor: '#ecf2f9',
  backgroundImage: [
    'radial-gradient(circle at top left, rgba(37, 99, 235, 0.16) 0%, rgba(37, 99, 235, 0) 32%)',
    'radial-gradient(circle at top right, rgba(239, 68, 68, 0.1) 0%, rgba(239, 68, 68, 0) 28%)',
    'linear-gradient(180deg, #f8fbff 0%, #eef3f9 48%, #e7edf6 100%)',
  ].join(', '),
  color: '#0f172a',
  fontFamily: MOBILE_SYSTEM_FONT,
  letterSpacing: '-0.01em',
};

export function neomorphicSurfaceStyle(
  tone: Tone = 'slate',
  extra?: CSSProperties,
): CSSProperties {
  const palette = TONE_MAP[tone];
  return {
    backgroundColor: palette.bottom,
    backgroundImage: `linear-gradient(180deg, ${palette.top} 0%, ${palette.bottom} 100%)`,
    borderRadius: 20,
    boxShadow: [
      `inset 1px 1px 0 ${palette.highlight}`,
      `inset -1px -1px 0 ${palette.insetShadow}`,
      `12px 12px 26px ${palette.shadow}`,
      '-12px -12px 26px rgba(255, 255, 255, 0.9)',
      '0 10px 24px rgba(15, 23, 42, 0.06)',
    ].join(', '),
    ...extra,
  };
}

export function neomorphicButtonStyle(
  tone: Tone = 'slate',
  active = false,
  extra?: CSSProperties,
): CSSProperties {
  const palette = TONE_MAP[tone];
  return {
    minHeight: 44,
    borderRadius: 18,
    borderWidth: 0,
    color: palette.text,
    backgroundColor: active ? palette.bottom : palette.top,
    backgroundImage: `linear-gradient(180deg, ${palette.top} 0%, ${palette.bottom} 100%)`,
    boxShadow: active
      ? [
          `inset 2px 2px 5px ${palette.insetShadow}`,
          'inset -2px -2px 5px rgba(255, 255, 255, 0.88)',
          `0 8px 18px ${palette.shadow}`,
        ].join(', ')
      : [
          `inset 1px 1px 0 ${palette.highlight}`,
          `inset -1px -1px 0 ${palette.insetShadow}`,
          `10px 10px 20px ${palette.shadow}`,
          '-10px -10px 20px rgba(255, 255, 255, 0.9)',
        ].join(', '),
    ...extra,
  };
}

export function connectionTone(state: MobileConnectionState): Tone {
  if (state === 'connected') return 'green';
  if (state === 'connecting' || state === 'reconnecting') return 'orange';
  return 'red';
}

export function connectionColor(state: MobileConnectionState): string {
  if (state === 'connected') return '#16a34a';
  if (state === 'connecting' || state === 'reconnecting') return '#f59e0b';
  return '#ef4444';
}

export function connectionLabel(state: MobileConnectionState): string {
  if (state === 'connected') return 'Desktop linked';
  if (state === 'connecting') return 'Connecting';
  if (state === 'reconnecting') return 'Reconnecting';
  return 'Offline';
}

export function orchestratorTone(status: MobileOrchestratorStatus | undefined): Tone {
  if (status === 'ready') return 'green';
  if (status === 'busy' || status === 'connecting') return 'blue';
  if (status === 'dead') return 'orange';
  if (status === 'error') return 'red';
  return 'slate';
}

export function orchestratorColor(status: MobileOrchestratorStatus | undefined): string {
  if (status === 'ready') return '#16a34a';
  if (status === 'busy' || status === 'connecting') return '#2563eb';
  if (status === 'dead') return '#f59e0b';
  if (status === 'error') return '#ef4444';
  return '#64748b';
}

export function orchestratorLabel(status: MobileOrchestratorStatus | undefined): string {
  if (status === 'busy') return 'Routing';
  if (status === 'ready') return 'Ready';
  if (status === 'connecting') return 'Linking';
  if (status === 'dead') return 'Unavailable';
  if (status === 'error') return 'Attention';
  return 'Idle';
}

export function secondaryTextStyle(extra?: CSSProperties): CSSProperties {
  return {
    color: '#64748b',
    fontFamily: MOBILE_SYSTEM_FONT,
    letterSpacing: '-0.01em',
    ...extra,
  };
}
