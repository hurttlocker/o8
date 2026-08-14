import { memo } from 'react';
import type React from 'react';
import { AnimatePresence, motion } from 'framer-motion';
// Raw SVG icons — lucide-react doesn't render in Tauri webview
function HistoryIcon({ size = 12 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}><circle cx="12" cy="12" r="9" /><polyline points="12 7 12 12 15 14" /></svg>;
}
function RotateCcwIcon({ size = 12 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path d="M3 3v5h5" /></svg>;
}
function SpinnerIcon({ size = 12 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" style={{ display: 'block', flexShrink: 0, animation: 'spin 1s linear infinite' }}><path d="M21 12a9 9 0 1 1-6.219-8.56" /></svg>;
}
function SparklesIcon({ size = 11 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" style={{ display: 'block', flexShrink: 0 }}><path d="M12 3l1.912 5.813a2 2 0 0 0 1.275 1.275L21 12l-5.813 1.912a2 2 0 0 0-1.275 1.275L12 21l-1.912-5.813a2 2 0 0 0-1.275-1.275L3 12l5.813-1.912a2 2 0 0 0 1.275-1.275L12 3z" /></svg>;
}
function ArrowDownIcon({ size = 13 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}><path d="M12 5v14" /><path d="m19 12-7 7-7-7" /></svg>;
}

import { noteUserScroll } from '@/lib/tts/scroll-follow';
import { AgentStatusDot } from '../AgentStatusDot';
import { CompactionNode } from '../CompactionNode';
import { renderLLMMarkdown } from '../LLMMarkdown';
import { ChainOfThought, LiveToolCalls } from './ChainOfThought';
import { MessageBubble } from './MessageBubble';
import { PROMPT_ICONS, SUGGESTED_PROMPTS, THEME_ACCENT, THEME_ACCENT_SOFT, THEME_ACCENT_SOFT_STRONG, THEME_BG_CARD, THEME_GLASS_BORDER_STRONG, THEME_GLASS_ELEVATED, THEME_GLASS_MUTED, THEME_GLASS_SHADOW, THEME_PANEL_BORDER, THEME_TEXT, THEME_TEXT_FAINT, THEME_TEXT_MUTED, THEME_TEXT_SECONDARY, type ActiveThinkingState, type LLMMessage, type MissionAction, type MissionCardData, type ModelOption, type ToolCallInfo } from './shared';

function PromptIcon({ d, size = 18, color = 'currentColor' }: { d: string; size?: number; color?: string }) {
  return <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} fill={color} viewBox="0 0 256 256" style={{ display: 'block', flexShrink: 0 }}><path d={d} /></svg>;
}

function ChatSurfaceBase({
  activeThinking,
  activeToolCalls,
  followUps,
  followUpsLoading,
  inputRef,
  isEmpty,
  isStreaming,
  turnStartedAt,
  isUserScrolledUp,
  messages,
  missionCard,
  model,
  onApplyToFile,
  onApplyDiff,
  onClearFollowUps,
  onDeleteMessage,
  onEditMessage,
  onFollowUpSelect,
  onForkMessage,
  onMissionAction,
  onNewConversation,
  onOpenInCanvas,
  onRetryMessage,
  onRunInTerminal,
  onScrollToBottom,
  onSuggestedPromptSelect,
  onToggleHistory,
  persistMissionDismissal,
  scrollRef,
  shouldShowMissionCard,
  shouldShowSuggestedPrompts,
  showTypingIndicator,
  streamContent,
  liveFallbackNotice,
  permissionMode,
  onStop,
}: {
  activeThinking: ActiveThinkingState | null;
  activeToolCalls: ToolCallInfo[];
  followUps: string[];
  followUpsLoading: boolean;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  isEmpty: boolean;
  isStreaming: boolean;
  /** Real turn-start (epoch ms) — drives the working dot's pulse→orbit switch at 7 min. */
  turnStartedAt?: number | null;
  isUserScrolledUp: boolean;
  messages: LLMMessage[];
  missionCard: MissionCardData | null;
  model: ModelOption;
  onApplyToFile: (code: string, language: string) => void;
  onApplyDiff?: (diffText: string) => void;
  onClearFollowUps: () => void;
  onDeleteMessage: (index: number) => void;
  onEditMessage: (index: number, content: string) => void;
  onFollowUpSelect: (question: string) => void;
  onForkMessage: (index: number) => void;
  onMissionAction: (action: MissionAction) => void;
  onNewConversation: () => void;
  onOpenInCanvas?: (code: string, language: string) => void;
  onRetryMessage: (index: number) => void;
  onRunInTerminal?: (command: string) => void;
  onScrollToBottom: () => void;
  onSuggestedPromptSelect: (text: string) => void;
  onToggleHistory: () => void;
  persistMissionDismissal: () => void;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  shouldShowMissionCard: boolean;
  shouldShowSuggestedPrompts: boolean;
  showTypingIndicator: boolean;
  streamContent: string;
  liveFallbackNotice?: string | null;
  permissionMode?: 'full' | 'plan';
  /** #525 — wired to the streaming DiffCard Stop button so mid-stream diffs are cancellable. */
  onStop?: () => void;
}) {
  return (
    <>
      <style>{`
        @keyframes llmFadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes llmDot { 0%, 80%, 100% { opacity: 0.3; transform: scale(0.8); } 40% { opacity: 1; transform: scale(1); } }
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        @keyframes ttsShimmer { 0% { transform: translateX(-100%); } 100% { transform: translateX(400%); } }
        @keyframes ttsWave { 0% { height: 4px; } 100% { height: 16px; } }
      `}</style>

      {/* Inner header — only shown when there are messages. The empty state
          is meant to breathe, so we don't stack a second chrome bar on the
          tab bar above. History can still be opened via the floating pill
          in the empty greeting below. */}
      {!isEmpty ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingTop: 5, paddingRight: 14, paddingBottom: 5, paddingLeft: 14, minHeight: 28, borderBottomWidth: '0.5px', borderBottomStyle: 'solid', borderBottomColor: 'var(--t-divider-subtle)' }}>
          <button type="button" onClick={onToggleHistory} title="Chat history" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, height: 24, paddingTop: 0, paddingRight: 9, paddingBottom: 0, paddingLeft: 8, borderWidth: 0, borderRadius: 7, background: 'transparent', color: 'var(--t-text-muted)', fontSize: 11, fontWeight: 500, cursor: 'pointer', transition: 'background 120ms cubic-bezier(0.22, 1, 0.36, 1), color 120ms cubic-bezier(0.22, 1, 0.36, 1)' }} onMouseEnter={(event) => { event.currentTarget.style.background = THEME_BG_CARD; event.currentTarget.style.color = 'var(--t-text-secondary)'; }} onMouseLeave={(event) => { event.currentTarget.style.background = 'transparent'; event.currentTarget.style.color = 'var(--t-text-muted)'; }}>
            <HistoryIcon size={12} />
            History
          </button>
          <div style={{ flex: 1 }} />
          <span style={{ fontSize: 10.5, color: 'var(--t-text-muted)', fontFamily: 'ui-monospace, monospace', display: 'flex', alignItems: 'center', gap: 6 }}>
            <span>{messages.length} msg{messages.length !== 1 ? 's' : ''}</span>
            {(() => {
              const totalTokens = messages.reduce((sum, message) => sum + (message.tokens?.input ?? 0) + (message.tokens?.output ?? 0), 0);
              const cachedTokens = messages.reduce((sum, message) => sum + (message.tokens?.cacheRead ?? 0), 0);
              const totalCost = messages.reduce((sum, message) => sum + (message.costUsd ?? 0), 0);
              return totalTokens > 0 ? (
                <>
                  <span style={{ color: 'var(--t-text-faint)' }}>|</span>
                  <span>{totalTokens > 1000 ? `${(totalTokens / 1000).toFixed(1)}K` : totalTokens} tokens</span>
                  {cachedTokens > 0 ? <><span style={{ color: 'var(--t-text-faint)' }}>|</span><span>{cachedTokens > 1000 ? `${(cachedTokens / 1000).toFixed(1)}K` : cachedTokens} cached</span></> : null}
                  {totalCost > 0 ? <><span style={{ color: 'var(--t-text-faint)' }}>|</span><span>${totalCost.toFixed(4)}</span></> : null}
                </>
              ) : null;
            })()}
          </span>
          <button type="button" onClick={onNewConversation} title="New conversation" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, paddingTop: 3, paddingRight: 7, paddingBottom: 3, paddingLeft: 7, borderWidth: 0, background: 'transparent', color: 'var(--t-text-muted)', fontSize: 11, fontWeight: 500, cursor: 'pointer', borderRadius: 6, transition: 'color 150ms, background 150ms' }} onMouseEnter={(event) => { event.currentTarget.style.color = 'var(--t-text-secondary)'; event.currentTarget.style.background = THEME_BG_CARD; }} onMouseLeave={(event) => { event.currentTarget.style.color = 'var(--t-text-muted)'; event.currentTarget.style.background = 'transparent'; }}>
            <RotateCcwIcon size={12} />
            New
          </button>
        </div>
      ) : null}

      <div ref={scrollRef} className="cortex-scroll-fade-y cortex-themed-scroll" onWheel={noteUserScroll} onTouchMove={noteUserScroll} style={{ flex: 1, overflowY: 'auto', paddingTop: isEmpty ? 0 : 24, paddingRight: 'var(--cortex-chat-gutter)', paddingBottom: 24, paddingLeft: 'var(--cortex-chat-gutter)', position: 'relative' }}>
        {/* Floating history toggle — shown only in the empty state, since
            the inline meta bar is hidden there. Gives users a discoverable
            way to browse past conversations without stacking chrome bars. */}
        {isEmpty ? (
          <button
            type="button"
            onClick={onToggleHistory}
            title="Chat history"
            style={{
              position: 'absolute',
              top: 10,
              left: 12,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
              height: 24,
              paddingTop: 0,
              paddingRight: 9,
              paddingBottom: 0,
              paddingLeft: 8,
              borderRadius: 7,
              borderWidth: 0,
              background: 'transparent',
              color: 'var(--t-text-muted)',
              fontSize: 11,
              fontWeight: 500,
              cursor: 'pointer',
              transition: 'background 120ms cubic-bezier(0.22, 1, 0.36, 1), color 120ms cubic-bezier(0.22, 1, 0.36, 1)',
              zIndex: 2,
            }}
            onMouseEnter={(event) => { event.currentTarget.style.background = THEME_BG_CARD; event.currentTarget.style.color = 'var(--t-text-secondary)'; }}
            onMouseLeave={(event) => { event.currentTarget.style.background = 'transparent'; event.currentTarget.style.color = 'var(--t-text-muted)'; }}
          >
            <HistoryIcon size={12} />
            History
          </button>
        ) : null}
        {isEmpty ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 32, animation: 'llmFadeIn 400ms ease-out' }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
              <div style={{ fontSize: 28, fontWeight: 300, color: 'var(--t-text-secondary)', letterSpacing: '-0.03em', lineHeight: 1.2 }}>{(() => { const hour = new Date().getHours(); return hour < 12 ? 'Good morning.' : hour < 17 ? 'Good afternoon.' : 'Good evening.'; })()}</div>
              <div style={{ fontSize: 11, fontWeight: 500, color: 'var(--t-text-muted)', letterSpacing: '0.06em', textTransform: 'uppercase' }}>{model.label}</div>
            </div>
            <AnimatePresence initial={false}>
              {shouldShowMissionCard && missionCard ? (
                <motion.div key={missionCard.source} initial={{ opacity: 0, y: 18, scale: 0.985, height: 0 }} animate={{ opacity: 1, y: 0, scale: 1, height: 'auto' }} exit={{ opacity: 0, y: -12, scale: 0.985, height: 0 }} transition={{ type: 'spring', stiffness: 400, damping: 30 }} style={{ width: '100%', maxWidth: 520, overflow: 'hidden' }}>
                  <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: 18, width: '100%', paddingTop: 24, paddingRight: 24, paddingBottom: 24, paddingLeft: 24, borderRadius: 14, border: `1px solid ${THEME_GLASS_BORDER_STRONG}`, background: `linear-gradient(180deg, ${THEME_GLASS_ELEVATED} 0%, ${THEME_GLASS_MUTED} 100%)`, boxShadow: THEME_GLASS_SHADOW, backdropFilter: 'blur(24px) saturate(1.08)', WebkitBackdropFilter: 'blur(24px) saturate(1.08)' } as React.CSSProperties}>
                    <button type="button" aria-label="Dismiss mission card" onClick={persistMissionDismissal} style={{ position: 'absolute', top: 12, right: 12, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 44, height: 44, borderRadius: 12, border: `1px solid ${THEME_PANEL_BORDER}`, background: 'transparent', color: THEME_TEXT_FAINT, cursor: 'pointer', fontSize: 18, fontWeight: 500, fontFamily: 'var(--font-sans-system)', lineHeight: 1, paddingTop: 0, paddingRight: 0, paddingBottom: 0, paddingLeft: 0 }}>
                      <span aria-hidden="true">&times;</span>
                    </button>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, paddingRight: 44 }}>
                      <div style={{ alignSelf: 'flex-start', minHeight: 28, paddingTop: 6, paddingRight: 10, paddingBottom: 6, paddingLeft: 10, borderRadius: 10, background: THEME_ACCENT_SOFT, color: THEME_ACCENT, fontSize: 11, fontWeight: 700, fontFamily: 'var(--font-sans-system)', letterSpacing: '-0.01em' }}>{missionCard.eyebrow}</div>
                      <div style={{ fontSize: 24, fontWeight: 600, color: THEME_TEXT, lineHeight: 1.12, letterSpacing: '-0.02em', fontFamily: 'var(--font-sans-system)' }}>{missionCard.title}</div>
                      <div style={{ fontSize: 14, fontWeight: 400, color: THEME_TEXT_MUTED, lineHeight: 1.55, letterSpacing: '-0.01em', fontFamily: 'var(--font-sans-system)', display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: 2, overflow: 'hidden' } as React.CSSProperties}>{missionCard.description}</div>
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
                      {missionCard.actions.map((action, index) => (
                        <button key={action.id} type="button" onClick={() => onMissionAction(action)} style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8, minHeight: 44, paddingTop: 0, paddingRight: 16, paddingBottom: 0, paddingLeft: 16, borderRadius: 12, border: index === 0 ? 'none' : `1px solid ${THEME_PANEL_BORDER}`, background: index === 0 ? THEME_ACCENT : THEME_BG_CARD, color: index === 0 ? '#ffffff' : THEME_TEXT_SECONDARY, cursor: 'pointer', fontSize: 13, fontWeight: 600, fontFamily: 'var(--font-sans-system)', letterSpacing: '-0.01em', boxShadow: index === 0 ? `0 12px 32px ${THEME_ACCENT_SOFT_STRONG}` : 'none' }}>
                          <span>{action.label}</span>
                          <span aria-hidden="true">&rarr;</span>
                        </button>
                      ))}
                    </div>
                  </div>
                </motion.div>
              ) : null}
            </AnimatePresence>
            {shouldShowSuggestedPrompts ? (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 1, maxWidth: 520, width: '100%', border: '0.5px solid var(--t-divider-subtle)', borderRadius: 14, overflow: 'hidden' }}>
                {SUGGESTED_PROMPTS.map((prompt, index) => (
                  <button key={prompt.text} type="button" onClick={() => { onSuggestedPromptSelect(prompt.text); setTimeout(() => inputRef.current?.focus(), 50); }} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, paddingTop: 16, paddingRight: 16, paddingBottom: 16, paddingLeft: 16, background: 'transparent', border: 'none', borderRight: index % 2 === 0 ? '0.5px solid var(--t-divider-subtle)' : 'none', borderBottom: index < 4 ? '0.5px solid var(--t-divider-subtle)' : 'none', cursor: 'pointer', textAlign: 'left', transition: 'background 150ms cubic-bezier(0.22, 1, 0.36, 1)', animation: `llmFadeIn 400ms ease-out ${100 + index * 50}ms both` }} onMouseEnter={(event) => { event.currentTarget.style.background = 'rgba(37, 99, 235, 0.04)'; }} onMouseLeave={(event) => { event.currentTarget.style.background = 'transparent'; }}>
                    <div style={{ color: 'var(--t-text-faint)', marginTop: 1 }}><PromptIcon d={PROMPT_ICONS[prompt.iconKey]} size={16} /></div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                      <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--t-text-secondary)', letterSpacing: '-0.01em', lineHeight: '1.3' }}>{prompt.text}</span>
                      <span style={{ fontSize: 11, fontWeight: 400, color: 'var(--t-text-muted)', lineHeight: '1.4', letterSpacing: '-0.005em' }}>{prompt.description}</span>
                    </div>
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%', maxWidth: 'var(--cortex-chat-column-max)', marginLeft: 'auto', marginRight: 'auto' }}>
          {messages.map((message, index) => {
            const previousMessage = index > 0 ? messages[index - 1] : null;
            const showTimeSeparator = previousMessage ? message.timestamp - previousMessage.timestamp > 5 * 60 * 1000 : false;
            const timeLabel = showTimeSeparator ? new Date(message.timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : null;
            return (
              <div key={message.id} style={{ animation: 'llmFadeIn 250ms ease-out' }}>
                {showTimeSeparator ? <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 16, marginBottom: 16 }}><div style={{ flex: 1, height: 1, background: '#f1f5f9' }} /><span style={{ fontSize: 11, color: '#cbd5e1', fontFamily: 'var(--font-sans-system)', fontWeight: 500, flexShrink: 0 }}>{timeLabel}</span><div style={{ flex: 1, height: 1, background: '#f1f5f9' }} /></div> : null}
                {message.isCompaction ? (
                  <CompactionNode compactedCount={message.compactedCount ?? 0} summary={message.content} />
                ) : (
                  <MessageBubble
                    message={message}
                    isLast={index === messages.length - 1 && !isStreaming}
                    onRetry={message.role === 'assistant' ? () => onRetryMessage(index) : undefined}
                    onEdit={message.role === 'user' ? (content) => onEditMessage(index, content) : undefined}
                    onDelete={() => onDeleteMessage(index)}
                    onFork={message.role === 'assistant' ? () => onForkMessage(index) : undefined}
                    onApplyToFile={onApplyToFile}
                    onApplyDiff={onApplyDiff}
                    onOpenInCanvas={onOpenInCanvas}
                    onRunInTerminal={onRunInTerminal}
                  />
                )}
              </div>
            );
          })}

          {showTypingIndicator && !isStreaming ? <div style={{ display: 'flex', alignItems: 'center', gap: 4, paddingTop: 12, paddingBottom: 8, paddingLeft: 4, animation: 'llmFadeIn 200ms ease-out' }}>{[0, 1, 2].map((index) => <div key={index} style={{ width: 8, height: 8, borderRadius: '50%', background: '#cbd5e1', animation: `llmDot 1.4s ease-in-out ${index * 0.2}s infinite` }} />)}</div> : null}

          {!isStreaming && (followUps.length > 0 || followUpsLoading) ? (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12, animation: 'llmFadeIn 300ms ease-out' }}>
              {followUpsLoading ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, paddingTop: 8, paddingRight: 12, paddingBottom: 8, paddingLeft: 12, fontSize: 12, color: '#94a3b8' }}>
                  <SpinnerIcon size={12} />
                  Thinking of follow-ups...
                </div>
              ) : followUps.map((question, index) => (
                <button key={`${question}-${index}`} type="button" onClick={() => { onFollowUpSelect(question); onClearFollowUps(); setTimeout(() => inputRef.current?.focus(), 50); }} style={{ display: 'flex', alignItems: 'center', gap: 6, paddingTop: 8, paddingRight: 14, paddingBottom: 8, paddingLeft: 12, background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 20, fontSize: 12, color: '#475569', cursor: 'pointer', transition: 'background 150ms cubic-bezier(0.22, 1, 0.36, 1), border-color 150ms cubic-bezier(0.22, 1, 0.36, 1), color 150ms cubic-bezier(0.22, 1, 0.36, 1)', fontFamily: 'var(--font-sans-system)', animation: `llmFadeIn 300ms ease-out ${index * 80}ms both` }} onMouseEnter={(event) => { event.currentTarget.style.borderColor = '#3b82f6'; event.currentTarget.style.background = '#f0f9ff'; event.currentTarget.style.color = '#1e40af'; }} onMouseLeave={(event) => { event.currentTarget.style.borderColor = '#e2e8f0'; event.currentTarget.style.background = '#f8fafc'; event.currentTarget.style.color = '#475569'; }}>
                  <SparklesIcon size={11} />
                  {question}
                </button>
              ))}
            </div>
          ) : null}

          {isStreaming ? (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 4 }}>
              {liveFallbackNotice ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, paddingTop: 6, paddingBottom: 4, paddingLeft: 2, fontSize: 11, color: 'var(--t-text-muted)', fontStyle: 'italic', fontFamily: 'var(--font-sans-system)', animation: 'llmFadeIn 200ms ease-out' }}>
                  <svg width="12" height="12" viewBox="0 0 256 256" fill="none" style={{ flexShrink: 0, opacity: 0.7 }}>
                    <path d="M236.8 188.09 149.35 36.22a24.76 24.76 0 0 0-42.7 0L19.2 188.09a23.51 23.51 0 0 0 0 23.72A24.35 24.35 0 0 0 40.55 224h174.9a24.35 24.35 0 0 0 21.33-12.19 23.51 23.51 0 0 0 .02-23.72ZM120 104a8 8 0 0 1 16 0v40a8 8 0 0 1-16 0Zm8 88a12 12 0 1 1 12-12 12 12 0 0 1-12 12Z" fill="currentColor" />
                  </svg>
                  {liveFallbackNotice}
                </div>
              ) : null}
              {activeThinking ? <ChainOfThought steps={activeThinking.steps} thinking={activeThinking.thinking} isLive /> : null}
              {activeToolCalls.length > 0 && !activeThinking?.steps.length ? <LiveToolCalls toolCalls={activeToolCalls} /> : null}
              {streamContent ? (
                <div style={{ maxWidth: '90%', paddingTop: 16, paddingBottom: 16, fontSize: 14, lineHeight: '1.6', color: '#1e293b', wordBreak: 'break-word', animation: 'llmFadeIn 200ms ease-out' }}>
                  {renderLLMMarkdown(streamContent, {
                    onApplyToFile,
                    onApplyDiff,
                    onOpenInCanvas,
                    onRunInTerminal,
                    isStreaming: true,
                    onInterruptStream: onStop,
                  })}
                  <span style={{ display: 'inline-block', width: 2, height: 16, background: '#3b82f6', marginLeft: 2, verticalAlign: 'text-bottom', animation: 'llmDot 1s ease-in-out infinite' }} />
                </div>
              ) : !activeThinking ? (
                <div style={{ display: 'flex', alignItems: 'center', paddingTop: 16, paddingBottom: 8 }}>
                  <AgentStatusDot state="running" startedAt={turnStartedAt} />
                </div>
              ) : null}
            </div>
          ) : null}
          {permissionMode === 'plan' && model.provider === 'operator' && messages.length === 0 && !isStreaming ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, paddingTop: 8, paddingRight: 12, paddingBottom: 8, paddingLeft: 12, background: 'var(--t-bg-card)', border: '1px solid var(--t-panel-border)', borderRadius: 10, fontSize: 11, fontWeight: 500, color: 'var(--t-text-muted)', fontFamily: 'var(--font-sans-system)' }}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, opacity: 0.75 }}>
                <rect x="3" y="11" width="18" height="11" rx="2" />
                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
              </svg>
              Plan mode — Operator will think and answer but cannot edit files or run commands
            </div>
          ) : null}
        </div>
      </div>

      {isUserScrolledUp && messages.length > 0 ? (
        <div style={{ position: 'absolute', right: 30, bottom: 104, zIndex: 50, animation: 'llmFadeIn 150ms ease-out' }}>
          <button type="button" onClick={onScrollToBottom} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, minHeight: 34, paddingTop: 7, paddingRight: 12, paddingBottom: 7, paddingLeft: 12, background: 'linear-gradient(180deg, rgba(239,246,255,0.94), rgba(191,219,254,0.72))', border: '1px solid rgba(96, 165, 250, 0.22)', borderRadius: 999, boxShadow: '0 12px 28px rgba(37, 99, 235, 0.16)', backdropFilter: 'blur(18px)', WebkitBackdropFilter: 'blur(18px)', cursor: 'pointer', fontSize: 11, fontWeight: 700, color: '#1d4ed8', fontFamily: 'var(--font-sans-system)', transition: 'background 150ms, border-color 150ms, color 150ms' } as React.CSSProperties}>
            <ArrowDownIcon size={13} />
            Bottom messages
          </button>
        </div>
      ) : null}
    </>
  );
}

export const ChatSurface = memo(ChatSurfaceBase);
