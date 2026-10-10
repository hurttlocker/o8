import type { ComponentProps } from 'react';
import type { ClerkProvider } from '@clerk/nextjs';

/** Clerk keeps its own enabled auth methods; our palette applies to its portals. */
export const clerkAppearance = {
  variables: {
    colorPrimary: 'var(--t-accent)',
    colorForeground: 'var(--t-text)',
    colorMutedForeground: 'var(--t-text-muted)',
    colorBackground: 'var(--t-panel-solid)',
    colorInput: 'var(--t-input-bg)',
    colorInputForeground: 'var(--t-text)',
    fontFamily: 'var(--font-sans-system)',
    borderRadius: '14px',
  },
  elements: {
    card: { background: 'var(--t-bg)', backdropFilter: 'blur(18px) saturate(1.15)', border: '1px solid var(--t-border)', boxShadow: '0 18px 48px rgba(15, 23, 42, 0.24)' },
    headerTitle: { fontWeight: 400 },
    socialButtonsBlockButton: { border: '1px solid var(--t-border)', background: 'var(--t-input-bg)' },
    formButtonPrimary: { fontWeight: 400 },
    footer: { background: 'var(--t-input-bg)' },
  },
} satisfies NonNullable<ComponentProps<typeof ClerkProvider>['appearance']>;
