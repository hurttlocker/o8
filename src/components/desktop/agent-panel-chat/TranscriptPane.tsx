'use client';

import React, { memo, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ChevronDown, FolderOpen, SlidersHorizontal } from '../lucide-shims';
import { DesktopToolCallStack } from '../DesktopAgentMessage';
import {
  THEME_ACCENT_SOFT,
  THEME_ACCENT,
  THEME_ACCENT_BORDER,
  THEME_BG_CARD,
  THEME_PANEL_GLASS,
  SOURCE_LINK_STYLE,
  SOURCE_CARD_SUMMARY_STYLE,
} from './constants';
import {
  sanitizeTranscriptText,
  chipStyles,
  dedupeTranscriptEntries,
  groupTranscriptTurns,
  groupTimestamp,
  summarizeAgentGroup,
  buildGroupSourceCards,
  looksLikeWorkspaceFile,
} from './shared';
import { renderMarkdownBlocks } from './markdown';
import { Bubble } from './Bubble';
import { SidebarApprovalCard } from './ApprovalCards';
import type {
  DesktopTranscriptPaneProps,
  AgentTurnGroupProps,
  ActiveTurnCardProps,
} from './types';

export const AgentTurnGroup = memo(function AgentTurnGroup({
  group,
  previousGroup,
  transcript,
  currentAgentName,
  getIsNewEntry,
  onOpenMermaid,
  onRunInTerminal,
  onOpenDiff,
  onOpenFile,
  currentWorkspace,
}: AgentTurnGroupProps) {
  const [expandedSourceId, setExpandedSourceId] = useState<string | null>(null);
  const previousTs = previousGroup ? groupTimestamp(previousGroup.entries) : undefined;
  const currentTs = groupTimestamp(group.entries);
  const showTimeSeparator = Boolean(
    previousTs && currentTs && Math.abs(currentTs - previousTs) >= 8 * 60 * 1000,
  );
  const showGroupLabel = group.entries.length > 1
    || group.entries.some((entry) => entry.role === 'system' || entry.toolCalls?.length);
  const groupSummary = useMemo(() => summarizeAgentGroup(group.entries), [group.entries]);
  const sourceCards = useMemo(() => buildGroupSourceCards(group.entries), [group.entries]);
  const expandedCard = sourceCards.find((card) => card.id === expandedSourceId) ?? null;
  const fileDetails = useMemo(
    () => (expandedCard?.details ?? []).filter(looksLikeWorkspaceFile).slice(0, 8),
    [expandedCard],
  );

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        marginTop: 2,
      }}
    >
      {showTimeSeparator || groupSummary.separatorLabel ? (
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            marginTop: 8,
            marginBottom: 2,
          }}>
          <div style={{ flex: 1, height: 1, background: 'var(--t-divider)' }} />
          <span style={{
            fontSize: 10,
            fontWeight: 700,
            color: 'var(--t-text-muted)',
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
            whiteSpace: 'nowrap',
          }}>
            {groupSummary.separatorLabel ?? groupSummary.timeLabel ?? 'run'}
          </span>
          <div style={{ flex: 1, height: 1, background: 'var(--t-divider)' }} />
        </div>
      ) : null}

      {showGroupLabel ? (
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          alignSelf: 'stretch',
        }}>
          <div style={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            gap: 6,
            alignSelf: 'flex-start',
            padding: '4px 0',
          }}>
            <span style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '4px 9px',
              borderRadius: 999,
              background: THEME_ACCENT_SOFT,
              color: THEME_ACCENT,
              fontSize: 10,
              fontWeight: 700,
              textTransform: 'uppercase',
              letterSpacing: '0.04em',
            }}>
              {currentAgentName}
              <span style={{ color: 'rgba(37, 99, 235, 0.5)' }}>{'\u2022'}</span>
              {group.entries.length} update{group.entries.length !== 1 ? 's' : ''}
            </span>
            {groupSummary.timeLabel ? (
              <span style={{
                fontSize: 10,
                color: 'var(--t-text-muted)',
                fontWeight: 600,
              }}>
                {groupSummary.timeLabel}
              </span>
            ) : null}
            {groupSummary.chips.map((chip) => (
              <span
                key={`${group.id}-${chip.label}`}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  padding: '4px 8px',
                  borderRadius: 999,
                  fontSize: 10,
                  fontWeight: 700,
                  letterSpacing: '0.02em',
                  ...chipStyles(chip.tone),
                }}
              >
                {chip.label}
              </span>
            ))}
          </div>

          {sourceCards.length > 0 ? (
            <div style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              maxWidth: '92%',
            }}>
              <div style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: 8,
              }}>
                {sourceCards.map((card) => (
                  <button
                    key={`${group.id}-${card.id}`}
                    type="button"
                    onClick={() => setExpandedSourceId((current) => current === card.id ? null : card.id)}
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'flex-start',
                      gap: 2,
                      minWidth: 120,
                      padding: '9px 10px',
                      borderRadius: 12,
                      border: '1px solid var(--t-panel-border)',
                      background: expandedSourceId === card.id ? THEME_PANEL_GLASS : THEME_BG_CARD,
                      boxShadow: expandedSourceId === card.id ? 'var(--t-panel-shadow)' : 'none',
                      transition: 'transform 180ms ease, box-shadow 180ms ease, background 180ms ease, border-color 180ms ease',
                      cursor: 'pointer',
                      textAlign: 'left',
                      animation: 'sidebarSourceCardIn 220ms ease-out',
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.transform = 'translateY(-1px)';
                      e.currentTarget.style.boxShadow = 'var(--t-panel-shadow)';
                      e.currentTarget.style.background = THEME_PANEL_GLASS;
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.transform = 'translateY(0)';
                      e.currentTarget.style.boxShadow = expandedSourceId === card.id ? 'var(--t-panel-shadow)' : 'none';
                      e.currentTarget.style.background = expandedSourceId === card.id ? THEME_PANEL_GLASS : THEME_BG_CARD;
                    }}
                  >
                    <span style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      padding: '3px 7px',
                      borderRadius: 999,
                      fontSize: 10,
                      fontWeight: 700,
                      letterSpacing: '0.02em',
                      ...chipStyles(card.tone),
                    }}>
                      {card.label}
                    </span>
                    <span style={SOURCE_CARD_SUMMARY_STYLE}>
                      {card.summary}
                    </span>
                  </button>
                ))}
              </div>

              {expandedSourceId ? (
                <div style={{
                  padding: '10px 12px',
                  borderRadius: 12,
                  background: 'rgba(255,255,255,0.88)',
                  border: '1px solid rgba(226, 232, 240, 0.95)',
                  boxShadow: '0 10px 24px rgba(15, 23, 42, 0.05)',
                  animation: 'sidebarSourceExpand 180ms ease-out',
                }}>
                  {(expandedCard?.links ?? []).length > 0 ? (
                    <div style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 6,
                      marginBottom: (expandedCard?.details ?? []).length > 0 ? 10 : 0,
                    }}>
                      <div style={{
                        fontSize: 10,
                        fontWeight: 700,
                        color: '#64748b',
                        textTransform: 'uppercase',
                        letterSpacing: '0.04em',
                      }}>
                        Sources
                      </div>
                      <div style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 6,
                      }}>
                        {(expandedCard?.links ?? []).map((link) => (
                          <a
                            key={link.href}
                            href={link.href}
                            target="_blank"
                            rel="noopener noreferrer"
                            style={SOURCE_LINK_STYLE}
                          >
                            {link.label}
                          </a>
                        ))}
                      </div>
                    </div>
                  ) : null}
                  {(expandedCard?.canOpenDiff && onOpenDiff) || (fileDetails.length > 0 && onOpenFile) ? (
                    <div style={{
                      display: 'flex',
                      flexWrap: 'wrap',
                      gap: 8,
                      justifyContent: 'flex-start',
                      marginBottom: (expandedCard?.details ?? []).length > 0 ? 10 : 0,
                    }}>
                      {expandedCard?.canOpenDiff && onOpenDiff ? (
                        <button
                          type="button"
                          onClick={onOpenDiff}
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 6,
                            padding: '7px 10px',
                            borderRadius: 10,
                            border: '1px solid rgba(37, 99, 235, 0.14)',
                            background: 'rgba(37, 99, 235, 0.06)',
                            color: '#2563eb',
                            fontSize: 11,
                            fontWeight: 700,
                            cursor: 'pointer',
                            transition: 'transform 160ms ease, box-shadow 160ms ease',
                          }}
                        >
                          <SlidersHorizontal size={12} strokeWidth={2} />
                          Open diff sheet
                        </button>
                      ) : null}
                      {fileDetails.length > 0 && onOpenFile ? (
                        <button
                          type="button"
                          onClick={() => onOpenFile(fileDetails[0], currentWorkspace)}
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 6,
                            padding: '7px 10px',
                            borderRadius: 10,
                            border: '1px solid rgba(16, 185, 129, 0.16)',
                            background: 'rgba(16, 185, 129, 0.08)',
                            color: '#047857',
                            fontSize: 11,
                            fontWeight: 700,
                            cursor: 'pointer',
                          }}
                        >
                          <FolderOpen size={12} strokeWidth={2} />
                          Open file
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                  {(expandedCard?.details ?? []).length > 0 ? (
                    <div style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 4,
                    }}>
                      {(expandedCard?.details ?? []).map((detail) => {
                        const isFile = looksLikeWorkspaceFile(detail);
                        if (isFile && onOpenFile) {
                          return (
                            <button
                              key={detail}
                              type="button"
                              onClick={() => onOpenFile(detail, currentWorkspace)}
                              style={{
                                display: 'block',
                                width: '100%',
                                padding: '7px 8px',
                                borderRadius: 9,
                                border: '1px solid rgba(226, 232, 240, 0.95)',
                                background: 'rgba(248,250,252,0.78)',
                                textAlign: 'left',
                                cursor: 'pointer',
                              }}
                            >
                              <div
                                style={{
                                  fontSize: 11,
                                  color: '#2563eb',
                                  lineHeight: 1.45,
                                  wordBreak: 'break-word',
                                  fontFamily: '"SF Mono", ui-monospace, monospace',
                                }}
                              >
                                {detail}
                              </div>
                            </button>
                          );
                        }
                        return (
                          <div
                          key={detail}
                          style={{
                            fontSize: 11,
                            color: '#475569',
                            lineHeight: 1.45,
                            wordBreak: 'break-word',
                            fontFamily: detail.includes('/') ? '"SF Mono", ui-monospace, monospace' : 'inherit',
                          }}
                        >
                          {detail}
                        </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div style={{ fontSize: 11, color: '#64748b' }}>No additional detail available.</div>
                  )}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      <div style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        paddingLeft: showGroupLabel ? 10 : 0,
        marginLeft: showGroupLabel ? 4 : 0,
        borderLeft: showGroupLabel ? '2px solid rgba(37, 99, 235, 0.10)' : 'none',
      }}>
        {group.entries.map((entry) => {
          const entryIndex = transcript.findIndex((candidate) => candidate.id === entry.id);
          const isNew = getIsNewEntry(entry.id);
          return (
            <Bubble
              key={entry.id}
              entry={entry}
              previousEntry={entryIndex > 0 ? transcript[entryIndex - 1] : null}
              agentName={currentAgentName}
              isNew={isNew}
              onOpenMermaid={onOpenMermaid}
              onRunInTerminal={onRunInTerminal}
            />
          );
        })}
      </div>
    </div>
  );
});

export const ActiveTurnCard = memo(function ActiveTurnCard({
  agentName,
  text,
  activityHeadline,
  liveToolCalls,
  onOpenMermaid,
  onRunInTerminal,
}: ActiveTurnCardProps) {
  const safeActivityHeadline = activityHeadline ? sanitizeTranscriptText(activityHeadline) : undefined;
  const mdBlocks = useMemo(
    () => text.trim() ? renderMarkdownBlocks(sanitizeTranscriptText(text), onOpenMermaid, onRunInTerminal) : [],
    [text, onOpenMermaid, onRunInTerminal],
  );

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      gap: 10,
      maxWidth: '92%',
      padding: '12px 14px',
      borderRadius: 18,
      background: 'linear-gradient(180deg, var(--t-panel) 0%, var(--t-panel-translucent) 100%)',
      border: `1px solid ${THEME_ACCENT_BORDER}`,
      boxShadow: 'var(--t-panel-shadow)',
      animation: 'sidebarActiveTurnIn 220ms ease-out',
      transition: 'box-shadow 180ms ease, border-color 180ms ease, transform 180ms ease',
    }}>
      <div style={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: 8,
      }}>
        <span style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          padding: '4px 9px',
          borderRadius: 999,
          background: THEME_ACCENT_SOFT,
          color: THEME_ACCENT,
          fontSize: 10,
          fontWeight: 700,
          textTransform: 'uppercase',
          letterSpacing: '0.04em',
        }}>
          {agentName}
          <span style={{ color: 'rgba(37, 99, 235, 0.45)' }}>{'\u2022'}</span>
          active turn
        </span>
        {safeActivityHeadline ? (
          <span style={{
            fontSize: 11,
            color: 'var(--t-text-secondary)',
            fontWeight: 600,
            lineHeight: 1.4,
          }}>
            {safeActivityHeadline}
          </span>
        ) : null}
      </div>

      {liveToolCalls.length > 0 ? (
        <DesktopToolCallStack toolCalls={liveToolCalls} />
      ) : null}

      {mdBlocks.length > 0 ? (
        <div className="remodex-rich-text">
          {mdBlocks.map((block, index) => (
            <div key={`active-${index}`}>
              {block.element}
            </div>
          ))}
          <span style={{
            display: 'inline-block',
            width: 6,
            height: 14,
            background: 'var(--t-text)',
            opacity: 0.35,
            marginLeft: 2,
            animation: 'blink 1s step-end infinite',
            verticalAlign: 'text-bottom',
          }} />
        </div>
      ) : (
        <div style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          color: 'var(--t-text-secondary)',
          fontSize: 12,
          fontWeight: 500,
        }}>
          <span className="remodex-typing-dot" style={{ animationDelay: '0ms' }} />
          <span className="remodex-typing-dot" style={{ animationDelay: '150ms' }} />
          <span className="remodex-typing-dot" style={{ animationDelay: '300ms' }} />
          <span>{agentName} is thinking...</span>
        </div>
      )}
    </div>
  );
});

export const DesktopTranscriptPane = memo(function DesktopTranscriptPane({
  loading,
  transcript,
  currentAgentName,
  onOpenMermaid,
  onRunInTerminal,
  streamingText,
  agentRunning,
  activityHeadline,
  liveToolCalls = [],
  onOpenDiff,
  onOpenFile,
  currentWorkspace,
  runtimeCapabilities,
  approvals,
  resolvingApprovalId,
  onResolveApproval,
  scrollRef,
  handleScroll,
  showScrollPill,
  scrollToBottom,
  getIsNewEntry,
  topInset = 12,
}: DesktopTranscriptPaneProps) {
  const supportsLiveText = runtimeCapabilities.supportsLiveText;
  const supportsToolEvents = runtimeCapabilities.supportsToolEvents;
  const normalizedTranscript = useMemo(() => dedupeTranscriptEntries(transcript), [transcript]);

  const activeTranscriptEntry = useMemo(() => {
    if (!agentRunning || !supportsLiveText) return null;
    const last = normalizedTranscript[normalizedTranscript.length - 1];
    if (!last || last.role !== 'assistant') return null;
    if (!last.id.startsWith('claude-') && !last.id.startsWith('codex-')) return null;
    return last;
  }, [agentRunning, normalizedTranscript, supportsLiveText]);

  const visibleTranscript = useMemo(
    () => activeTranscriptEntry
      ? normalizedTranscript.filter((entry) => entry.id !== activeTranscriptEntry.id)
      : normalizedTranscript,
    [activeTranscriptEntry, normalizedTranscript],
  );

  const groupedTranscript = useMemo(() => groupTranscriptTurns(visibleTranscript), [visibleTranscript]);
  const activeTurnText = supportsLiveText ? (streamingText || activeTranscriptEntry?.text || '') : '';
  const showActiveTurn = Boolean(
    (supportsLiveText && (agentRunning || activeTurnText))
    || (supportsToolEvents && liveToolCalls.length > 0)
    || Boolean(activityHeadline),
  );

  // Virtualize the transcript list — only render visible groups + overscan buffer
  const scrollElementRef = useRef<HTMLDivElement | null>(null);
  const virtualizer = useVirtualizer({
    count: groupedTranscript.length,
    getScrollElement: () => scrollElementRef.current,
    estimateSize: () => 80,
    overscan: 6,
    getItemKey: (index) => groupedTranscript[index]?.id ?? String(index),
  });

  // Merge the external scrollRef with our internal ref
  const setScrollRef = (el: HTMLDivElement | null) => {
    scrollElementRef.current = el;
    if (scrollRef && 'current' in scrollRef) {
      (scrollRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
    }
  };

  const shouldVirtualize = groupedTranscript.length > 20;

  return (
    <div style={{ position: 'relative', flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div
        ref={setScrollRef}
        onScroll={handleScroll}
        className="remodex-message-stack"
        style={{
          flex: 1,
          overflowY: 'auto',
          paddingTop: topInset,
          paddingRight: 14,
          paddingBottom: 12,
          paddingLeft: 14,
        }}
      >
        {loading ? (
          <div className="remodex-skeleton-stack">
            <div className="remodex-skeleton-bubble remodex-skeleton-assistant" />
            <div className="remodex-skeleton-bubble remodex-skeleton-user" />
            <div className="remodex-skeleton-bubble remodex-skeleton-assistant remodex-skeleton-wide" />
            <div className="remodex-skeleton-bubble remodex-skeleton-user remodex-skeleton-short" />
          </div>
        ) : visibleTranscript.length === 0 && !showActiveTurn ? (
          <div
            className="remodex-loading-card"
            style={{
              maxWidth: 340,
              marginRight: 'auto',
              marginLeft: 'auto',
              textAlign: 'center',
              lineHeight: 1.6,
            }}
          >
            This lane appears here as it starts working. Send the first note below and the panel will fill itself in.
          </div>
        ) : shouldVirtualize ? (
          <div style={{ height: virtualizer.getTotalSize(), width: '100%', position: 'relative' }}>
            {virtualizer.getVirtualItems().map((virtualItem) => {
              const group = groupedTranscript[virtualItem.index];
              return (
                <div
                  key={virtualItem.key}
                  ref={virtualizer.measureElement}
                  data-index={virtualItem.index}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${virtualItem.start}px)`,
                  }}
                >
                  {group.kind !== 'agent' ? (
                    group.entries.map((entry) => {
                      const entryIndex = normalizedTranscript.findIndex((c) => c.id === entry.id);
                      return (
                        <Bubble
                          key={entry.id}
                          entry={entry}
                          previousEntry={entryIndex > 0 ? normalizedTranscript[entryIndex - 1] : null}
                          agentName={currentAgentName}
                          isNew={getIsNewEntry(entry.id)}
                          onOpenMermaid={onOpenMermaid}
                          onRunInTerminal={onRunInTerminal}
                        />
                      );
                    })
                  ) : (
                    <AgentTurnGroup
                      group={group}
                      previousGroup={virtualItem.index > 0 ? groupedTranscript[virtualItem.index - 1] : null}
                      transcript={normalizedTranscript}
                      currentAgentName={currentAgentName}
                      getIsNewEntry={getIsNewEntry}
                      onOpenMermaid={onOpenMermaid}
                      onRunInTerminal={onRunInTerminal}
                      onOpenDiff={onOpenDiff}
                      onOpenFile={onOpenFile}
                      currentWorkspace={currentWorkspace}
                    />
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          groupedTranscript.map((group, groupIndex) => {
            if (group.kind !== 'agent') {
              return group.entries.map((entry) => {
                const entryIndex = normalizedTranscript.findIndex((candidate) => candidate.id === entry.id);
                const isNew = getIsNewEntry(entry.id);
                return (
                  <Bubble
                    key={entry.id}
                    entry={entry}
                    previousEntry={entryIndex > 0 ? normalizedTranscript[entryIndex - 1] : null}
                    agentName={currentAgentName}
                    isNew={isNew}
                    onOpenMermaid={onOpenMermaid}
                    onRunInTerminal={onRunInTerminal}
                  />
                );
              });
            }

            return (
              <AgentTurnGroup
                key={group.id}
                group={group}
                previousGroup={groupIndex > 0 ? groupedTranscript[groupIndex - 1] : null}
                transcript={normalizedTranscript}
                currentAgentName={currentAgentName}
                getIsNewEntry={getIsNewEntry}
                onOpenMermaid={onOpenMermaid}
                onRunInTerminal={onRunInTerminal}
                onOpenDiff={onOpenDiff}
                onOpenFile={onOpenFile}
                currentWorkspace={currentWorkspace}
              />
            );
          })
        )}

      {showActiveTurn && (
          <div style={{
            display: 'flex',
            paddingTop: 8,
            paddingRight: 16,
            paddingBottom: 12,
            paddingLeft: 16,
          }}>
            <ActiveTurnCard
              agentName={currentAgentName}
              text={activeTurnText}
              activityHeadline={activityHeadline}
              liveToolCalls={liveToolCalls}
              onOpenMermaid={onOpenMermaid}
              onRunInTerminal={onRunInTerminal}
            />
          </div>
        )}
      </div>

      <SidebarApprovalCard
        approvals={approvals}
        resolvingId={resolvingApprovalId}
        onResolve={onResolveApproval}
      />

      {showScrollPill && (
        <div style={{
          position: 'absolute',
          bottom: 8,
          left: '50%',
          transform: 'translateX(-50%)',
          zIndex: 10,
        }}>
          <button
            onClick={() => scrollToBottom(true)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              padding: '4px 10px',
              borderRadius: 10,
              border: '1px solid var(--t-panel-border)',
              background: THEME_PANEL_GLASS,
              backdropFilter: 'blur(20px) saturate(1.6)',
              WebkitBackdropFilter: 'blur(20px) saturate(1.6)',
              color: 'var(--t-text-secondary)',
              fontSize: 11,
              fontWeight: 600,
              cursor: 'pointer',
              letterSpacing: '-0.01em',
              boxShadow: 'var(--t-panel-shadow)',
              transition: 'all 150ms ease',
            }}
          >
            <ChevronDown size={11} />
            {'\u2193'}
          </button>
        </div>
      )}
    </div>
  );
});
