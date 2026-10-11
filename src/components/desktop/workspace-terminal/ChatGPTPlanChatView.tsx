'use client';

import { useLayoutEffect, useMemo, useRef, type CSSProperties } from 'react';
import { RamsButton } from '@/components/desktop/settings/shared';
import { ChatMessageList } from '../thoughts/chat-panel/ChatMessageList';
import { ComposerArea } from '../thoughts/chat-panel/ComposerArea';
import { SendPill } from '../thoughts/ComposerSendControl';
import { ChatGPTPlanModelChip } from './ChatGPTPlanModelChip';
import type { LLMMessage } from '@/components/desktop/llm-chat/shared';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import type { PlanStatus } from '@/lib/chatgpt-plan/types';

const secondaryStyle: CSSProperties = { color: 'var(--t-text-secondary)', lineHeight: 1.5 };
const labelStyle: CSSProperties = { fontSize: 11, fontWeight: 300, color: 'var(--t-text-muted)', lineHeight: 1.35 };
const noop = () => {};
const prompts = [
  { label: 'Make a plan', text: 'Help me turn this idea into a clear plan. Ask me what you need to know first.' },
  { label: 'Compare options', text: 'Help me compare my options. Ask me about the decision and what matters most.' },
  { label: 'Review a draft', text: 'Help me improve a draft. Ask me to paste it and tell you who it is for.' },
];

interface Props {
  active?: boolean;
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
  const chatEndRef = useRef<HTMLDivElement>(null);
  const followingRef = useRef(true);
  const active = props.active ?? true;
  const enabled = Boolean(props.status?.planEnabled);
  const messages = useMemo<MobileTranscriptEntry[]>(() => [
    ...props.messages.map(message => ({ id: message.id, role: message.role, text: message.content, timestamp: message.timestamp, model: message.model, tokens: message.tokens })),
    ...(props.stream ? [{ id: 'chatgpt-live-response', role: 'assistant' as const, text: props.stream, model: props.modelId }] : []),
  ], [props.messages, props.stream, props.modelId]);
  useLayoutEffect(() => {
    if (!active || !followingRef.current) return;
    const scroller = chatEndRef.current?.closest<HTMLElement>('[role="log"]');
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  }, [active, props.messages.length, props.stream, props.busy]);

  const emptyState = <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'flex-start', width: '100%', paddingTop: 24, paddingBottom: 24 }}>
    <h1 style={{ fontSize: 18, fontWeight: 400, letterSpacing: '-0.2px', lineHeight: 1.25, marginTop: 0, marginBottom: 12 }}>{enabled ? 'Think it through with ChatGPT.' : 'Bring your ChatGPT plan into o8.'}</h1>
    <p style={{ ...secondaryStyle, maxWidth: 440, marginTop: 0, marginBottom: 24 }}>{enabled ? 'Plan your next step, compare an approach, or work through a draft.' : 'Connect your account to plan, ask questions, and review text here.'}</p>
    {enabled ? <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
      {prompts.map(prompt => <RamsButton key={prompt.label} variant="ghost" onClick={() => { props.onInputChange(prompt.text); inputRef.current?.focus(); }}>{prompt.label}</RamsButton>)}
    </div> : <RamsButton disabled={props.loading} onClick={props.signedIn ? props.onOpenConnection : props.onSignIn}>{props.signedIn ? 'Connect ChatGPT' : 'Sign in to o8'}</RamsButton>}
    <p style={{ ...labelStyle, marginTop: 24, marginBottom: 0 }}>{props.loading ? 'Checking connection…' : 'Text only · Uses your ChatGPT plan limits'}</p>
  </div>;

  return <section aria-label="ChatGPT plan chat" style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, minWidth: 0, background: 'transparent', color: 'var(--t-text)', fontFamily: 'var(--font-sans-system)', fontSize: 13.5, fontWeight: 300, letterSpacing: '-0.1px' }}>
    <ChatMessageList ref={chatEndRef} logLabel="ChatGPT conversation" active={active} displayMessages={messages} displayWaiting={props.busy}
      activeTargetLabel="ChatGPT" activeTargetColor="var(--t-accent)" thoughtsMutedGlass="var(--t-hover)" thoughtsElevatedBorder="1px solid var(--t-border)" thoughtsElevatedShadow="none"
      emptyStateOverride={emptyState} emptyStateFallback={null}
      onScroll={event => { const node = event.currentTarget; followingRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 120; }}
      bottomContent={props.stream && !props.busy ? <span role="status" style={labelStyle}>ChatGPT · partial response</span> : null} />
    {props.notice ? <p role="status" style={{ ...secondaryStyle, fontSize: 12, marginTop: 0, marginBottom: 8, paddingLeft: 24, paddingRight: 24 }}>{props.notice}</p> : null}
    {enabled ? <ComposerArea ref={inputRef} activeComposer={active} inputLabel="Message ChatGPT" literalInput
      input={props.input} onInputChange={props.onInputChange} isOrchestratorMode={false} displayWaiting={props.busy} chatMessages={messages}
      activeTargetLabel="ChatGPT" targetAgentExists thoughtsBodyBackground="transparent" enhancing={false} preEnhanceInput={null}
      onEnhance={noop} onUndoEnhance={noop} onSubmit={props.onSend} onSteer={props.onSend} onStop={props.onStop} onSlashCommand={noop}
      modelLabel={props.modelId} effort="medium" onEffortChange={noop} adaptiveEnabled={false} displayMessagesCount={props.messages.length} hasAssistantActivity={false}
      footerOverride={<div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, paddingTop: 4, paddingRight: 12, paddingBottom: 8, paddingLeft: 6 }}>
        <div style={{ flex: 1, minWidth: 0 }}><ChatGPTPlanModelChip key={`${active}:${props.busy}`} models={props.status?.models ?? []} modelId={props.modelId} busy={props.busy} active={active} onChange={props.onModelChange} onOpenConnection={props.onOpenConnection} /></div>
        <span style={{ ...labelStyle, flexShrink: 0 }}>Text only</span>
        <SendPill canSubmit={Boolean(props.input.trim() && props.modelId)} working={props.busy} onSubmit={props.onSend} onStop={props.onStop} targetLabel="ChatGPT" />
      </div>} /> : null}
  </section>;
}
