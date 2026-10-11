import { ProviderMarkGlyph } from '../thoughts/composer-selector/provider-marks';
import type { UsageProviderKind } from '@/lib/usage/history-types';

/** The same house marks used by the composer, with one optical slot. */
export function UsageProviderMark({ provider, size = 15 }: { provider: UsageProviderKind; size?: number }) {
  return <span aria-hidden="true" data-usage-provider-mark={provider} style={{ width: size, height: size, flexShrink: 0,
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
    {provider === 'opencode' ? <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round"><path d="M8 6 3 12l5 6M16 6l5 6-5 6M14 5l-4 14" /></svg>
      : <ProviderMarkGlyph mark={provider === 'codex' ? 'openai' : provider === 'claude' ? 'anthropic'
        : provider === 'grok' ? 'x' : provider === 'antigravity' ? 'gemini' : 'terminal'} size={size} />}
  </span>;
}

export function UsageModelMark({ model }: { model: string }) {
  const name = model.toLowerCase().split('/').at(-1) ?? model;
  const mark = name.startsWith('claude') ? 'anthropic' : name.startsWith('gpt') || name.startsWith('o3') || name.startsWith('o4') ? 'openai'
    : name.startsWith('gemini') ? 'gemini' : name.startsWith('grok') ? 'x' : name.startsWith('deepseek') ? 'deepseek' : null;
  return <span aria-hidden="true" style={{ width: 14, height: 14, display: 'inline-flex', alignItems: 'center', flexShrink: 0,
    color: 'var(--t-text-secondary)' }}>{mark ? <ProviderMarkGlyph mark={mark} size={14} /> : null}</span>;
}
