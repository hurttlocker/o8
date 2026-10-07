import type { CSSProperties } from 'react';
export const onboardingButtonStyle: CSSProperties = {
  minHeight: 44, paddingTop: 10, paddingBottom: 10, paddingLeft: 16, paddingRight: 16,
  borderRadius: 10, border: '1px solid var(--t-divider-strong)', background: 'var(--t-onboarding-bg)',
  color: 'var(--t-text)', fontFamily: 'var(--font-sans-system)', fontSize: 13, fontWeight: 300, cursor: 'pointer',
};
export const onboardingQuietButtonStyle: CSSProperties = {
  ...onboardingButtonStyle, minHeight: 44, border: 0, background: 'transparent',
  paddingLeft: 12, paddingRight: 12, fontWeight: 300, color: 'var(--t-text-secondary)',
};
export const onboardingActionRowStyle: CSSProperties = {
  position: 'sticky', bottom: 0, zIndex: 1, display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  flexWrap: 'wrap', gap: 12, paddingTop: 12, paddingBottom: 12,
  background: 'var(--t-onboarding-bg)', borderTop: '1px solid var(--t-divider)',
};
export const onboardingCardStyle: CSSProperties = {
  border: '1px solid var(--t-divider)', borderRadius: 12, padding: 16,
  background: 'var(--t-input-bg)', minWidth: 0,
};
