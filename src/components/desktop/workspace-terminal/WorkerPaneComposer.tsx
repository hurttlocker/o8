'use client';

import { useLayoutEffect, useState, type RefObject } from 'react';
import { ComposerDictationContext, useComposerDictation } from '@/components/desktop/dictation/ComposerDictation';
import { useDictationHostOptional } from '@/components/desktop/dictation/DictationHost';
import { AttachFilesButton } from '@/components/desktop/thoughts/AttachFilesButton';
import { MicButton } from '@/components/desktop/thoughts/MicButton';
import { WORKER_CONTROL_SIZE, WORKER_ICON_BUTTON } from './WorkerPaneHeader';
import type { WorkerAttention } from './worker-pane-chrome';

export function WorkerPaneComposer({ textareaRef, scopeKey, active, compact, input, onInputChange, onSend,
  disabled = false, canSend, attention, onResume, onStop, onOpenReview, busy, repoPath,
}: {
  textareaRef: RefObject<HTMLTextAreaElement | null>; scopeKey: string; active: boolean; compact: boolean;
  input: string; onInputChange: (input: string) => void; onSend: () => void; disabled?: boolean; canSend: boolean;
  attention?: WorkerAttention | null; onResume?: () => void; onStop?: () => void; onOpenReview?: () => void; busy?: boolean;
  repoPath?: string | null;
}) {
  const [toolsOpen, setToolsOpen] = useState(false);
  const host = useDictationHostOptional();
  const dictationId = useComposerDictation({ nodeRef: textareaRef, scopeKey, active: active && !disabled,
    enabled: !disabled, onText: text => onInputChange(`${input}${input && !/\s$/.test(input) ? ' ' : ''}${text}`) });
  useLayoutEffect(() => {
    const node = textareaRef.current;
    if (!node) return;
    const resize = () => {
      node.style.height = '24px';
      node.style.height = `${Math.min(124, Math.max(24, node.scrollHeight))}px`;
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(node);
    return () => observer.disconnect();
  }, [compact, input, textareaRef]);

  const mic = host ? <MicButton buttonStyle={WORKER_CONTROL_SIZE} /> : <button type="button" disabled aria-label="Dictate message"
    title="Dictation is available in the desktop app" style={{ ...WORKER_ICON_BUTTON, opacity: 0.5 }}>
    <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
      <rect x="9" y="2" width="6" height="12" rx="3" /><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3" />
    </svg>
  </button>;
  const attach = <AttachFilesButton buttonStyle={WORKER_CONTROL_SIZE} repoPath={repoPath} allowDiskUpload={false}
    onFileReferenceSelect={path => {
      onInputChange(`${input}${input && !/\s$/.test(input) ? ' ' : ''}@${/\s/.test(path) ? `"${path}"` : path} `);
      textareaRef.current?.focus();
    }} />;

  return <ComposerDictationContext.Provider value={dictationId}>
    <div data-o8-composer-root data-worker-composer data-compact={compact} style={{
      marginTop: 4, marginRight: compact ? 6 : 8, marginBottom: compact ? 6 : 8, marginLeft: compact ? 6 : 8,
      borderRadius: 12, background: 'var(--t-input-bg)', border: '1px solid var(--t-border)',
      boxShadow: 'var(--t-panel-shadow)', fontFamily: 'var(--font-sans-system)',
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 4, paddingTop: 3, paddingRight: 3, paddingBottom: 3, paddingLeft: 3 }}>
        <div inert={disabled} style={{ display: 'flex', alignItems: 'center', height: 24, flexShrink: 0 }}>
          {compact ? <button type="button" aria-label="Add to message" aria-expanded={toolsOpen}
            aria-controls={`${dictationId}-tools`} onClick={() => setToolsOpen(open => !open)}
            style={{ ...WORKER_ICON_BUTTON, background: toolsOpen ? 'var(--t-hover)' : 'transparent' }}>
            <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
          </button> : <>{attach}{mic}</>}
        </div>
        <textarea ref={textareaRef} value={input} rows={1} disabled={disabled}
          aria-label="Message this worker" placeholder="Message this worker"
          onChange={event => onInputChange(event.currentTarget.value)}
          onKeyDown={event => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              if (canSend && !disabled) onSend();
            }
          }}
          style={{ flex: 1, minWidth: 0, height: 24, maxHeight: 124, boxSizing: 'border-box',
            paddingTop: 2, paddingRight: 0, paddingBottom: 2, paddingLeft: 0,
            resize: 'none', overflowY: 'auto', scrollbarWidth: 'none', border: 0, background: 'transparent',
            color: 'var(--t-text)', fontFamily: 'inherit', fontSize: 13, fontWeight: 300, lineHeight: '20px', letterSpacing: '-0.1px' }} />
        <button type="button" data-testid="composer-send-control" aria-label="Send message" disabled={!canSend || disabled}
          onClick={onSend} style={{ ...WORKER_ICON_BUTTON, borderRadius: '50%',
            background: canSend && !disabled ? 'var(--t-accent)' : 'var(--t-hover)',
            color: canSend && !disabled ? 'var(--t-accent-contrast, var(--t-chat-user-text))' : 'var(--t-text-faint)',
            cursor: canSend && !disabled ? 'pointer' : 'default' }}>
          <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 19V5m-6 6 6-6 6 6" /></svg>
        </button>
      </div>
      {compact && toolsOpen ? <div id={`${dictationId}-tools`} inert={disabled} style={{
        display: 'flex', alignItems: 'center', gap: 6, paddingLeft: 6, paddingRight: 6, paddingBottom: 4,
        color: 'var(--t-text-muted)', fontSize: 12, fontWeight: 300,
      }}>{attach}<span>Attach</span>{mic}<span>Dictate</span></div> : null}
      {attention ? <div data-worker-state-row style={{ display: 'flex', alignItems: 'center', gap: 4,
        paddingLeft: 6, paddingRight: 6, paddingBottom: 5, minWidth: 0, fontSize: 11, fontWeight: 300 }}>
        <span title={attention.label} style={{ height: 20, lineHeight: '20px', borderRadius: 8,
          paddingLeft: 6, paddingRight: 6, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          color: `var(--t-${attention.tone})`, background: `var(--t-${attention.tone}-soft)` }}>{attention.label}</span>
        {attention.actions.map(label => {
          const action = label === 'Resume' ? onResume : label === 'Stop' ? onStop : onOpenReview;
          if (!action) return null;
          return <button type="button" key={label} data-worker-state-action={label} disabled={busy} onClick={action}
            title={label}
            style={{ height: 20, border: 0, borderRadius: 8, paddingTop: 0, paddingBottom: 0, paddingLeft: 6, paddingRight: 6,
              flexShrink: 0, background: 'transparent', color: 'var(--t-text-muted)',
              fontFamily: 'inherit', fontSize: 11, fontWeight: 300, cursor: !busy ? 'pointer' : 'default' }}>{label}</button>;
        })}
      </div> : null}
    </div>
  </ComposerDictationContext.Provider>;
}
