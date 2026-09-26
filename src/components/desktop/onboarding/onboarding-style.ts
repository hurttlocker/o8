import type { CSSProperties } from 'react';
export const onboardingButtonStyle: CSSProperties = {
  minHeight: 44, paddingTop: 10, paddingBottom: 10, paddingLeft: 16, paddingRight: 16,
  borderRadius: 10, border: '1px solid var(--t-divider-strong)', background: 'var(--t-chat-surface-bg)',
  color: 'var(--t-text)', fontFamily: 'var(--font-sans-system)', fontSize: 13, fontWeight: 300, cursor: 'pointer',
};
export const onboardingQuietButtonStyle: CSSProperties = {
  ...onboardingButtonStyle, minHeight: 44, border: 0, background: 'transparent',
  paddingLeft: 12, paddingRight: 12, fontWeight: 300, color: 'var(--t-text-secondary)',
};
