'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  RefreshCw,
  ShieldCheck,
} from './lucide-shims';
import type { ApprovalAuditEvent, ApprovalRecord, ApprovalRisk, OrchestratorReviewFinding } from '@/lib/approvals/types';

type TimeRangeOption = 'all' | '1h' | '24h' | '7d' | '30d';
type RiskFilter = 'all' | ApprovalRisk;

interface AuditTimelineItem {
  id: string;
  approvalId: string;
  title: string;
  sessionKey: string;
  risk: ApprovalRisk;
  timestamp: number;
  type: ApprovalAuditEvent['type'];
  actor: ApprovalAuditEvent['actor'];
  note?: string;
  findings?: OrchestratorReviewFinding[];
  reviewer?: string;
  approved?: boolean;
  diffSha?: string;
}

const POLL_INTERVAL = 30_000;
const MONO_FONT = '"SF Mono", ui-monospace, SFMono-Regular, Menlo, monospace';
const TIME_RANGE_WINDOWS: Record<TimeRangeOption, number | null> = {
  all: null,
  '1h': 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

const EVENT_TONES: Record<ApprovalAuditEvent['type'], { color: string; backgroundColor: string; borderColor: string }> = {
  created: {
    color: '#2563eb',
    backgroundColor: 'rgba(37, 99, 235, 0.12)',
    borderColor: 'rgba(37, 99, 235, 0.18)',
  },
  updated: {
    color: '#475569',
    backgroundColor: 'rgba(100, 116, 139, 0.12)',
    borderColor: 'rgba(100, 116, 139, 0.18)',
  },
  approved: {
    color: '#15803d',
    backgroundColor: 'rgba(34, 197, 94, 0.12)',
    borderColor: 'rgba(34, 197, 94, 0.18)',
  },
  rejected: {
    color: '#b91c1c',
    backgroundColor: 'rgba(239, 68, 68, 0.12)',
    borderColor: 'rgba(239, 68, 68, 0.18)',
  },
  resumed: {
    color: '#1d4ed8',
    backgroundColor: 'rgba(29, 78, 216, 0.12)',
    borderColor: 'rgba(29, 78, 216, 0.18)',
  },
  resume_failed: {
    color: '#c2410c',
    backgroundColor: 'rgba(249, 115, 22, 0.12)',
    borderColor: 'rgba(249, 115, 22, 0.18)',
  },
  orchestrator_review: {
    color: '#1d4ed8',
    backgroundColor: 'rgba(37, 99, 235, 0.12)',
    borderColor: 'rgba(37, 99, 235, 0.18)',
  },
  continuation_completed: { color: '#15803d', backgroundColor: 'rgba(34, 197, 94, 0.12)', borderColor: 'rgba(34, 197, 94, 0.18)' },
  continuation_failed: { color: '#b91c1c', backgroundColor: 'rgba(239, 68, 68, 0.12)', borderColor: 'rgba(239, 68, 68, 0.18)' },
  continuation_outcome_unknown: { color: '#c2410c', backgroundColor: 'rgba(249, 115, 22, 0.12)', borderColor: 'rgba(249, 115, 22, 0.18)' },
};

const RISK_TONES: Record<ApprovalRisk, { color: string; backgroundColor: string; borderColor: string }> = {
  high: {
    color: '#b91c1c',
    backgroundColor: 'rgba(239, 68, 68, 0.12)',
    borderColor: 'rgba(239, 68, 68, 0.18)',
  },
  medium: {
    color: '#b45309',
    backgroundColor: 'rgba(245, 158, 11, 0.12)',
    borderColor: 'rgba(245, 158, 11, 0.18)',
  },
  low: {
    color: '#1d4ed8',
    backgroundColor: 'rgba(37, 99, 235, 0.12)',
    borderColor: 'rgba(37, 99, 235, 0.18)',
  },
};

const FINDING_TONES: Record<OrchestratorReviewFinding['severity'], { color: string; backgroundColor: string; borderColor: string }> = {
  bug: {
    color: '#b91c1c',
    backgroundColor: 'rgba(239, 68, 68, 0.12)',
    borderColor: 'rgba(239, 68, 68, 0.18)',
  },
  rule_violation: {
    color: '#b45309',
    backgroundColor: 'rgba(245, 158, 11, 0.12)',
    borderColor: 'rgba(245, 158, 11, 0.18)',
  },
  note: {
    color: '#475569',
    backgroundColor: 'rgba(100, 116, 139, 0.12)',
    borderColor: 'rgba(100, 116, 139, 0.18)',
  },
};

const RESOLUTION_TONES: Record<OrchestratorReviewFinding['resolution'], { color: string; backgroundColor: string; borderColor: string }> = {
  fixed: {
    color: '#15803d',
    backgroundColor: 'rgba(34, 197, 94, 0.12)',
    borderColor: 'rgba(34, 197, 94, 0.18)',
  },
  accepted: {
    color: '#1d4ed8',
    backgroundColor: 'rgba(37, 99, 235, 0.12)',
    borderColor: 'rgba(37, 99, 235, 0.18)',
  },
  deferred: {
    color: '#c2410c',
    backgroundColor: 'rgba(249, 115, 22, 0.12)',
    borderColor: 'rgba(249, 115, 22, 0.18)',
  },
};

function formatEventType(type: ApprovalAuditEvent['type']) {
  switch (type) {
    case 'created':
      return 'Created';
    case 'updated':
      return 'Updated';
    case 'approved':
      return 'Approved';
    case 'rejected':
      return 'Rejected';
    case 'resumed':
      return 'Resumed';
    case 'resume_failed':
      return 'Resume Failed';
    case 'orchestrator_review':
      return 'Orchestrator Review';
  }
}

function formatActor(actor: ApprovalAuditEvent['actor']) {
  switch (actor) {
    case 'desktop':
      return 'Desktop';
    case 'mobile':
      return 'Mobile';
    case 'system':
      return 'System';
    case 'orchestrator':
      return 'Orchestrator';
    case 'test':
      return 'Test';
  }
}

function formatRisk(risk: ApprovalRisk) {
  return risk.charAt(0).toUpperCase() + risk.slice(1);
}

function formatTimestamp(timestamp: number) {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  }).format(timestamp);
}

function formatRelativeAge(timestamp: number) {
  const deltaMs = Math.max(0, Date.now() - timestamp);
  const deltaSeconds = Math.floor(deltaMs / 1000);

  if (deltaSeconds < 60) {
    return 'just now';
  }

  const deltaMinutes = Math.floor(deltaSeconds / 60);
  if (deltaMinutes < 60) {
    return `${deltaMinutes}m ago`;
  }

  const deltaHours = Math.floor(deltaMinutes / 60);
  if (deltaHours < 24) {
    return `${deltaHours}h ago`;
  }

  const deltaDays = Math.floor(deltaHours / 24);
  if (deltaDays < 30) {
    return `${deltaDays}d ago`;
  }

  return formatTimestamp(timestamp);
}

function filterWindowForRange(range: TimeRangeOption) {
  return TIME_RANGE_WINDOWS[range];
}

function formatFindingSeverity(severity: OrchestratorReviewFinding['severity']) {
  switch (severity) {
    case 'bug':
      return 'Bug';
    case 'rule_violation':
      return 'Rule Violation';
    case 'note':
      return 'Note';
  }
}

function formatFindingResolution(resolution: OrchestratorReviewFinding['resolution']) {
  switch (resolution) {
    case 'fixed':
      return 'Fixed';
    case 'accepted':
      return 'Accepted';
    case 'deferred':
      return 'Deferred';
  }
}

function formatVerdict(approved: boolean) {
  return approved ? 'Approved' : 'Changes Requested';
}

function formatFindingLocation(finding: OrchestratorReviewFinding) {
  return typeof finding.line === 'number' ? `${finding.file}:${finding.line}` : finding.file;
}

function flattenAuditTimeline(approvals: ApprovalRecord[]): AuditTimelineItem[] {
  return approvals
    .flatMap((approval) => {
      const auditEvents = Array.isArray(approval.audit) ? approval.audit : [];
      return auditEvents.map((event, index) => ({
        id: `${approval.id}:${typeof event.timestamp === 'number' ? event.timestamp : approval.updatedAt}:${event.type}:${index}`,
        approvalId: approval.id,
        title: approval.title,
        sessionKey: approval.sessionKey,
        risk: approval.risk,
        timestamp: typeof event.timestamp === 'number' ? event.timestamp : approval.updatedAt,
        type: event.type,
        actor: event.actor,
        note: event.note,
        findings: Array.isArray(event.findings) ? event.findings : undefined,
        reviewer: event.reviewer,
        approved: typeof event.approved === 'boolean' ? event.approved : undefined,
        diffSha: event.diffSha,
      }));
    })
    .sort((left, right) => right.timestamp - left.timestamp);
}

/* ---------------------------------------------------------------------------
 * Compact pill-style select for the filter bar
 * --------------------------------------------------------------------------- */
function PillSelect({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (value: string) => void;
  options: Array<{ label: string; value: string }>;
}) {
  return (
    <select
      value={value}
      onChange={(event) => onChange(event.target.value)}
      style={{
        minHeight: 44,
        minWidth: 44,
        borderRadius: 10,
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: 'rgba(0, 0, 0, 0.08)',
        backgroundColor: 'rgba(0, 0, 0, 0.03)',
        color: '#6b7280',
        fontSize: 12,
        fontWeight: 500,
        letterSpacing: '-0.01em',
        paddingTop: 0,
        paddingRight: 24,
        paddingBottom: 0,
        paddingLeft: 10,
        outline: 'none',
        cursor: 'pointer',
        appearance: 'none' as const,
        backgroundImage: `url("data:image/svg+xml,%3Csvg width='10' height='6' viewBox='0 0 10 6' fill='none' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M1 1L5 5L9 1' stroke='%239ca3af' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E")`,
        backgroundRepeat: 'no-repeat',
        backgroundPosition: 'right 8px center',
      } as React.CSSProperties}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

export function AuditLogPanel() {
  const mountedRef = useRef(true);
  const hasLoadedRef = useRef(false);
  const [approvals, setApprovals] = useState<ApprovalRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedSession, setSelectedSession] = useState('all');
  const [selectedRisk, setSelectedRisk] = useState<RiskFilter>('all');
  const [selectedRange, setSelectedRange] = useState<TimeRangeOption>('all');
  const [lastLoadedAt, setLastLoadedAt] = useState<number | null>(null);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadApprovals = useCallback(async (quiet: boolean) => {
    if (quiet && hasLoadedRef.current) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }

    try {
      const response = await fetch('/api/panel/approvals?status=all', {
        cache: 'no-store',
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json() as { approvals?: ApprovalRecord[] };
      if (!mountedRef.current) {
        return;
      }

      setApprovals(Array.isArray(data.approvals) ? data.approvals : []);
      setError(null);
      setLastLoadedAt(Date.now());
      hasLoadedRef.current = true;
    } catch (loadError) {
      if (!mountedRef.current) {
        return;
      }

      console.error('[audit-log] Failed to load approval audit log.', loadError);
      setError(loadError instanceof Error ? loadError.message : 'Unable to load the approval audit log.');
    } finally {
      if (!mountedRef.current) {
        return;
      }

      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void loadApprovals(false);

    const intervalId = window.setInterval(() => {
      void loadApprovals(true);
    }, POLL_INTERVAL);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [loadApprovals]);

  const timeline = useMemo(() => flattenAuditTimeline(approvals), [approvals]);

  const sessionOptions = useMemo(() => {
    return Array.from(new Set(timeline.map((item) => item.sessionKey)))
      .sort((left, right) => left.localeCompare(right));
  }, [timeline]);

  const filteredTimeline = useMemo(() => {
    const rangeWindow = filterWindowForRange(selectedRange);
    const lowerBound = rangeWindow == null ? null : Date.now() - rangeWindow;

    return timeline.filter((item) => {
      if (selectedSession !== 'all' && item.sessionKey !== selectedSession) {
        return false;
      }

      if (selectedRisk !== 'all' && item.risk !== selectedRisk) {
        return false;
      }

      if (lowerBound != null && item.timestamp < lowerBound) {
        return false;
      }

      return true;
    });
  }, [selectedRange, selectedRisk, selectedSession, timeline]);

  const riskCounts = useMemo(() => {
    return timeline.reduce<Record<ApprovalRisk, number>>((counts, item) => {
      counts[item.risk] += 1;
      return counts;
    }, { high: 0, medium: 0, low: 0 });
  }, [timeline]);

  const hasAnyEvents = timeline.length > 0;
  const hasActiveFilters = selectedSession !== 'all' || selectedRisk !== 'all' || selectedRange !== 'all';

  return (
    <div style={{
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      backgroundColor: 'var(--t-canvas-bg)',
      overflow: 'hidden',
    }}>
      {/* ---- Header ---- */}
      <div style={{
        flexShrink: 0,
        paddingTop: 32,
        paddingRight: 32,
        paddingBottom: 0,
        paddingLeft: 32,
      }}>
        {/* Editorial title + refresh */}
        <div style={{
          display: 'flex',
          alignItems: 'flex-end',
          justifyContent: 'space-between',
          gap: 16,
        }}>
          <div>
            <div style={{
              fontSize: 28,
              fontWeight: 300,
              color: '#6b7280',
              letterSpacing: '-0.03em',
              lineHeight: 1.2,
            }}>
              Audit Log.
            </div>
            <div style={{
              marginTop: 6,
              fontSize: 11,
              fontWeight: 500,
              letterSpacing: '0.06em',
              textTransform: 'uppercase' as const,
              color: '#8b95a3',
            }}>
              Approval Evidence Trail
            </div>
          </div>

          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
          }}>
            <span style={{
              fontSize: 11,
              color: '#8b95a3',
              letterSpacing: '-0.01em',
            }}>
              {lastLoadedAt ? `Updated ${formatRelativeAge(lastLoadedAt)}` : 'Waiting for sync'}
            </span>
            <button
              type="button"
              onClick={() => { void loadApprovals(true); }}
              disabled={refreshing}
              style={{
                minHeight: 44,
                minWidth: 44,
                borderRadius: 10,
                borderWidth: 0,
                borderStyle: 'none',
                backgroundColor: 'transparent',
                color: refreshing ? '#8b95a3' : '#6b7280',
                paddingTop: 4,
                paddingRight: 8,
                paddingBottom: 4,
                paddingLeft: 8,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 5,
                fontSize: 12,
                fontWeight: 500,
                letterSpacing: '-0.01em',
                cursor: refreshing ? 'default' : 'pointer',
              }}
            >
              <RefreshCw
                size={13}
                strokeWidth={2}
                style={refreshing ? {
                  animation: 'spin 1s linear infinite',
                } as React.CSSProperties : undefined}
              />
              {refreshing ? 'Refreshing' : 'Refresh'}
            </button>
          </div>
        </div>

        {/* ---- Stats row ---- */}
        <div style={{
          display: 'flex',
          alignItems: 'flex-end',
          gap: 0,
          marginTop: 28,
          paddingBottom: 20,
          borderBottomWidth: 1,
          borderBottomStyle: 'solid',
          borderBottomColor: 'rgba(0, 0, 0, 0.06)',
        }}>
          {/* Events stat */}
          <div style={{ minWidth: 0, paddingRight: 28 }}>
            <div style={{
              fontSize: 26,
              fontWeight: 600,
              letterSpacing: '-0.02em',
              color: '#111827',
              lineHeight: 1,
            }}>
              {timeline.length}
            </div>
            <div style={{
              marginTop: 4,
              fontSize: 11,
              fontWeight: 500,
              letterSpacing: '0.04em',
              textTransform: 'uppercase' as const,
              color: '#8b95a3',
            }}>
              Events
            </div>
          </div>

          {/* Divider */}
          <div style={{
            width: 1,
            height: 32,
            backgroundColor: 'rgba(0, 0, 0, 0.08)',
            flexShrink: 0,
          }} />

          {/* Sessions stat */}
          <div style={{ minWidth: 0, paddingRight: 28, paddingLeft: 28 }}>
            <div style={{
              fontSize: 26,
              fontWeight: 600,
              letterSpacing: '-0.02em',
              color: '#111827',
              lineHeight: 1,
            }}>
              {sessionOptions.length}
            </div>
            <div style={{
              marginTop: 4,
              fontSize: 11,
              fontWeight: 500,
              letterSpacing: '0.04em',
              textTransform: 'uppercase' as const,
              color: '#8b95a3',
            }}>
              Sessions
            </div>
          </div>

          {/* Divider */}
          <div style={{
            width: 1,
            height: 32,
            backgroundColor: 'rgba(0, 0, 0, 0.08)',
            flexShrink: 0,
          }} />

          {/* High risk stat */}
          <div style={{ minWidth: 0, paddingLeft: 28 }}>
            <div style={{
              fontSize: 26,
              fontWeight: 600,
              letterSpacing: '-0.02em',
              color: riskCounts.high > 0 ? '#b91c1c' : '#111827',
              lineHeight: 1,
            }}>
              {riskCounts.high}
            </div>
            <div style={{
              marginTop: 4,
              fontSize: 11,
              fontWeight: 500,
              letterSpacing: '0.04em',
              textTransform: 'uppercase' as const,
              color: '#8b95a3',
            }}>
              High Risk
            </div>
          </div>
        </div>

        {/* ---- Filters bar ---- */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          marginTop: 16,
          paddingBottom: 16,
          flexWrap: 'wrap',
        }}>
          <PillSelect
            value={selectedSession}
            onChange={setSelectedSession}
            options={[
              { label: 'All sessions', value: 'all' },
              ...sessionOptions.map((sessionKey) => ({ label: sessionKey, value: sessionKey })),
            ]}
          />
          <PillSelect
            value={selectedRisk}
            onChange={(value) => setSelectedRisk(value as RiskFilter)}
            options={[
              { label: 'All risks', value: 'all' },
              { label: 'High', value: 'high' },
              { label: 'Medium', value: 'medium' },
              { label: 'Low', value: 'low' },
            ]}
          />
          <PillSelect
            value={selectedRange}
            onChange={(value) => setSelectedRange(value as TimeRangeOption)}
            options={[
              { label: 'All time', value: 'all' },
              { label: 'Last hour', value: '1h' },
              { label: 'Last 24 hours', value: '24h' },
              { label: 'Last 7 days', value: '7d' },
              { label: 'Last 30 days', value: '30d' },
            ]}
          />
          {hasActiveFilters ? (
            <button
              type="button"
              onClick={() => {
                setSelectedSession('all');
                setSelectedRisk('all');
                setSelectedRange('all');
              }}
              style={{
                minHeight: 44,
                minWidth: 44,
                borderRadius: 10,
                borderWidth: 0,
                borderStyle: 'none',
                backgroundColor: 'transparent',
                color: '#2563eb',
                paddingTop: 4,
                paddingRight: 10,
                paddingBottom: 4,
                paddingLeft: 10,
                fontSize: 12,
                fontWeight: 500,
                letterSpacing: '-0.01em',
                cursor: 'pointer',
              }}
            >
              Clear filters
            </button>
          ) : null}
          <span style={{
            marginLeft: 'auto',
            fontSize: 11,
            color: '#8b95a3',
            letterSpacing: '-0.01em',
          }}>
            {filteredTimeline.length} event{filteredTimeline.length === 1 ? '' : 's'}
          </span>
        </div>

        {/* Error banner */}
        {error ? (
          <div style={{
            marginBottom: 12,
            borderRadius: 10,
            backgroundColor: 'rgba(239, 68, 68, 0.06)',
            color: '#b91c1c',
            paddingTop: 10,
            paddingRight: 14,
            paddingBottom: 10,
            paddingLeft: 14,
            fontSize: 12,
            lineHeight: 1.5,
          }}>
            Unable to refresh the audit log. {error}
          </div>
        ) : null}
      </div>

      {/* ---- Scrollable timeline ---- */}
      <div style={{
        flexGrow: 1,
        flexShrink: 1,
        flexBasis: 0,
        minHeight: 0,
        overflowY: 'auto',
        paddingTop: 4,
        paddingRight: 32,
        paddingBottom: 32,
        paddingLeft: 32,
      }}>
        {loading && !hasAnyEvents ? (
          <div style={{
            paddingTop: 64,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#8b95a3',
            fontSize: 13,
            fontWeight: 400,
            letterSpacing: '-0.01em',
          }}>
            Loading audit history...
          </div>
        ) : !hasAnyEvents ? (
          <div style={{
            paddingTop: 64,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            textAlign: 'center',
            gap: 12,
          }}>
            <ShieldCheck size={28} strokeWidth={1.5} style={{ color: '#8b95a3' }} />
            <div>
              <div style={{
                fontSize: 16,
                fontWeight: 400,
                letterSpacing: '-0.02em',
                color: '#6b7280',
              }}>
                No audit events yet
              </div>
              <p style={{
                marginTop: 6,
                marginRight: 0,
                marginBottom: 0,
                marginLeft: 0,
                maxWidth: 400,
                fontSize: 13,
                lineHeight: 1.6,
                color: '#8b95a3',
              }}>
                The audit trail populates as approvals are created, updated, approved, rejected, or resumed.
              </p>
            </div>
          </div>
        ) : filteredTimeline.length === 0 ? (
          <div style={{
            paddingTop: 64,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            textAlign: 'center',
            gap: 10,
          }}>
            <AlertCircle size={24} strokeWidth={1.5} style={{ color: '#8b95a3' }} />
            <div>
              <div style={{
                fontSize: 15,
                fontWeight: 400,
                letterSpacing: '-0.02em',
                color: '#6b7280',
              }}>
                No events match these filters
              </div>
              <p style={{
                marginTop: 4,
                marginRight: 0,
                marginBottom: 0,
                marginLeft: 0,
                maxWidth: 380,
                fontSize: 13,
                lineHeight: 1.6,
                color: '#8b95a3',
              }}>
                Broaden the session, risk, or time range to see more activity.
              </p>
            </div>
          </div>
        ) : (
          <div style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 0,
          }}>
            {filteredTimeline.map((item, itemIndex) => {
              const eventTone = EVENT_TONES[item.type];
              const riskTone = RISK_TONES[item.risk];
              const reviewVerdictTone = typeof item.approved === 'boolean'
                ? item.approved
                  ? EVENT_TONES.approved
                  : EVENT_TONES.rejected
                : null;
              const findings = item.findings ?? [];
              const isLast = itemIndex === filteredTimeline.length - 1;

              return (
                <div
                  key={item.id}
                  style={{
                    display: 'flex',
                    gap: 16,
                    paddingBottom: isLast ? 0 : 24,
                  }}
                >
                  {/* Timeline rail: dot + line */}
                  <div style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    width: 20,
                    flexShrink: 0,
                    paddingTop: 2,
                  }}>
                    <div style={{
                      width: 8,
                      height: 8,
                      borderRadius: 999,
                      backgroundColor: eventTone.color,
                      flexShrink: 0,
                      opacity: 0.7,
                    }} />
                    {!isLast ? (
                      <div style={{
                        width: 1,
                        flexGrow: 1,
                        backgroundColor: 'rgba(0, 0, 0, 0.06)',
                        marginTop: 6,
                      }} />
                    ) : null}
                  </div>

                  {/* Event content */}
                  <div style={{
                    minWidth: 0,
                    flexGrow: 1,
                    paddingBottom: isLast ? 0 : 24,
                    borderBottomWidth: isLast ? 0 : 1,
                    borderBottomStyle: 'solid',
                    borderBottomColor: 'rgba(0, 0, 0, 0.04)',
                  }}>
                    {/* Title row */}
                    <div style={{
                      display: 'flex',
                      alignItems: 'flex-start',
                      justifyContent: 'space-between',
                      gap: 12,
                      flexWrap: 'wrap',
                    }}>
                      <div style={{ minWidth: 0, flexGrow: 1 }}>
                        <div style={{
                          fontSize: 14,
                          fontWeight: 600,
                          letterSpacing: '-0.02em',
                          color: '#111827',
                          lineHeight: 1.4,
                        }}>
                          {item.title}
                        </div>
                        <div style={{
                          marginTop: 3,
                          fontSize: 12,
                          color: '#8b95a3',
                          letterSpacing: '-0.01em',
                        }}>
                          {formatTimestamp(item.timestamp)} · {formatRelativeAge(item.timestamp)}
                        </div>
                      </div>

                      {/* Badges */}
                      <div style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 6,
                        flexWrap: 'wrap',
                        flexShrink: 0,
                      }}>
                        <span style={{
                          borderRadius: 10,
                          backgroundColor: eventTone.backgroundColor,
                          color: eventTone.color,
                          fontSize: 11,
                          fontWeight: 600,
                          paddingTop: 3,
                          paddingRight: 8,
                          paddingBottom: 3,
                          paddingLeft: 8,
                          letterSpacing: '-0.01em',
                        }}>
                          {formatEventType(item.type)}
                        </span>
                        {reviewVerdictTone ? (
                          <span style={{
                            borderRadius: 10,
                            backgroundColor: reviewVerdictTone.backgroundColor,
                            color: reviewVerdictTone.color,
                            fontSize: 11,
                            fontWeight: 600,
                            paddingTop: 3,
                            paddingRight: 8,
                            paddingBottom: 3,
                            paddingLeft: 8,
                            letterSpacing: '-0.01em',
                          }}>
                            {formatVerdict(item.approved === true)}
                          </span>
                        ) : null}
                        <span style={{
                          borderRadius: 10,
                          backgroundColor: riskTone.backgroundColor,
                          color: riskTone.color,
                          fontSize: 11,
                          fontWeight: 600,
                          paddingTop: 3,
                          paddingRight: 8,
                          paddingBottom: 3,
                          paddingLeft: 8,
                          letterSpacing: '-0.01em',
                        }}>
                          {formatRisk(item.risk)}
                        </span>
                      </div>
                    </div>

                    {/* Meta fields row */}
                    <div style={{
                      display: 'flex',
                      flexWrap: 'wrap',
                      gap: 16,
                      marginTop: 12,
                    }}>
                      <MetaInline label="Actor" value={formatActor(item.actor)} />
                      <MetaInline label="Session" value={item.sessionKey} mono />
                      <MetaInline label="ID" value={item.approvalId} mono />
                      {item.reviewer ? <MetaInline label="Reviewer" value={item.reviewer} /> : null}
                      {typeof item.approved === 'boolean' ? <MetaInline label="Verdict" value={formatVerdict(item.approved)} /> : null}
                      {item.diffSha ? <MetaInline label="Diff SHA" value={item.diffSha} mono /> : null}
                    </div>

                    {/* Note */}
                    {item.note ? (
                      <div style={{
                        marginTop: 12,
                        paddingTop: 10,
                        paddingRight: 14,
                        paddingBottom: 10,
                        paddingLeft: 14,
                        borderRadius: 10,
                        backgroundColor: 'rgba(0, 0, 0, 0.02)',
                      }}>
                        <div style={{
                          fontSize: 10,
                          fontWeight: 500,
                          letterSpacing: '0.05em',
                          textTransform: 'uppercase' as const,
                          color: '#8b95a3',
                          marginBottom: 4,
                        }}>
                          Note
                        </div>
                        <div style={{
                          fontSize: 13,
                          lineHeight: 1.6,
                          color: '#5b6475',
                          letterSpacing: '-0.01em',
                        }}>
                          {item.note}
                        </div>
                      </div>
                    ) : null}

                    {/* Orchestrator review findings */}
                    {item.type === 'orchestrator_review' ? (
                      <div style={{
                        marginTop: 12,
                      }}>
                        <div style={{
                          fontSize: 10,
                          fontWeight: 500,
                          letterSpacing: '0.05em',
                          textTransform: 'uppercase' as const,
                          color: '#8b95a3',
                          marginBottom: 8,
                        }}>
                          Findings
                        </div>
                        {findings.length === 0 ? (
                          <div style={{
                            fontSize: 13,
                            lineHeight: 1.6,
                            color: '#8b95a3',
                            letterSpacing: '-0.01em',
                          }}>
                            No structured findings were recorded for this review.
                          </div>
                        ) : (
                          <div style={{
                            display: 'flex',
                            flexDirection: 'column',
                            gap: 8,
                          }}>
                            {findings.map((finding, index) => {
                              const findingTone = FINDING_TONES[finding.severity];
                              const resolutionTone = RESOLUTION_TONES[finding.resolution];

                              return (
                                <div
                                  key={`${item.id}:finding:${index}`}
                                  style={{
                                    borderRadius: 10,
                                    backgroundColor: 'rgba(0, 0, 0, 0.02)',
                                    paddingTop: 10,
                                    paddingRight: 12,
                                    paddingBottom: 10,
                                    paddingLeft: 12,
                                  }}
                                >
                                  <div style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: 6,
                                    flexWrap: 'wrap',
                                  }}>
                                    <span style={{
                                      borderRadius: 8,
                                      backgroundColor: findingTone.backgroundColor,
                                      color: findingTone.color,
                                      fontSize: 11,
                                      fontWeight: 600,
                                      paddingTop: 2,
                                      paddingRight: 7,
                                      paddingBottom: 2,
                                      paddingLeft: 7,
                                      letterSpacing: '-0.01em',
                                    }}>
                                      {formatFindingSeverity(finding.severity)}
                                    </span>
                                    <span style={{
                                      borderRadius: 8,
                                      backgroundColor: resolutionTone.backgroundColor,
                                      color: resolutionTone.color,
                                      fontSize: 11,
                                      fontWeight: 600,
                                      paddingTop: 2,
                                      paddingRight: 7,
                                      paddingBottom: 2,
                                      paddingLeft: 7,
                                      letterSpacing: '-0.01em',
                                    }}>
                                      {formatFindingResolution(finding.resolution)}
                                    </span>
                                    <span style={{
                                      fontSize: 11,
                                      fontWeight: 500,
                                      color: '#8b95a3',
                                      fontFamily: MONO_FONT,
                                    }}>
                                      {formatFindingLocation(finding)}
                                    </span>
                                  </div>
                                  <div style={{
                                    marginTop: 6,
                                    fontSize: 13,
                                    lineHeight: 1.6,
                                    color: '#5b6475',
                                    letterSpacing: '-0.01em',
                                  }}>
                                    {finding.description}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function MetaInline({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{
        fontSize: 10,
        fontWeight: 500,
        letterSpacing: '0.04em',
        textTransform: 'uppercase' as const,
        color: '#8b95a3',
        lineHeight: 1,
      }}>
        {label}
      </div>
      <div style={{
        marginTop: 3,
        fontSize: 12,
        fontWeight: 500,
        color: '#5b6475',
        fontFamily: mono ? MONO_FONT : 'inherit',
        letterSpacing: mono ? '0' : '-0.01em',
        lineHeight: 1.4,
        wordBreak: 'break-all',
        maxWidth: 200,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      } as React.CSSProperties}>
        {value}
      </div>
    </div>
  );
}
