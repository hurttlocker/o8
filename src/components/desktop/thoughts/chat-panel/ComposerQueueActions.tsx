'use client';

import { RamsButton } from '../../settings/RamsButton';
import { COMPOSER_STEER_UNAVAILABLE_REASON } from '@/lib/orchestrator/composer-queue-types';

export function ComposerQueueActions({ canSend, saving, onSend }: { canSend: boolean; saving: boolean; onSend: () => void }) {
  return <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, paddingTop: 8, paddingBottom: 8 }}>
    <RamsButton variant="ghost" disabled={!canSend} busy={saving} onClick={onSend}>{saving ? 'Saving message…' : 'Send next'}</RamsButton>
    <span title={COMPOSER_STEER_UNAVAILABLE_REASON}><RamsButton variant="ghost" disabled>Steer now</RamsButton></span>
    <span style={{ fontSize: 10, fontWeight: 300, color: 'var(--t-text-muted)' }}>Live steering is unavailable for this runtime.</span>
  </div>;
}
