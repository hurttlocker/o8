'use client';

import { useState, useMemo, memo } from 'react';
import type { MobileInboxSnapshot, MobileInboxItem } from '@/lib/mobile/types';
import type { AgentSummary } from '@/lib/fleet/types';

interface ActivityFeedProps {
  snapshot: MobileInboxSnapshot;
  onBack: () => void;
  onAgentSelect: (sessionKey: string) => void;
  onApprove: (item: MobileInboxItem) => void;
  onDeny: (item: MobileInboxItem) => void;
  onReviewPR?: (repoPath: string, prNumber: number) => void;
}

type ActivityFilter = 'all' | 'approvals' | 'alerts' | 'agents' | 'reviews';

function formatRelativeTime(isoDate: string): string {
  const diff = Date.now() - new Date(isoDate).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function ApprovalCard({ item, onApprove, onDeny }: {
  item: MobileInboxItem;
  onApprove: () => void;
  onDeny: () => void;
}) {
  return (
    <div style={{
      padding: '14px 16px',
      borderRadius: 16,
      background: 'rgba(255,149,0,0.04)',
      border: '1px solid rgba(255,149,0,0.12)',
      backdropFilter: 'blur(20px) saturate(1.6)',
      WebkitBackdropFilter: 'blur(20px) saturate(1.6)',
      width: '100%',
      boxSizing: 'border-box',
      overflow: 'hidden',
    }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        marginBottom: 8,
      }}>
        <span style={{
          width: 28, height: 28, borderRadius: 8,
          background: 'rgba(255,149,0,0.1)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
            stroke="#ff9500" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
          </svg>
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <span style={{
            fontSize: 14, fontWeight: 700, color: '#0a0a0a',
            fontFamily: '-apple-system, system-ui, sans-serif',
          }}>
            Approval Required
          </span>
        </div>
        <span style={{ fontSize: 11, color: '#8e8e93' }}>
          {item.timestampLabel || ''}
        </span>
      </div>

      {/* Title */}
      <p style={{
        margin: '0 0 6px', fontSize: 13, fontWeight: 600,
        color: '#1a1a1a', lineHeight: 1.4,
      }}>
        {item.title}
      </p>

      {/* Detail */}
      <p style={{
        margin: '0 0 12px', fontSize: 12, color: '#64748b',
        lineHeight: 1.4,
        overflow: 'hidden', textOverflow: 'ellipsis',
        display: '-webkit-box', WebkitLineClamp: 3,
        WebkitBoxOrient: 'vertical' as const,
      }}>
        {item.detail}
      </p>

      {/* Action buttons */}
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          type="button"
          onClick={onApprove}
          style={{
            flex: 1, padding: '10px',
            borderRadius: 10, border: 'none',
            background: '#34c759', color: '#fff',
            fontSize: 13, fontWeight: 700,
            cursor: 'pointer',
            WebkitTapHighlightColor: 'transparent',
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4,
          }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="20 6 9 17 4 12" />
          </svg>
          Approve
        </button>
        <button
          type="button"
          onClick={onDeny}
          style={{
            flex: 1, padding: '10px',
            borderRadius: 10,
            border: '1px solid rgba(255,59,48,0.15)',
            background: 'rgba(255,59,48,0.06)',
            color: '#ff3b30',
            fontSize: 13, fontWeight: 700,
            cursor: 'pointer',
            WebkitTapHighlightColor: 'transparent',
          }}
        >
          Deny
        </button>
      </div>
    </div>
  );
}

function AlertCard({ item }: { item: MobileInboxItem }) {
  const isError = item.severity === 'critical';

  return (
    <div style={{
      padding: '12px 16px',
      borderRadius: 14,
      background: isError ? 'rgba(255,59,48,0.04)' : 'rgba(0,122,255,0.03)',
      border: `1px solid ${isError ? 'rgba(255,59,48,0.12)' : 'rgba(0,122,255,0.08)'}`,
      width: '100%',
      boxSizing: 'border-box',
      overflow: 'hidden',
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
      }}>
        <span style={{
          width: 24, height: 24, borderRadius: 6,
          background: isError ? 'rgba(255,59,48,0.1)' : 'rgba(0,122,255,0.08)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
            stroke={isError ? '#ff3b30' : '#007aff'}
            strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            {isError
              ? <><circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" /></>
              : <><circle cx="12" cy="12" r="10" /><line x1="12" y1="16" x2="12" y2="12" /><line x1="12" y1="8" x2="12.01" y2="8" /></>
            }
          </svg>
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{
            margin: 0, fontSize: 13, fontWeight: 600,
            color: '#0a0a0a',
          }}>
            {item.title}
          </p>
          <p style={{
            margin: '2px 0 0', fontSize: 11, color: '#8e8e93',
          }}>
            {item.detail.slice(0, 80)}{item.detail.length > 80 ? '…' : ''}
          </p>
        </div>
        <span style={{ fontSize: 10, color: '#c7c7cc', flexShrink: 0 }}>
          {item.timestampLabel || ''}
        </span>
      </div>
    </div>
  );
}

function AgentEventCard({ agent, onSelect }: { agent: AgentSummary; onSelect: () => void }) {
  const statusLabel = agent.status === 'running' ? 'Working' :
    agent.status === 'idle' ? 'Idle' :
    agent.status === 'failed' ? 'Failed' :
    agent.status === 'waiting' ? 'Waiting' : agent.status;
  const statusColor = agent.status === 'running' ? '#34c759' :
    agent.status === 'failed' ? '#ff3b30' :
    agent.status === 'waiting' ? '#ff9f0a' : '#8e8e93';

  return (
    <button
      type="button"
      onClick={onSelect}
      style={{
        width: '100%',
        padding: '12px 16px',
        borderRadius: 14,
        background: 'rgba(0,122,255,0.03)',
        border: '1px solid rgba(0,122,255,0.08)',
        display: 'flex', alignItems: 'center', gap: 10,
        cursor: 'pointer',
        WebkitTapHighlightColor: 'transparent',
        textAlign: 'left',
        boxSizing: 'border-box',
        overflow: 'hidden',
      }}
    >
      <span style={{
        width: 8, height: 8, borderRadius: '50%',
        background: statusColor,
        flexShrink: 0,
        boxShadow: agent.status === 'running' ? `0 0 6px ${statusColor}50` : 'none',
        animation: agent.status === 'running' ? 'activityPulse 2s ease-in-out infinite' : 'none',
      }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <span style={{
          fontSize: 14, fontWeight: 700, color: '#0a0a0a',
          fontFamily: '-apple-system, system-ui, sans-serif',
        }}>
          {agent.name}
        </span>
        <span style={{
          fontSize: 11, fontWeight: 600, color: statusColor,
          marginLeft: 6,
        }}>
          {statusLabel}
        </span>
        {agent.currentTask && (
          <p style={{
            margin: '2px 0 0', fontSize: 12, color: '#64748b',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {agent.currentTask}
          </p>
        )}
      </div>
      <span style={{ fontSize: 10, color: '#c7c7cc', flexShrink: 0 }}>
        {formatRelativeTime(agent.lastEventAt)}
      </span>
    </button>
  );
}

export const ActivityFeed = memo(function ActivityFeed({
  snapshot,
  onBack,
  onAgentSelect,
  onApprove,
  onDeny,
  onReviewPR,
}: ActivityFeedProps) {
  const [filter, setFilter] = useState<ActivityFilter>('all');

  const approvals = useMemo(() =>
    snapshot.items.filter(i => i.kind === 'approval'),
    [snapshot.items]
  );
  const alerts = useMemo(() =>
    snapshot.items.filter(i => i.kind === 'alert'),
    [snapshot.items]
  );
  const agentEvents = useMemo(() =>
    [...snapshot.sessions].sort((a, b) =>
      new Date(b.lastEventAt).getTime() - new Date(a.lastEventAt).getTime()
    ),
    [snapshot.sessions]
  );
  const reviewItems = useMemo(() =>
    snapshot.items.filter(i => i.kind === 'review'),
    [snapshot.items]
  );

  const FILTERS: { id: ActivityFilter; label: string; count: number }[] = [
    { id: 'all', label: 'All', count: approvals.length + alerts.length + agentEvents.length + reviewItems.length },
    { id: 'approvals', label: 'Approvals', count: approvals.length },
    { id: 'reviews', label: 'Reviews', count: reviewItems.length },
    { id: 'alerts', label: 'Alerts', count: alerts.length },
    { id: 'agents', label: 'Agents', count: agentEvents.length },
  ];

  return (
    <div style={{
      padding: '0 14px 24px',
      display: 'flex', flexDirection: 'column', gap: 14,
      width: '100%',
      maxWidth: '100%',
      boxSizing: 'border-box',
      overflow: 'hidden',
    }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        paddingTop: 8,
      }}>
        <div>
          <h2 style={{
            margin: 0, fontSize: 28, fontWeight: 800,
            fontFamily: '-apple-system, system-ui, sans-serif',
            color: '#0a0a0a', letterSpacing: '-0.03em',
          }}>
            Activity
          </h2>
          <p style={{
            margin: '2px 0 0', fontSize: 13,
            color: '#8e8e93', fontWeight: 500,
          }}>
            {approvals.length > 0
              ? `${approvals.length} pending approval${approvals.length !== 1 ? 's' : ''}`
              : 'All caught up'}
          </p>
        </div>
        <button
          type="button"
          onClick={onBack}
          style={{
            padding: '6px 14px', borderRadius: 10,
            background: 'rgba(0,122,255,0.08)',
            backdropFilter: 'blur(20px)',
            WebkitBackdropFilter: 'blur(20px)',
            border: '1px solid rgba(0,122,255,0.12)',
            color: '#007aff', fontSize: 13, fontWeight: 600,
            cursor: 'pointer',
            WebkitTapHighlightColor: 'transparent',
          }}
        >
          Done
        </button>
      </div>

      {/* Filter segmented control */}
      <div style={{
        display: 'flex', padding: 3,
        borderRadius: 10,
        background: 'rgba(0,122,255,0.04)',
        border: '1px solid rgba(0,122,255,0.08)',
        gap: 1,
        overflowX: 'auto',
        WebkitOverflowScrolling: 'touch',
        scrollbarWidth: 'none',
      }}>
        {FILTERS.map((f) => {
          const active = filter === f.id;
          return (
            <button
              key={f.id}
              type="button"
              onClick={() => setFilter(f.id)}
              style={{
                flex: '1 0 auto', padding: '7px 6px',
                borderRadius: 8, border: 'none',
                background: active ? '#fff' : 'transparent',
                boxShadow: active ? '0 1px 4px rgba(0,0,0,0.08)' : 'none',
                cursor: 'pointer',
                WebkitTapHighlightColor: 'transparent',
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 3,
                transition: 'all 200ms ease',
                minWidth: 0,
                whiteSpace: 'nowrap',
              }}
            >
              <span style={{
                fontSize: 10, fontWeight: 600,
                color: active ? '#0a0a0a' : '#8e8e93',
                fontFamily: '-apple-system, system-ui, sans-serif',
              }}>
                {f.label}
              </span>
              {f.count > 0 && (
                <span style={{
                  minWidth: 14, height: 14, borderRadius: 7,
                  padding: '0 3px',
                  background: active && f.id === 'approvals' ? '#ff9500' : active ? '#007aff' : 'rgba(0,0,0,0.06)',
                  color: active ? '#fff' : '#8e8e93',
                  fontSize: 9, fontWeight: 700,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>
                  {f.count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Approvals section */}
      {(filter === 'all' || filter === 'approvals') && approvals.length > 0 && (
        <section>
          {filter === 'all' && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 6,
              marginBottom: 8,
            }}>
              <span style={{
                width: 6, height: 6, borderRadius: '50%',
                background: '#ff9500',
              }} />
              <span style={{
                fontSize: 12, fontWeight: 700,
                color: '#ff9500',
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
              }}>
                Pending Approvals
              </span>
            </div>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%', overflow: 'hidden' }}>
            {approvals.map((item) => (
              <ApprovalCard
                key={item.id}
                item={item}
                onApprove={() => onApprove(item)}
                onDeny={() => onDeny(item)}
              />
            ))}
          </div>
        </section>
      )}

      {/* Alerts section */}
      {(filter === 'all' || filter === 'alerts') && alerts.length > 0 && (
        <section>
          {filter === 'all' && (
            <span style={{
              display: 'block', fontSize: 12, fontWeight: 700,
              color: '#ff3b30',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              marginBottom: 8,
            }}>
              Alerts
            </span>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, width: '100%', overflow: 'hidden' }}>
            {alerts.map((item) => (
              <AlertCard key={item.id} item={item} />
            ))}
          </div>
        </section>
      )}

      {/* Reviews section */}
      {(filter === 'all' || filter === 'reviews') && reviewItems.length > 0 && (
        <section>
          {filter === 'all' && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 6,
              marginBottom: 8,
            }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#af52de' }} />
              <span style={{
                fontSize: 12, fontWeight: 700, color: '#af52de',
                textTransform: 'uppercase', letterSpacing: '0.05em',
              }}>
                Pull Requests
              </span>
            </div>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, width: '100%', overflow: 'hidden' }}>
            {reviewItems.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  // Extract PR number from title (e.g. "PR #123: title")
                  const match = item.title.match(/#(\d+)/);
                  if (match && onReviewPR && item.sessionKey) {
                    onReviewPR(item.sessionKey, parseInt(match[1]));
                  } else {
                    onAgentSelect(item.sessionKey || '');
                  }
                }}
                style={{
                  width: '100%', padding: '12px 16px',
                  borderRadius: 14,
                  background: 'rgba(175,82,222,0.03)',
                  border: '1px solid rgba(175,82,222,0.1)',
                  display: 'flex', alignItems: 'center', gap: 10,
                  cursor: 'pointer',
                  WebkitTapHighlightColor: 'transparent',
                  textAlign: 'left',
                  boxSizing: 'border-box',
                  overflow: 'hidden',
                }}
              >
                <span style={{
                  width: 28, height: 28, borderRadius: 8,
                  background: 'rgba(175,82,222,0.08)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  flexShrink: 0,
                }}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
                    stroke="#af52de" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="18" cy="18" r="3" />
                    <circle cx="6" cy="6" r="3" />
                    <path d="M13 6h3a2 2 0 0 1 2 2v7" />
                    <path d="M6 9v12" />
                  </svg>
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <p style={{ margin: 0, fontSize: 13, fontWeight: 600, color: '#0a0a0a' }}>
                    {item.title}
                  </p>
                  <p style={{
                    margin: '2px 0 0', fontSize: 11, color: '#8e8e93',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>
                    {item.detail}
                  </p>
                </div>
                <span style={{ fontSize: 10, color: '#c7c7cc', flexShrink: 0 }}>
                  {item.timestampLabel || ''}
                </span>
              </button>
            ))}
          </div>
        </section>
      )}

      {/* Agent activity section */}
      {(filter === 'all' || filter === 'agents') && agentEvents.length > 0 && (
        <section>
          {filter === 'all' && (
            <span style={{
              display: 'block', fontSize: 12, fontWeight: 700,
              color: '#007aff',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              marginBottom: 8,
            }}>
              Agent Activity
            </span>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, width: '100%', overflow: 'hidden' }}>
            {agentEvents.map((agent) => (
              <AgentEventCard
                key={agent.id}
                agent={agent}
                onSelect={() => onAgentSelect(agent.sessionKey)}
              />
            ))}
          </div>
        </section>
      )}

      {/* Empty state */}
      {approvals.length === 0 && alerts.length === 0 && agentEvents.length === 0 && (
        <div style={{
          padding: '40px 20px', textAlign: 'center',
        }}>
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none"
            stroke="rgba(0,122,255,0.2)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
            style={{ margin: '0 auto 12px' }}>
            <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
          </svg>
          <p style={{ fontSize: 15, fontWeight: 600, color: '#8e8e93', margin: 0 }}>
            No activity yet
          </p>
          <p style={{ fontSize: 12, color: '#c7c7cc', margin: '4px 0 0' }}>
            Agent events, approvals, and alerts will appear here.
          </p>
        </div>
      )}

      <style>{`
        @keyframes activityPulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.5; }
        }
      `}</style>
    </div>
  );
});
