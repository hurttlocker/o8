'use client';

import { useRef, type CSSProperties, type FormEvent } from 'react';
import { RamsButton } from '@/components/desktop/settings/shared';
import type { LLMMessage } from '@/components/desktop/llm-chat/shared';
import type { PlanStatus } from '@/lib/chatgpt-plan/types';

const columnStyle: CSSProperties = { width: '100%', maxWidth: 720, minWidth: 0 };
const secondaryStyle: CSSProperties = { color: 'var(--t-chat-surface-text-secondary)', lineHeight: 1.5 };
const labelStyle: CSSProperties = { fontSize: 11, fontWeight: 300, color: 'var(--t-chat-surface-text-muted)', lineHeight: 1.35 };
const prompts = [
  { label: 'Make a plan', text: 'Help me turn this idea into a clear plan. Ask me what you need to know first.' },
  { label: 'Compare options', text: 'Help me compare my options. Ask me about the decision and what matters most.' },
  { label: 'Review a draft', text: 'Help me improve a draft. Ask me to paste it and tell you who it is for.' },
];

interface Props {
  signedIn: boolean;
  loading: boolean;
  status: PlanStatus | null;
  modelId: string;
  input: string;
  messages: LLMMessage[];
  stream: string;
  busy: boolean;
  notice: string | null;
  onSignIn: () => void;
  onOpenConnection: () => void;
  onModelChange: (value: string) => void;
  onInputChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
}

export function ChatGPTPlanChatView(props: Props) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const enabled = Boolean(props.status?.planEnabled);
  const empty = props.messages.length === 0 && !props.stream && !props.busy;
  const submit = (event: FormEvent) => { event.preventDefault(); props.onSend(); };

  return <section aria-label="ChatGPT plan chat" style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, minWidth: 0, background: 'var(--t-chat-surface-bg)', color: 'var(--t-chat-surface-text)', fontFamily: 'var(--font-sans-system)', fontSize: 13.5, fontWeight: 300, letterSpacing: '-0.1px' }}>
    <header style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, paddingTop: 12, paddingBottom: 12, paddingLeft: 24, paddingRight: 24, borderBottom: '1px solid var(--t-border)' }}>
      <span style={{ fontSize: 12 }}>ChatGPT plan</span>
      <span role="status" style={{ ...labelStyle, marginRight: 'auto' }}>{props.loading ? 'Checking connection…' : enabled ? 'Connected' : 'Not connected'}</span>
      {enabled ? <label style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, maxWidth: '100%', ...labelStyle }}>Model
        <select aria-label="ChatGPT plan model" disabled={props.busy} value={props.modelId} onChange={(event) => props.onModelChange(event.target.value)} style={{ minWidth: 0, maxWidth: '100%', height: 32, border: '1px solid var(--t-border)', borderRadius: 8, paddingLeft: 8, paddingRight: 8, background: 'var(--t-input-bg)', color: 'var(--t-chat-surface-text)', fontFamily: 'inherit', fontSize: 12, fontWeight: 300 }}>
          {props.status?.models.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
        </select>
      </label> : null}
      {enabled ? <RamsButton variant="ghost" onClick={props.onOpenConnection}>Connection</RamsButton> : null}
    </header>

    <div role="log" aria-label="ChatGPT conversation" style={{ flex: 1, minHeight: 0, overflowY: 'auto', scrollbarWidth: 'none', paddingTop: 24, paddingBottom: 24, paddingLeft: 24, paddingRight: 24 }}>
      {empty ? <div style={{ ...columnStyle, paddingTop: 'clamp(8px, 8vh, 72px)', paddingBottom: 24 }}>
        <h1 style={{ fontSize: 18, fontWeight: 400, letterSpacing: '-0.2px', lineHeight: 1.25, marginTop: 0, marginBottom: 12 }}>{enabled ? 'Think it through with ChatGPT.' : 'Bring your ChatGPT plan into o8.'}</h1>
        <p style={{ ...secondaryStyle, maxWidth: 440, marginTop: 0, marginBottom: 24 }}>{enabled ? 'Plan your next step, compare an approach, or work through a draft.' : 'Connect your account to plan, ask questions, and review text here.'}</p>
        {enabled ? <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {prompts.map((prompt) => <RamsButton key={prompt.label} variant="ghost" onClick={() => { props.onInputChange(prompt.text); inputRef.current?.focus(); }}>{prompt.label}</RamsButton>)}
        </div> : <RamsButton disabled={props.loading} onClick={props.signedIn ? props.onOpenConnection : props.onSignIn}>{props.signedIn ? 'Connect ChatGPT' : 'Sign in to o8'}</RamsButton>}
        <p style={{ ...labelStyle, marginTop: 24, marginBottom: 0 }}>Text only. Repository access and worker controls are separate.</p>
      </div> : null}
      <div style={columnStyle}>
        {props.messages.map((message) => <article key={message.id} style={{ display: 'flex', flexDirection: 'column', alignItems: message.role === 'user' ? 'flex-end' : 'flex-start', marginBottom: 24 }}>
          <div style={{ ...labelStyle, marginBottom: 8 }}>{message.role === 'user' ? 'You' : 'ChatGPT'}</div>
          <div style={{ maxWidth: message.role === 'user' ? '85%' : '100%', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', lineHeight: 1.55, borderRadius: 14, background: message.role === 'user' ? 'var(--t-input-bg)' : 'transparent', paddingTop: message.role === 'user' ? 12 : 0, paddingBottom: message.role === 'user' ? 12 : 0, paddingLeft: message.role === 'user' ? 16 : 0, paddingRight: message.role === 'user' ? 16 : 0 }}>{message.content}</div>
        </article>)}
        {props.stream ? <article style={{ marginBottom: 24 }}>
          <div style={{ ...labelStyle, marginBottom: 8 }}>ChatGPT{props.busy ? '' : ' · partial response'}</div>
          <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', lineHeight: 1.55 }}>{props.stream}</div>
        </article> : null}
        {props.busy ? <p role="status" style={{ ...labelStyle, marginTop: 8, marginBottom: 0 }}>{props.stream ? 'Receiving reply…' : 'Waiting for ChatGPT…'}</p> : null}
      </div>
    </div>

    <footer style={{ paddingTop: 12, paddingBottom: 16, paddingLeft: 24, paddingRight: 24, borderTop: enabled ? '1px solid var(--t-border)' : undefined }}>
      <div style={columnStyle}>
        {props.notice ? <p role="status" style={{ ...secondaryStyle, fontSize: 12, marginTop: 0, marginBottom: 12 }}>{props.notice}</p> : null}
        {enabled ? <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 8, border: '1px solid var(--t-border)', borderRadius: 14, background: 'var(--t-input-bg)', paddingTop: 12, paddingBottom: 8, paddingLeft: 16, paddingRight: 8 }}>
          <textarea ref={inputRef} aria-label="Message ChatGPT" rows={2} placeholder="Ask ChatGPT…" disabled={props.busy} value={props.input} onChange={(event) => props.onInputChange(event.target.value)} style={{ width: '100%', boxSizing: 'border-box', minHeight: 48, maxHeight: 160, resize: 'vertical', scrollbarWidth: 'none', border: 'none', background: 'transparent', color: 'inherit', fontFamily: 'inherit', fontSize: 13.5, fontWeight: 300, lineHeight: 1.5, paddingTop: 0, paddingBottom: 0, paddingLeft: 0, paddingRight: 8 }} />
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <span style={labelStyle}>Text only · Uses ChatGPT limits</span>
            {props.busy ? <RamsButton variant="ghost" onClick={props.onStop}>Stop</RamsButton> : <RamsButton type="submit" disabled={!props.input.trim() || !props.modelId}>Send</RamsButton>}
          </div>
        </form> : <p style={{ ...labelStyle, marginTop: 0, marginBottom: 8 }}>Requests use your ChatGPT limits.</p>}
        <p style={{ ...labelStyle, marginTop: 8, marginBottom: 0 }}>This conversation clears when you close the pane or change the connected account.</p>
      </div>
    </footer>
  </section>;
}
