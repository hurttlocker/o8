import type { CSSProperties } from 'react';

const SOLID_TOKENS: CSSProperties = {
  ['--o8-scratch-surface' as string]: 'var(--t-chat-surface-bg, #f4f2ed)',
  ['--o8-scratch-card' as string]: 'var(--t-chat-surface-card-bg, rgba(15, 23, 42, 0.04))',
  ['--o8-scratch-input' as string]: 'var(--t-chat-surface-input-bg, #f4f2ed)',
  ['--o8-scratch-border' as string]: 'var(--t-chat-surface-border, rgba(15, 23, 42, 0.1))',
  ['--o8-scratch-input-border' as string]: 'var(--t-chat-surface-input-border, rgba(15, 23, 42, 0.12))',
  ['--o8-scratch-text' as string]: 'var(--t-chat-surface-text, #0f172a)',
  ['--o8-scratch-muted' as string]: 'var(--t-chat-surface-text-secondary, #64748b)',
  ['--o8-scratch-faint' as string]: 'var(--t-chat-surface-text-muted, #94a3b8)',
  ['--o8-scratch-action' as string]: 'var(--t-chat-surface-text-secondary, #475569)',
  ['--t-panel' as string]: 'var(--o8-scratch-surface)',
  ['--t-panel-solid' as string]: 'var(--o8-scratch-surface)',
  ['--t-bg-subtle' as string]: 'var(--o8-scratch-card)',
  ['--t-input-bg' as string]: 'var(--o8-scratch-input)',
  ['--t-input-border' as string]: 'var(--o8-scratch-input-border)',
  ['--t-panel-border' as string]: 'var(--o8-scratch-border)',
  ['--t-divider-subtle' as string]: 'var(--o8-scratch-border)',
  ['--t-text' as string]: 'var(--o8-scratch-text)',
  ['--t-text-muted' as string]: 'var(--o8-scratch-muted)',
  ['--t-text-faint' as string]: 'var(--o8-scratch-faint)',
};

/** Scratch content follows the floating material without rebinding shared tokens. */
export function scratchSurfaceTokens(glass: boolean): CSSProperties {
  return glass ? {
    '--o8-scratch-surface': 'transparent',
    '--o8-scratch-card': 'var(--t-bg-card)',
    '--o8-scratch-input': 'var(--t-input-bg)',
    '--o8-scratch-border': 'var(--t-divider-subtle)',
    '--o8-scratch-input-border': 'var(--t-input-border)',
    '--o8-scratch-text': 'var(--t-text)',
    '--o8-scratch-muted': 'var(--t-text-secondary)',
    '--o8-scratch-faint': 'var(--t-text-muted)',
    '--o8-scratch-action': 'var(--t-text-secondary)',
  } as CSSProperties : SOLID_TOKENS;
}
