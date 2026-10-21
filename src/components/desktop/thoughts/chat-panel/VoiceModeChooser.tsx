'use client';

import type { RefObject } from 'react';
import { isTauri } from '@/lib/tauri/bridge';
import { OPEN_SETTINGS_TAB_EVENT } from '@/lib/desktop/events';
import { RamsButton } from '../../settings/RamsButton';
import { ComposerPopover } from './ComposerPopover';

export function VoiceModeChooser({ id, anchorRef, open, close, checking, error, turnAvailable, managedAvailable, personalAvailable, localPreview, startTurn, startLive }: {
  id: string;
  anchorRef: RefObject<HTMLButtonElement | null>;
  open: boolean;
  close: () => void;
  checking: boolean;
  error: string;
  turnAvailable: boolean;
  managedAvailable: boolean;
  personalAvailable: boolean;
  localPreview: boolean;
  startTurn: () => void;
  startLive: (source: 'byok' | 'managed') => void;
}) {
  const section = { display: 'flex', flexDirection: 'column' as const, alignItems: 'flex-start' as const, gap: 8 };
  return <ComposerPopover anchorRef={anchorRef} open={open} onClose={close}>
    <div role="dialog" aria-label="Voice for this chat" id={id} style={{ width: 300, maxWidth: 'calc(100vw - 24px)', display: 'flex', flexDirection: 'column', gap: 16, paddingTop: 16, paddingRight: 16, paddingBottom: 16, paddingLeft: 16, borderRadius: 12, background: 'var(--t-panel)', border: '1px solid var(--t-border)', boxShadow: 'var(--t-panel-shadow)', color: 'var(--t-text)', fontSize: 12, fontWeight: 300, lineHeight: 1.4 }}>
      <div style={{ fontSize: 13.5 }}>Voice for this chat</div>
      <div style={section}>
        <span>Turn-by-turn · Edge voice</span>
        <span style={{ color: 'var(--t-text-muted)', fontSize: 11 }}>{isTauri() ? 'Native dictation needs no separate voice API key on macOS.' : 'Browser dictation may require a voice key or an eligible plan.'} Finish recording to send to this chat. Edge reads its confirmed answer, with system speech as a fallback when available. Your selected agent still needs its own connection.</span>
        <RamsButton disabled={!turnAvailable} onClick={startTurn}>Start turn-by-turn</RamsButton>
        {!turnAvailable ? <span style={{ color: 'var(--t-text-muted)', fontSize: 11 }}>Dictation is unavailable in this composer.</span> : null}
      </div>
      <div style={section}>
        <span>Live · personal OpenAI key</span>
        <span style={{ color: 'var(--t-text-muted)', fontSize: 11 }}>Talk continuously while this chat’s selected agent handles tasks. Voice usage is billed to your OpenAI key.</span>
        <RamsButton variant="ghost" disabled={checking || !personalAvailable} onClick={() => startLive('byok')}>Start Live with my key</RamsButton>
        {!personalAvailable && !checking ? <RamsButton variant="ghost" onClick={() => { close(); window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_TAB_EVENT, { detail: { tab: 'api-keys', section: 'OpenAI key' } })); }}>Open OpenAI key settings</RamsButton> : null}
      </div>
      {managedAvailable ? <div style={section}>
        <span>{localPreview ? 'Local microphone preview' : 'Managed voice · pilot'}</span>
        <span style={{ color: 'var(--t-text-muted)', fontSize: 11 }}>{localPreview ? 'Microphone preview only; no transcription or provider connection.' : 'Available only for this account’s approved pilot.'}</span>
        <RamsButton variant="ghost" disabled={checking} onClick={() => startLive('managed')}>{localPreview ? 'Start microphone preview' : 'Start managed voice'}</RamsButton>
      </div> : null}
      {checking || error ? <div role="status" style={{ color: 'var(--t-text-muted)', fontSize: 11 }}>{checking ? 'Checking Live voice availability…' : error}</div> : null}
      <RamsButton variant="ghost" onClick={close}>Close</RamsButton>
    </div>
  </ComposerPopover>;
}
