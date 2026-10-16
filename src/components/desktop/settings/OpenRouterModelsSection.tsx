'use client';

import { useState } from 'react';
import { AcpModelPicker } from '../thoughts/AcpModelPicker';
import { useModelVisibility } from '../thoughts/composer-selector/model-visibility';
import { RamsButton } from './shared';

export function OpenRouterModelsSection() {
  const [open, setOpen] = useState(false);
  const { hidden, restore, error } = useModelVisibility();
  return <details open={open} onToggle={event => setOpen(event.currentTarget.open)} style={{ marginBottom: 32, borderBottom: '1px solid var(--t-border)', paddingBottom: 16 }}>
    <summary style={{ cursor: 'pointer', fontSize: 13, color: 'var(--t-text)', fontWeight: 300 }}>Choose visible OpenRouter models{hidden.length ? ` · ${hidden.length} hidden` : ''}</summary>
    <p style={{ fontSize: 12, color: 'var(--t-text-muted)', lineHeight: 1.5 }}>Hide models you do not use across the composer and worker pickers on this device. Your current selection stays visible. Restore models here at any time.</p>
    {hidden.length ? <RamsButton variant="ghost" onClick={restore}>Show all hidden models</RamsButton> : null}
    {error ? <p role="alert">{error}</p> : null}
    {open ? <AcpModelPicker backend="openrouter-visibility" value={null} onSelect={() => {}} catalogueUrl="/api/runtime/claude-code-models" defaultProvider="openrouter" embedded manageVisibility allowEffortVariants={false} /> : null}
  </details>;
}
