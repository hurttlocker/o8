'use client';

import { useRef, type KeyboardEvent } from 'react';
import type { PrReviewAction } from './types';

const choices: Array<{ value: PrReviewAction; label: string }> = [{ value: 'review-comment', label: 'Comment' }, { value: 'approve', label: 'Approve' }, { value: 'request-changes', label: 'Request changes' }];
export function PrReviewChoices({ value, onChange, disabled }: { value: PrReviewAction; onChange: (value: PrReviewAction) => void; disabled?: boolean }) {
  const group = useRef<HTMLDivElement>(null);
  const onKeyDown = (event: KeyboardEvent) => {
    if (disabled || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const index = choices.findIndex((choice) => choice.value === value);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? choices.length - 1 : (index + (event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length;
    onChange(choices[next].value); group.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus();
  };
  return <div ref={group} role="radiogroup" aria-label="Review outcome" onKeyDown={onKeyDown} style={{ display: 'flex', flexWrap: 'wrap', gap: 4, paddingTop: 8, paddingRight: 12, paddingBottom: 0, paddingLeft: 14 }}>
    {choices.map((choice) => <button key={choice.value} type="button" role="radio" aria-checked={value === choice.value} tabIndex={value === choice.value ? 0 : -1} disabled={disabled} onClick={() => onChange(choice.value)} style={{ minHeight: 28, paddingTop: 0, paddingRight: 9, paddingBottom: 0, paddingLeft: 9, borderRadius: 8, border: '1px solid ' + (value === choice.value ? 'var(--t-accent-border)' : 'var(--t-border)'), color: value === choice.value ? 'var(--t-text)' : 'var(--t-text-muted)', background: value === choice.value ? 'var(--t-accent-soft)' : 'transparent', fontFamily: 'inherit', fontSize: 11, cursor: disabled ? 'default' : 'pointer' }}>{choice.label}</button>)}
  </div>;
}
