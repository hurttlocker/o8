'use client';

import React, { memo, useEffect, useMemo, useRef, useState } from 'react';
import {
  PaperPlaneRight,
  Stop,
  SpinnerGap,
  PlusCircle,
  MagicWand,
} from '@phosphor-icons/react';
import { autocompleteSlashCommand, isSlashCommandText } from '@/lib/slash-commands';
import {
  THEME_ACCENT,
  THEME_ACCENT_SOFT,
  THEME_ACCENT_BORDER,
  THEME_BG_CARD,
  THEME_PANEL_GLASS,
  O_PLACEHOLDERS,
} from './constants';
import {
  sessionDisplayModel,
  cleanBranchLabel,
  composeFooterLeadLabel,
} from './shared';
import type { DesktopComposePaneProps, ThinkingXrayProps } from './types';

const ThinkingXray = memo(function ThinkingXray({
  model,
  agentRunning,
  streamingText,
}: ThinkingXrayProps) {
  const [expanded, setExpanded] = useState(false);
  const streamRef = useRef<HTMLDivElement>(null);
  const wordCount = useMemo(
    () => streamingText ? streamingText.split(/\s+/).filter(Boolean).length : 0,
    [streamingText],
  );

  useEffect(() => {
    if (expanded && streamRef.current) {
      streamRef.current.scrollTop = streamRef.current.scrollHeight;
    }
  }, [expanded, streamingText]);

  const isThinking = agentRunning && !streamingText;
  const isStreaming = agentRunning && !!streamingText;

  return (
    <div style={{ position: 'relative' }}>
      <div className="remodex-compose-status-bar" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span className="remodex-compose-chip remodex-compose-pill">
          {model}
        </span>

        <button
          type="button"
          onClick={() => {
            if (isThinking || isStreaming) setExpanded(v => !v);
          }}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 5,
            padding: '3px 10px', borderRadius: 10,
            border: isThinking || isStreaming
              ? '1px solid rgba(147, 197, 253, 0.3)'
              : '1px solid var(--t-divider)',
            background: isThinking || isStreaming
              ? expanded
                ? 'rgba(59, 130, 246, 0.12)'
                : 'rgba(147, 197, 253, 0.08)'
              : 'var(--t-hover)',
            cursor: (isThinking || isStreaming) ? 'pointer' : 'default',
            fontSize: 11, fontWeight: 600,
            fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
            color: isThinking || isStreaming ? '#3b82f6' : 'var(--t-text-muted)',
            transition: 'all 200ms ease',
            letterSpacing: '-0.01em',
          }}
        >
          <svg
            width="12" height="12" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
            style={{
              animation: isThinking ? 'pulse 1.5s ease-in-out infinite' : 'none',
              opacity: isThinking || isStreaming ? 1 : 0.5,
            }}
          >
            <path d="M12 2a7 7 0 0 0-7 7c0 2.38 1.19 4.47 3 5.74V17a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1v-2.26c1.81-1.27 3-3.36 3-5.74a7 7 0 0 0-7-7z" />
            <path d="M9 21h6" />
          </svg>

          {isThinking ? (
            <span>Thinking...</span>
          ) : isStreaming ? (
            <span>{wordCount} words</span>
          ) : (
            <span>Idle</span>
          )}

          {(isThinking || isStreaming) && (
            <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2.5" strokeLinecap="round" style={{
                transition: 'transform 200ms ease',
                transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)',
                opacity: 0.5,
              }}>
              <polyline points="6 9 12 15 18 9"/>
            </svg>
          )}
        </button>
      </div>

      {expanded && (isThinking || isStreaming) && (
        <div style={{
          position: 'absolute',
          bottom: '100%',
          left: 0, right: 0,
          marginBottom: 4,
          borderRadius: 12,
          background: 'rgba(15, 23, 42, 0.92)',
          backdropFilter: 'blur(24px) saturate(1.6)',
          WebkitBackdropFilter: 'blur(24px) saturate(1.6)',
          border: '1px solid rgba(59, 130, 246, 0.2)',
          boxShadow: '0 8px 32px rgba(0,0,0,0.3), 0 0 0 1px rgba(59, 130, 246, 0.1)',
          maxHeight: 200,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          zIndex: 50,
        }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '8px 12px',
            borderBottom: '1px solid rgba(255,255,255,0.06)',
            flexShrink: 0,
          }}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#60a5fa"
              strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
              style={{ animation: isThinking ? 'pulse 1.5s ease-in-out infinite' : 'none' }}>
              <path d="M12 2a7 7 0 0 0-7 7c0 2.38 1.19 4.47 3 5.74V17a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1v-2.26c1.81-1.27 3-3.36 3-5.74a7 7 0 0 0-7-7z" />
              <path d="M9 21h6" />
            </svg>
            <span style={{
              fontSize: 10, fontWeight: 700, color: '#60a5fa',
              letterSpacing: '0.03em', textTransform: 'uppercase',
            }}>
              Chain of Thought
            </span>
            {isStreaming && (
              <span style={{
                fontSize: 9, color: '#94a3b8', marginLeft: 'auto',
                fontFamily: '"SF Mono", ui-monospace, monospace',
              }}>
                {wordCount} words
              </span>
            )}
            <button
              type="button"
              onClick={() => setExpanded(false)}
              style={{
                marginLeft: isStreaming ? 0 : 'auto',
                width: 18, height: 18, borderRadius: 5,
                border: 'none', background: 'rgba(255,255,255,0.06)',
                color: '#64748b', cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 10,
              }}
            >
              {'\u2715'}
            </button>
          </div>

          <div
            ref={streamRef}
            style={{
              flex: 1,
              overflowY: 'auto',
              padding: '10px 12px',
              fontSize: 11,
              lineHeight: 1.6,
              color: '#cbd5e1',
              fontFamily: '"SF Mono", ui-monospace, monospace',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {isThinking && !streamingText && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#64748b' }}>
                <div style={{
                  width: 12, height: 12, borderRadius: '50%',
                  border: '2px solid rgba(96, 165, 250, 0.3)',
                  borderTopColor: '#60a5fa',
                  animation: 'spin 1s linear infinite',
                }} />
                Reasoning in progress...
              </div>
            )}
            {streamingText || ''}
          </div>
        </div>
      )}
    </div>
  );
});

export const DesktopComposePane = memo(function DesktopComposePane({
  pendingFiles,
  removePendingFile,
  selectedSession,
  modelOverride,
  branchOverride,
  statusOverride,
  contextPercentOverride,
  allowAttachments = true,
  composeRef,
  draft,
  setDraft,
  showSlashSuggestions,
  slashSuggestions,
  composeHeight,
  currentAgentName,
  send,
  fileInputRef,
  enhancing,
  enhance,
  agentRunning,
  streamingText,
  sending,
  stopping,
  stopRun,
  chatSendDisabled,
  canInterruptSelected,
}: DesktopComposePaneProps) {
  const composePlaceholder = useMemo(() => {
    const basis = `${selectedSession?.sessionKey ?? ''}:${currentAgentName}`;
    let hash = 0;
    for (let i = 0; i < basis.length; i += 1) {
      hash = (hash * 31 + basis.charCodeAt(i)) >>> 0;
    }
    return O_PLACEHOLDERS[hash % O_PLACEHOLDERS.length];
  }, [currentAgentName, selectedSession?.sessionKey]);

  return (
    <div style={{
      paddingTop: 10,
      paddingRight: 14,
      paddingBottom: 14,
      paddingLeft: 14,
      flexShrink: 0,
    }}>
      {pendingFiles.length > 0 && (
        <div style={{
          display: 'flex',
          gap: 8,
          paddingTop: 8,
          paddingBottom: 8,
          overflowX: 'auto',
        }}>
          {pendingFiles.map((f, idx) => (
            <div key={idx} style={{
              position: 'relative',
              flexShrink: 0,
              borderRadius: 10,
              overflow: 'hidden',
              border: '1px solid var(--t-divider)',
              background: 'var(--t-panel-translucent)',
            }}>
              {f.preview ? (
                <img src={f.preview} alt={f.name} style={{
                  width: 64,
                  height: 64,
                  objectFit: 'cover',
                  display: 'block',
                }} />
              ) : (
                <div style={{
                  width: 64,
                  height: 64,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 10,
                  color: 'var(--t-text-secondary)',
                  textAlign: 'center',
                  padding: 4,
                  wordBreak: 'break-all',
                }}>
                  {f.name.slice(0, 12)}
                </div>
              )}
              <button
                type="button"
                onClick={() => removePendingFile(idx)}
                style={{
                  position: 'absolute',
                  top: 2,
                  right: 2,
                  width: 18,
                  height: 18,
                  borderRadius: '50%',
                  border: 'none',
                  background: 'rgba(0,0,0,0.5)',
                  color: '#fff',
                  fontSize: 11,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  paddingTop: 0,
                  paddingRight: 0,
                  paddingBottom: 0,
                  paddingLeft: 0,
                }}
              >
                {'\u00d7'}
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="remodex-compose-surface" style={{ backgroundColor: 'rgba(0, 0, 0, 0.025)' }}>
        <ThinkingXray
          model={modelOverride ?? sessionDisplayModel(selectedSession)}
          agentRunning={agentRunning}
          streamingText={streamingText}
        />

        <textarea
          ref={composeRef}
          name="agentPanelMessage"
          aria-label={`Message ${currentAgentName}`}
          className="remodex-compose-input"
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Tab' && showSlashSuggestions) {
              e.preventDefault();
              const nextValue = autocompleteSlashCommand(draft);
              if (nextValue) {
                setDraft(`${nextValue} `);
              }
              return;
            }
            if (e.key === 'Enter' && !e.shiftKey && draft.trim()) {
              e.preventDefault();
              void send();
            }
          }}
          placeholder={composePlaceholder}
          style={{
            height: composeHeight,
            minHeight: 60,
            maxHeight: 400,
            resize: 'none',
            transition: 'none',
          }}
        />
        {showSlashSuggestions ? (
          <div style={{
            marginTop: 8,
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
            padding: 10,
            borderRadius: 14,
            border: `1px solid ${THEME_ACCENT_BORDER}`,
            background: THEME_PANEL_GLASS,
          }}>
            {slashSuggestions.slice(0, 6).map((item) => (
              <button
                key={item.command}
                type="button"
                onClick={() => {
                  setDraft(`${item.command} `);
                  composeRef.current?.focus();
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 12,
                  width: '100%',
                  minHeight: 36,
                  padding: '8px 10px',
                  borderRadius: 10,
                  border: 'none',
                  background: THEME_ACCENT_SOFT,
                  color: 'var(--t-text)',
                  cursor: 'pointer',
                  textAlign: 'left',
                  fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
                }}
              >
                <span style={{ fontSize: 12, fontWeight: 700, fontFamily: '"SF Mono", ui-monospace, monospace' }}>
                  {item.command}
                </span>
                <span style={{ fontSize: 11, color: 'var(--t-text-muted)' }}>{item.description}</span>
              </button>
            ))}
          </div>
        ) : null}

        <div className="remodex-compose-row">
          {allowAttachments ? (
            <button
              type="button"
              className="remodex-compose-chip remodex-compose-chip-icon"
              aria-label="Attach"
              onClick={() => fileInputRef.current?.click()}
            >
              <PlusCircle size={18} weight="duotone" />
            </button>
          ) : null}
          {draft.trim().length >= 3 ? (
            <button
              type="button"
              className="remodex-compose-chip remodex-compose-chip-icon"
              aria-label="Enhance prompt"
              disabled={enhancing}
              onClick={() => void enhance()}
              style={{ color: enhancing ? '#d1d5db' : '#ff9f0a' }}
            >
              <MagicWand size={18} weight={enhancing ? 'regular' : 'duotone'} className={enhancing ? 'spin' : undefined} />
            </button>
          ) : null}
          {(agentRunning || canInterruptSelected) && !draft.trim() ? (
            <button
              type="button"
              disabled={stopping}
              onClick={() => void stopRun()}
              aria-label="Stop agent run"
              style={{
                marginLeft: 'auto',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '0.32rem',
                minWidth: 42,
                minHeight: 42,
                padding: '0 0.82rem',
                borderRadius: 999,
                border: '2px solid #ef4444',
                background: stopping ? 'rgba(127, 29, 29, 0.16)' : 'rgba(239, 68, 68, 0.10)',
                color: '#ef4444',
                fontSize: '0.84rem',
                fontWeight: 700,
                cursor: stopping ? 'default' : 'pointer',
                transition: 'all 150ms ease',
              }}
            >
              {stopping ? (
                <SpinnerGap size={17} weight="bold" className="spin" />
              ) : (
                <>
                  <Stop size={16} weight="fill" />
                  <span>Stop</span>
                </>
              )}
            </button>
          ) : (
            <button
              type="button"
              disabled={chatSendDisabled}
              onClick={() => void send()}
              aria-label={`Send message to ${currentAgentName}`}
              style={{
                marginLeft: 'auto',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 36,
                height: 36,
                borderRadius: 10,
                border: 'none',
                background: chatSendDisabled ? 'var(--t-divider-subtle)' : THEME_ACCENT,
                color: chatSendDisabled ? 'var(--t-text-faint)' : '#ffffff',
                cursor: chatSendDisabled ? 'default' : 'pointer',
                transition: 'background 150ms ease, box-shadow 150ms ease',
                boxShadow: chatSendDisabled ? 'none' : '0 2px 8px rgba(37, 99, 235, 0.2)',
              }}
            >
              {sending ? (
                <SpinnerGap size={18} weight="bold" className="spin" />
              ) : (
                <PaperPlaneRight size={18} weight="fill" />
              )}
            </button>
          )}
        </div>
      </div>

      <div style={{
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        gap: 8,
        padding: '5px 12px',
        marginTop: 4,
      }}>
        {(() => {
          const rawPct = contextPercentOverride ?? ((selectedSession as unknown as Record<string, unknown>)?.context
            ? ((selectedSession as unknown as Record<string, unknown>).context as { usedPercent?: number })?.usedPercent
            : undefined);
          const pct = typeof rawPct === 'number' && rawPct > 0 ? Math.round(rawPct) : null;
          const leadLabel = composeFooterLeadLabel(selectedSession, statusOverride);
          const branchLabel = cleanBranchLabel(branchOverride ?? selectedSession?.branch);

          return (
            <>
              {leadLabel ? (
                <span style={{ fontSize: 12, color: 'var(--t-text-secondary)', fontWeight: 600 }}>
                  {leadLabel}
                </span>
              ) : null}
              {branchLabel ? (
                <>
                  {leadLabel ? <span style={{ color: 'var(--t-divider)' }}>{'\u00b7'}</span> : null}
                  <span style={{ fontSize: 12, color: 'var(--t-text-secondary)', fontWeight: 500 }}>
                    {branchLabel}
                  </span>
                </>
              ) : null}
              {pct !== null ? (
                <>
                  {(leadLabel || branchLabel) ? <span style={{ color: 'var(--t-divider)' }}>{'\u00b7'}</span> : null}
                  <span style={{
                    width: 6,
                    height: 6,
                    borderRadius: '50%',
                    background: pct >= 70 ? '#ef4444' : pct >= 50 ? '#f59e0b' : '#34c759',
                    flexShrink: 0,
                  }} />
                  <span style={{ fontSize: 12, color: 'var(--t-text-secondary)', fontWeight: 500 }}>
                    {pct}% context
                  </span>
                </>
              ) : null}
            </>
          );
        })()}
      </div>
    </div>
  );
});
