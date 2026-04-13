'use client';

import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Image from 'next/image';
import { ChevronRight, SlidersHorizontal, Sparkles } from '../lucide-shims';
import { CompactionNode } from '@/components/desktop/CompactionNode';
import { DesktopToolCallStack } from '../DesktopAgentMessage';
import { MessageActions } from '../MessageActions';
import { isSlashCommandText } from '@/lib/slash-commands';
import { ttsEngine } from '@/lib/tts/engine';
import {
  THEME_ACCENT,
  THEME_ACCENT_SOFT,
  THEME_BG_CARD,
  THEME_PANEL_GLASS,
  CHANGED_FILE_STYLE,
  OPERATOR_DETAIL_STYLE,
} from './constants';
import {
  sanitizeTranscriptText,
  parseRuntimeEventSummary,
  isCompactionEntry,
  shouldCollapseOperatorEntry,
  buildOperatorSummary,
  roleLabel,
  mediaHref,
  isImageMedia,
} from './shared';
import { renderMarkdownBlocks } from './markdown';
import type { MobileTranscriptToolCall } from '@/lib/mobile/types';
import type { BubbleProps } from './types';

export const Bubble = memo(function Bubble({ entry, previousEntry, agentName, isNew, onOpenMermaid, onRunInTerminal }: BubbleProps) {
  const isUser = entry.role === 'user';
  const displayText = sanitizeTranscriptText(entry.text);
  const hasText = Boolean(displayText.trim());
  const hasMedia = Boolean(entry.media?.length);
  const hasToolCalls = Boolean(entry.toolCalls?.length);
  const isSlashCommand = isSlashCommandText(entry.text);
  const runtimeEvent = useMemo(() => parseRuntimeEventSummary(entry.text), [entry.text]);
  const displayRuntimeEvent = useMemo(() => {
    if (!runtimeEvent) return null;

    const rawPreviewLines = (runtimeEvent.rawPreviewLines ?? [])
      .map((line) => sanitizeTranscriptText(line))
      .map((line) => line.trim())
      .filter(Boolean);

    return {
      ...runtimeEvent,
      title: sanitizeTranscriptText(runtimeEvent.title),
      summary: sanitizeTranscriptText(runtimeEvent.summary),
      status: runtimeEvent.status ? sanitizeTranscriptText(runtimeEvent.status) : undefined,
      task: runtimeEvent.task ? sanitizeTranscriptText(runtimeEvent.task) : undefined,
      source: runtimeEvent.source ? sanitizeTranscriptText(runtimeEvent.source) : undefined,
      action: runtimeEvent.action ? sanitizeTranscriptText(runtimeEvent.action) : undefined,
      rawPreviewLines,
    };
  }, [runtimeEvent]);
  const runtimeEventDisplay = displayRuntimeEvent ?? runtimeEvent;
  const displayStatus = runtimeEventDisplay?.status;
  const displaySource = runtimeEventDisplay?.source;
  const displayAction = runtimeEventDisplay?.action;
  const displayChangedFiles = runtimeEventDisplay?.changedFiles ?? [];
  const displayPreviewLines = runtimeEventDisplay?.rawPreviewLines ?? [];
  const speakerChanged = !previousEntry || previousEntry.role !== entry.role;
  const showTimestamp = (() => {
    if (!previousEntry?.timestampLabel || !entry.timestampLabel) return speakerChanged;
    const prev = new Date(`1970-01-01 ${previousEntry.timestampLabel}`).getTime();
    const curr = new Date(`1970-01-01 ${entry.timestampLabel}`).getTime();
    if (Number.isNaN(prev) || Number.isNaN(curr)) return speakerChanged;
    return Math.abs(curr - prev) >= 15 * 60 * 1000;
  })();

  const mdBlocks = useMemo(
    () => hasText ? renderMarkdownBlocks(displayText, onOpenMermaid, onRunInTerminal) : [],
    [displayText, hasText, onOpenMermaid, onRunInTerminal],
  );

  const [activeBlock, setActiveBlock] = useState<number | null>(null);
  const [handoffExpanded, setHandoffExpanded] = useState(false);
  const [operatorExpanded, setOperatorExpanded] = useState(false);
  const playingRef = useRef(false);

  useEffect(() => {
    if (entry.role !== 'assistant') return;
    return ttsEngine.subscribe((state) => {
      const isOurs = state.activeMessageId === entry.id;

      if (isOurs && (state.state === 'playing' || state.state === 'loading')) {
        playingRef.current = true;
        setActiveBlock((prev) => prev ?? 0);
      }

      if (playingRef.current && (state.state === 'idle' || state.state === 'error' || (!isOurs && state.activeMessageId !== null))) {
        playingRef.current = false;
        setActiveBlock(null);
      }
    });
  }, [entry.id, entry.role]);

  const handleBlockClick = useCallback((blockIndex: number) => {
    const textFromHere = mdBlocks
      .slice(blockIndex)
      .map(b => b.rawText)
      .join('\n\n');

    if (!textFromHere.trim()) return;

    setActiveBlock(blockIndex);
    void ttsEngine.play(textFromHere, entry.id);
  }, [mdBlocks, entry.id]);

  if (isCompactionEntry(entry)) {
    return (
      <CompactionNode
        summary={entry.compaction?.summary}
        trigger={entry.compaction?.trigger}
        tokensBefore={entry.compaction?.tokensBefore}
        tokensAfter={entry.compaction?.tokensAfter}
        timestampLabel={showTimestamp ? entry.timestampLabel : undefined}
      />
    );
  }

  if (!isUser && runtimeEventDisplay) {
    return (
      <article className={`remodex-message-card remodex-message-card-assistant${isNew ? ' remodex-turn-new' : ''}`}>
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
          padding: '2px 0',
        }}>
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
          }}>
            <span style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 28,
              height: 28,
              borderRadius: 10,
              background: 'rgba(37, 99, 235, 0.10)',
              color: '#2563eb',
              flexShrink: 0,
            }}>
              <Sparkles size={15} strokeWidth={2.2} />
            </span>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{
                fontSize: 12,
                fontWeight: 700,
                color: 'var(--t-text)',
                letterSpacing: '-0.01em',
              }}>
                {runtimeEventDisplay.title}
              </div>
              <div style={{
                marginTop: 2,
                fontSize: 11,
                color: 'var(--t-text-secondary)',
                lineHeight: 1.45,
              }}>
                {runtimeEventDisplay.summary}
              </div>
            </div>
          </div>

          <div style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 6,
          }}>
            <span style={{
              display: 'inline-flex',
              alignItems: 'center',
              padding: '3px 8px',
              borderRadius: 999,
              background: THEME_ACCENT_SOFT,
              color: THEME_ACCENT,
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: '0.02em',
            }}>
              sub-agent
            </span>
            {displayStatus ? (
              <span style={{
                display: 'inline-flex',
                alignItems: 'center',
                padding: '3px 8px',
                borderRadius: 999,
                background: displayStatus.toLowerCase().includes('timed')
                  ? 'rgba(245, 158, 11, 0.10)'
                  : 'rgba(37, 99, 235, 0.10)',
                color: displayStatus.toLowerCase().includes('timed') ? '#b45309' : '#2563eb',
                fontSize: 10,
                fontWeight: 700,
                textTransform: 'uppercase',
                letterSpacing: '0.04em',
              }}>
                {displayStatus}
              </span>
            ) : null}
            {displaySource ? (
              <span style={{
                display: 'inline-flex',
                alignItems: 'center',
                padding: '3px 8px',
                borderRadius: 999,
                background: 'var(--t-divider-subtle)',
                color: 'var(--t-text-secondary)',
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: '0.02em',
              }}>
                {displaySource}
              </span>
            ) : null}
            {displayChangedFiles.length ? (
              <span style={{
                display: 'inline-flex',
                alignItems: 'center',
                padding: '3px 8px',
                borderRadius: 999,
                background: THEME_BG_CARD,
                color: 'var(--t-text-secondary)',
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: '0.02em',
              }}>
                {displayChangedFiles.length} file{displayChangedFiles.length !== 1 ? 's' : ''}
              </span>
            ) : null}
            {(displayAction || displayPreviewLines.length || displayChangedFiles.length) ? (
                <button
                  type="button"
                  onClick={() => setHandoffExpanded((value) => !value)}
                  style={{
                    display: 'inline-flex',
                  alignItems: 'center',
                    gap: 5,
                    padding: '3px 8px',
                    borderRadius: 999,
                    border: '1px solid var(--t-panel-border)',
                    background: handoffExpanded ? THEME_ACCENT_SOFT : THEME_BG_CARD,
                    color: handoffExpanded ? THEME_ACCENT : 'var(--t-text-secondary)',
                    fontSize: 10,
                    fontWeight: 700,
                    letterSpacing: '0.02em',
                  cursor: 'pointer',
                }}
              >
                {handoffExpanded ? 'Hide details' : 'View details'}
              </button>
            ) : null}
          </div>

          {handoffExpanded && (displayAction || displayPreviewLines.length || displayChangedFiles.length) ? (
            <div style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              padding: '10px 12px',
              borderRadius: 12,
              background: THEME_PANEL_GLASS,
              border: '1px solid var(--t-panel-border)',
            }}>
              {displayAction ? (
                <div>
                  <div style={{
                    fontSize: 10,
                    fontWeight: 700,
                    color: 'var(--t-text-muted)',
                    textTransform: 'uppercase',
                    letterSpacing: '0.04em',
                    marginBottom: 4,
                  }}>
                    Delivery
                  </div>
                  <div style={{
                    fontSize: 11,
                    color: 'var(--t-text-secondary)',
                    lineHeight: 1.5,
                  }}>
                    {displayAction}
                  </div>
                </div>
              ) : null}

              {displayChangedFiles.length ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <div style={{
                    fontSize: 10,
                    fontWeight: 700,
                    color: 'var(--t-text-muted)',
                    textTransform: 'uppercase',
                    letterSpacing: '0.04em',
                  }}>
                    Changed Files
                  </div>
                  {displayChangedFiles.map((filePath) => (
                    <div
                      key={filePath}
                      style={CHANGED_FILE_STYLE}
                    >
                      {filePath}
                    </div>
                  ))}
                </div>
              ) : null}

              {displayPreviewLines.length ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <div style={{
                    fontSize: 10,
                    fontWeight: 700,
                    color: 'var(--t-text-muted)',
                    textTransform: 'uppercase',
                    letterSpacing: '0.04em',
                  }}>
                    Payload Preview
                  </div>
                  <div style={{
                    padding: '8px 10px',
                    borderRadius: 10,
                    background: THEME_BG_CARD,
                    border: '1px solid var(--t-panel-border)',
                    fontSize: 11,
                    lineHeight: 1.5,
                    color: 'var(--t-text-secondary)',
                    fontFamily: '"SF Mono", ui-monospace, monospace',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                  }}>
                    {displayPreviewLines.join('\n')}
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </article>
    );
  }

  if (isUser) {
    return (
      <div className={`remodex-user-turn-wrap${isNew ? ' remodex-turn-new' : ''}`}>
        {hasText ? (
          <div
            className="remodex-user-bubble"
            style={isSlashCommand ? {
              background: 'rgba(15, 23, 42, 0.92)',
              color: '#f8fafc',
              border: '1px solid rgba(148, 163, 184, 0.18)',
            } : undefined}
          >
            {isSlashCommand ? (
              <div style={{ marginBottom: 6, fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#93c5fd' }}>
                Slash Command
              </div>
            ) : null}
            <div
              className="remodex-rich-text"
              style={isSlashCommand ? { fontFamily: '"SF Mono", ui-monospace, monospace', fontSize: '0.88rem' } : undefined}
            >
              {displayText.split('\n').map((line, i) => (
                <p key={i} className="remodex-rich-paragraph">{line}</p>
              ))}
            </div>
          </div>
        ) : null}
        {hasMedia ? (
          <div className="remodex-media-grid remodex-media-grid-right">
            {entry.media!.map((item) =>
              isImageMedia(item) ? (
                <div key={item.path} className="remodex-media-card remodex-media-card-image">
                  <Image src={mediaHref(item.path)} alt={item.name} width={1200} height={900} unoptimized loading="lazy" />
                </div>
              ) : null
            )}
          </div>
        ) : null}
        {showTimestamp ? (
          <span className="remodex-turn-time">
            {entry.id.startsWith('local-') ? (
              <span style={{ color: 'var(--t-text-muted)', fontStyle: 'italic' }}>Sending...</span>
            ) : (
              entry.timestampLabel ?? 'now'
            )}
          </span>
        ) : null}
      </div>
    );
  }

  const collapsedOperator = shouldCollapseOperatorEntry(entry) ? buildOperatorSummary(entry.text) : null;

  if (!isUser && collapsedOperator && !operatorExpanded) {
    return (
      <article className={`remodex-message-card remodex-message-card-assistant${isNew ? ' remodex-turn-new' : ''}`}>
        {speakerChanged ? (
          <div className="remodex-message-head">
            <span>{roleLabel(entry.role, agentName)}</span>
          </div>
        ) : null}
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
          padding: '2px 0',
        }}>
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
          }}>
            <span style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 28,
              height: 28,
              borderRadius: 10,
              background: THEME_BG_CARD,
              color: 'var(--t-text-secondary)',
              flexShrink: 0,
            }}>
              <SlidersHorizontal size={14} strokeWidth={2.1} />
            </span>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{
                fontSize: 12,
                fontWeight: 700,
                color: 'var(--t-text)',
                letterSpacing: '-0.01em',
              }}>
                Operator summary
              </div>
              <div style={{
                marginTop: 3,
                fontSize: 12,
                lineHeight: 1.55,
                color: 'var(--t-text-secondary)',
              }}>
                {collapsedOperator.headline}
              </div>
            </div>
          </div>

          {collapsedOperator.details.length > 0 ? (
            <div style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 4,
              paddingLeft: 38,
            }}>
              {collapsedOperator.details.map((detail) => (
                <div
                  key={detail}
                  style={OPERATOR_DETAIL_STYLE}
                >
                  {detail}
                </div>
              ))}
            </div>
          ) : null}

          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            paddingLeft: 38,
          }}>
            <span style={{
              fontSize: 10,
              color: 'var(--t-text-muted)',
              fontWeight: 700,
              textTransform: 'uppercase',
              letterSpacing: '0.04em',
            }}>
              {collapsedOperator.stats}
            </span>
            <button
              type="button"
              onClick={() => setOperatorExpanded(true)}
              style={{
                border: '1px solid rgba(148, 163, 184, 0.16)',
                borderRadius: 999,
                background: THEME_BG_CARD,
                color: 'var(--t-text-secondary)',
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: '0.02em',
                padding: '4px 9px',
                cursor: 'pointer',
              }}
            >
              View full note
            </button>
          </div>
        </div>
      </article>
    );
  }

  return (
    <article className={`remodex-message-card remodex-message-card-assistant${isNew ? ' remodex-turn-new' : ''}`}>
      {speakerChanged ? (
        <div className="remodex-message-head">
          <span>{roleLabel(entry.role, agentName)}</span>
        </div>
      ) : null}
      {hasText ? (
        <div className="remodex-rich-text">
          {entry.role === 'assistant' ? (
            mdBlocks.map((block, idx) => (
              <div
                key={idx}
                onClick={() => handleBlockClick(idx)}
                style={{
                  cursor: 'pointer',
                  borderLeft: activeBlock !== null && idx >= activeBlock
                    ? '2px solid #2563eb'
                    : '2px solid transparent',
                  paddingLeft: 8,
                  marginLeft: -10,
                  borderRadius: 2,
                  transition: 'border-color 200ms ease, background 200ms ease',
                  background: activeBlock === idx ? THEME_ACCENT_SOFT : 'transparent',
                }}
                title="Click to play from here"
              >
                {block.element}
              </div>
            ))
          ) : (
            mdBlocks.map(b => b.element)
          )}
        </div>
      ) : null}
      {hasMedia ? (
        <div className="remodex-media-grid">
          {entry.media!.map((item) =>
            isImageMedia(item) ? (
              <div key={item.path} className="remodex-media-card remodex-media-card-image">
                <Image src={mediaHref(item.path)} alt={item.name} width={1200} height={900} unoptimized loading="lazy" />
              </div>
            ) : null
          )}
        </div>
      ) : null}
      {hasToolCalls ? (
        <CollapsibleToolCalls
          toolCalls={entry.toolCalls ?? []}
          marginTop={hasText || hasMedia ? 12 : 0}
        />
      ) : null}
      {entry.role === 'assistant' && hasText ? (
        <MessageActions messageId={entry.id} messageText={displayText} />
      ) : null}
      {collapsedOperator ? (
        <div style={{ marginTop: 8 }}>
          <button
            type="button"
            onClick={() => setOperatorExpanded(false)}
            style={{
              border: 'none',
              background: 'transparent',
              color: '#64748b',
              fontSize: 11,
              fontWeight: 600,
              cursor: 'pointer',
              padding: 0,
            }}
          >
            Collapse note
          </button>
        </div>
      ) : null}
    </article>
  );
});

function CollapsibleToolCalls({ toolCalls, marginTop }: { toolCalls: MobileTranscriptToolCall[]; marginTop: number }) {
  const [expanded, setExpanded] = useState(false);
  const count = toolCalls.length;
  const doneCount = toolCalls.filter((t) => t.status === 'done' || !t.status).length;
  const allDone = doneCount === count;
  const summary = allDone
    ? `${count} tool call${count === 1 ? '' : 's'}`
    : `${doneCount}/${count} tool calls`;

  return (
    <div style={{ marginTop }}>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '5px 10px',
          borderRadius: 8,
          border: '1px solid var(--t-divider-subtle)',
          background: expanded ? 'var(--t-hover)' : 'transparent',
          color: 'var(--t-text-secondary)',
          fontSize: 11,
          fontWeight: 600,
          fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
          cursor: 'pointer',
          letterSpacing: '-0.01em',
          transition: 'background 120ms ease',
        }}
        onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--t-hover)'; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = expanded ? 'var(--t-hover)' : 'transparent'; }}
      >
        <ChevronRight
          size={12}
          strokeWidth={2}
          style={{
            transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
            transition: 'transform 150ms ease',
            flexShrink: 0,
          }}
        />
        <span style={{ color: allDone ? '#10b981' : 'var(--t-accent, #2563eb)' }}>
          {summary}
        </span>
      </button>
      {expanded ? (
        <div style={{ marginTop: 8 }}>
          <DesktopToolCallStack toolCalls={toolCalls} />
        </div>
      ) : null}
    </div>
  );
}
