'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Clock,
  RefreshCw,
  ShieldCheck,
  XCircle,
} from 'lucide-react';
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

function iconForEventType(type: ApprovalAuditEvent['type']) {
  switch (type) {
    case 'orchestrator_review':
      return ShieldCheck;
    case 'approved':
    case 'resumed':
      return CheckCircle2;
    case 'rejected':
    case 'resume_failed':
      return XCircle;
    default:
      return Clock;
  }
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

function SelectField({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ label: string; value: string }>;
}) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
      <span style={{
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: '0.06em',
        textTransform: 'uppercase',
        color: 'var(--t-text-secondary)',
      }}>
        {label}
      </span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        style={{
          width: '100%',
          minHeight: 44,
          borderRadius: 14,
          borderWidth: 1,
          borderStyle: 'solid',
          borderColor: 'var(--t-divider)',
          backgroundColor: 'var(--t-panel)',
          color: 'var(--t-text)',
          fontSize: 13,
          fontWeight: 600,
          paddingTop: 0,
          paddingRight: 14,
          paddingBottom: 0,
          paddingLeft: 14,
          outline: 'none',
          cursor: 'pointer',
        }}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function StatCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: { color: string; backgroundColor: string; borderColor: string };
}) {
  return (
    <div style={{
      borderRadius: 18,
      borderWidth: 1,
      borderStyle: 'solid',
      borderColor: tone.borderColor,
      backgroundColor: 'var(--t-panel)',
      backgroundImage: `linear-gradient(180deg, ${tone.backgroundColor} 0%, rgba(255, 255, 255, 0) 100%)`,
      boxShadow: 'var(--t-panel-shadow)',
      paddingTop: 14,
      paddingRight: 16,
      paddingBottom: 14,
      paddingLeft: 16,
      minHeight: 84,
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'space-between',
    }}>
      <span style={{
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: '0.06em',
        textTransform: 'uppercase',
        color: 'var(--t-text-secondary)',
      }}>
        {label}
      </span>
      <span style={{
        marginTop: 10,
        fontSize: 22,
        fontWeight: 800,
        letterSpacing: '-0.03em',
        color: tone.color,
      }}>
        {value}
      </span>
    </div>
  );
}

function MetaField({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div style={{
      minHeight: 54,
      borderRadius: 14,
      borderWidth: 1,
      borderStyle: 'solid',
      borderColor: 'var(--t-divider-subtle)',
      backgroundColor: 'rgba(255, 255, 255, 0.55)',
      paddingTop: 10,
      paddingRight: 12,
      paddingBottom: 10,
      paddingLeft: 12,
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'center',
      gap: 4,
    }}>
      <span style={{
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: '0.06em',
        textTransform: 'uppercase',
        color: 'var(--t-text-muted)',
      }}>
        {label}
      </span>
      <span style={{
        fontSize: 12,
        fontWeight: 600,
        color: 'var(--t-text)',
        fontFamily: mono ? MONO_FONT : 'inherit',
        lineHeight: 1.45,
        wordBreak: 'break-word',
      }}>
        {value}
      </span>
    </div>
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
      backgroundImage: 'var(--t-bg-gradient)',
      overflow: 'hidden',
    }}>
      <div style={{
        flexShrink: 0,
        paddingTop: 24,
        paddingRight: 24,
        paddingBottom: 18,
        paddingLeft: 24,
        borderBottomWidth: 1,
        borderBottomStyle: 'solid',
        borderBottomColor: 'var(--t-divider-subtle)',
      }}>
        <div style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 16,
          flexWrap: 'wrap',
        }}>
          <div style={{ maxWidth: 760 }}>
            <div style={{
              fontSize: 12,
              fontWeight: 700,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              color: 'var(--t-text-secondary)',
            }}>
              Approvals
            </div>
            <h2 style={{
              marginTop: 8,
              marginRight: 0,
              marginBottom: 0,
              marginLeft: 0,
              fontSize: 24,
              fontWeight: 800,
              letterSpacing: '-0.04em',
              color: 'var(--t-text)',
            }}>
              Approval Audit Log
            </h2>
            <p style={{
              marginTop: 8,
              marginRight: 0,
              marginBottom: 0,
              marginLeft: 0,
              fontSize: 13,
              lineHeight: 1.6,
              color: 'var(--t-text-muted)',
            }}>
              Unified evidence trail for approval creation, edits, decisions, and resume outcomes across every session.
            </p>
          </div>

          <div style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'flex-end',
            gap: 10,
            minWidth: 180,
          }}>
            <button
              type="button"
              onClick={() => { void loadApprovals(true); }}
              disabled={refreshing}
              style={{
                minHeight: 44,
                borderRadius: 14,
                borderWidth: 1,
                borderStyle: 'solid',
                borderColor: 'rgba(37, 99, 235, 0.18)',
                backgroundColor: 'var(--t-panel)',
                color: 'var(--t-text)',
                paddingTop: 0,
                paddingRight: 16,
                paddingBottom: 0,
                paddingLeft: 16,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 10,
                fontSize: 13,
                fontWeight: 700,
                cursor: refreshing ? 'default' : 'pointer',
                boxShadow: 'var(--t-panel-shadow)',
              }}
            >
              <RefreshCw size={14} strokeWidth={2.1} />
              {refreshing ? 'Refreshing…' : 'Refresh log'}
            </button>

            <span style={{
              fontSize: 11,
              color: 'var(--t-text-muted)',
            }}>
              {lastLoadedAt ? `Updated ${formatRelativeAge(lastLoadedAt)}` : 'Waiting for first sync'}
            </span>
          </div>
        </div>

        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
          gap: 12,
          marginTop: 18,
        }}>
          <StatCard
            label="Audit Events"
            value={String(timeline.length)}
            tone={{
              color: '#2563eb',
              backgroundColor: 'rgba(37, 99, 235, 0.12)',
              borderColor: 'rgba(37, 99, 235, 0.18)',
            }}
          />
          <StatCard
            label="Sessions"
            value={String(sessionOptions.length)}
            tone={{
              color: '#475569',
              backgroundColor: 'rgba(100, 116, 139, 0.12)',
              borderColor: 'rgba(100, 116, 139, 0.18)',
            }}
          />
          <StatCard
            label="High Risk Events"
            value={String(riskCounts.high)}
            tone={RISK_TONES.high}
          />
        </div>

        <div style={{
          marginTop: 18,
          borderRadius: 20,
          borderWidth: 1,
          borderStyle: 'solid',
          borderColor: 'var(--t-divider)',
          backgroundColor: 'var(--t-panel)',
          boxShadow: 'var(--t-panel-shadow)',
          paddingTop: 16,
          paddingRight: 16,
          paddingBottom: 16,
          paddingLeft: 16,
        }}>
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
            gap: 12,
            alignItems: 'end',
          }}>
            <SelectField
              label="Session"
              value={selectedSession}
              onChange={setSelectedSession}
              options={[
                { label: 'All sessions', value: 'all' },
                ...sessionOptions.map((sessionKey) => ({ label: sessionKey, value: sessionKey })),
              ]}
            />
            <SelectField
              label="Risk Level"
              value={selectedRisk}
              onChange={(value) => setSelectedRisk(value as RiskFilter)}
              options={[
                { label: 'All risks', value: 'all' },
                { label: 'High', value: 'high' },
                { label: 'Medium', value: 'medium' },
                { label: 'Low', value: 'low' },
              ]}
            />
            <SelectField
              label="Time Range"
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
            <button
              type="button"
              onClick={() => {
                setSelectedSession('all');
                setSelectedRisk('all');
                setSelectedRange('all');
              }}
              disabled={!hasActiveFilters}
              style={{
                minHeight: 44,
                borderRadius: 14,
                borderWidth: 1,
                borderStyle: 'solid',
                borderColor: hasActiveFilters ? 'rgba(37, 99, 235, 0.18)' : 'var(--t-divider)',
                backgroundColor: hasActiveFilters ? 'rgba(37, 99, 235, 0.08)' : 'rgba(255, 255, 255, 0.55)',
                color: hasActiveFilters ? '#1d4ed8' : 'var(--t-text-muted)',
                paddingTop: 0,
                paddingRight: 16,
                paddingBottom: 0,
                paddingLeft: 16,
                fontSize: 13,
                fontWeight: 700,
                cursor: hasActiveFilters ? 'pointer' : 'default',
              }}
            >
              Reset filters
            </button>
          </div>

          <div style={{
            marginTop: 12,
            fontSize: 12,
            color: 'var(--t-text-muted)',
          }}>
            {filteredTimeline.length} event{filteredTimeline.length === 1 ? '' : 's'} shown
          </div>
        </div>

        {error ? (
          <div style={{
            marginTop: 16,
            borderRadius: 16,
            borderWidth: 1,
            borderStyle: 'solid',
            borderColor: 'rgba(239, 68, 68, 0.18)',
            backgroundColor: 'rgba(239, 68, 68, 0.08)',
            color: '#b91c1c',
            paddingTop: 12,
            paddingRight: 14,
            paddingBottom: 12,
            paddingLeft: 14,
            fontSize: 13,
          }}>
            Unable to refresh the audit log. {error}
          </div>
        ) : null}
      </div>

      <div style={{
        flexGrow: 1,
        flexShrink: 1,
        flexBasis: 0,
        minHeight: 0,
        overflowY: 'auto',
        paddingTop: 20,
        paddingRight: 24,
        paddingBottom: 24,
        paddingLeft: 24,
      }}>
        {loading && !hasAnyEvents ? (
          <div style={{
            borderRadius: 22,
            borderWidth: 1,
            borderStyle: 'solid',
            borderColor: 'var(--t-divider)',
            backgroundColor: 'var(--t-panel)',
            boxShadow: 'var(--t-panel-shadow)',
            minHeight: 240,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--t-text-muted)',
            fontSize: 13,
          }}>
            Loading approval audit history…
          </div>
        ) : !hasAnyEvents ? (
          <div style={{
            borderRadius: 24,
            borderWidth: 1,
            borderStyle: 'solid',
            borderColor: 'var(--t-divider)',
            backgroundColor: 'var(--t-panel)',
            backgroundImage: 'linear-gradient(180deg, rgba(37, 99, 235, 0.08) 0%, rgba(255, 255, 255, 0) 100%)',
            boxShadow: 'var(--t-panel-shadow)',
            minHeight: 280,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 14,
            textAlign: 'center',
            paddingTop: 32,
            paddingRight: 24,
            paddingBottom: 32,
            paddingLeft: 24,
          }}>
            <div style={{
              width: 56,
              height: 56,
              borderRadius: 18,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: 'rgba(37, 99, 235, 0.12)',
              color: '#2563eb',
            }}>
              <ShieldCheck size={28} strokeWidth={2.1} />
            </div>
            <div>
              <div style={{
                fontSize: 16,
                fontWeight: 800,
                letterSpacing: '-0.03em',
                color: 'var(--t-text)',
              }}>
                No audit events yet
              </div>
              <p style={{
                marginTop: 8,
                marginRight: 0,
                marginBottom: 0,
                marginLeft: 0,
                maxWidth: 520,
                fontSize: 13,
                lineHeight: 1.6,
                color: 'var(--t-text-muted)',
              }}>
                The audit trail populates as approvals are created, updated, approved, rejected, or resumed.
              </p>
            </div>
          </div>
        ) : filteredTimeline.length === 0 ? (
          <div style={{
            borderRadius: 22,
            borderWidth: 1,
            borderStyle: 'solid',
            borderColor: 'var(--t-divider)',
            backgroundColor: 'var(--t-panel)',
            boxShadow: 'var(--t-panel-shadow)',
            minHeight: 240,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 12,
            textAlign: 'center',
            paddingTop: 28,
            paddingRight: 24,
            paddingBottom: 28,
            paddingLeft: 24,
          }}>
            <AlertCircle size={30} strokeWidth={2.1} style={{ color: 'var(--t-text-secondary)' }} />
            <div style={{
              fontSize: 15,
              fontWeight: 700,
              color: 'var(--t-text)',
            }}>
              No audit entries match these filters
            </div>
            <p style={{
              marginTop: 0,
              marginRight: 0,
              marginBottom: 0,
              marginLeft: 0,
              maxWidth: 420,
              fontSize: 13,
              lineHeight: 1.6,
              color: 'var(--t-text-muted)',
            }}>
              Broaden the current session, risk, or time range filters to inspect more approval activity.
            </p>
          </div>
        ) : (
          <div style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 14,
          }}>
            {filteredTimeline.map((item) => {
              const eventTone = EVENT_TONES[item.type];
              const riskTone = RISK_TONES[item.risk];
              const EventIcon = iconForEventType(item.type);
              const reviewVerdictTone = typeof item.approved === 'boolean'
                ? item.approved
                  ? EVENT_TONES.approved
                  : EVENT_TONES.rejected
                : null;
              const findings = item.findings ?? [];

              return (
                <div
                  key={item.id}
                  style={{
                    borderRadius: 22,
                    borderWidth: 1,
                    borderStyle: 'solid',
                    borderColor: 'var(--t-divider)',
                    backgroundColor: 'var(--t-panel)',
                    backgroundImage: `linear-gradient(180deg, ${eventTone.backgroundColor} 0%, rgba(255, 255, 255, 0) 100%)`,
                    boxShadow: 'var(--t-panel-shadow)',
                    paddingTop: 16,
                    paddingRight: 18,
                    paddingBottom: 16,
                    paddingLeft: 18,
                  }}
                >
                  <div style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    justifyContent: 'space-between',
                    gap: 14,
                    flexWrap: 'wrap',
                  }}>
                    <div style={{
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: 12,
                      minWidth: 0,
                      flexGrow: 1,
                      flexShrink: 1,
                      flexBasis: 280,
                    }}>
                      <div style={{
                        width: 42,
                        height: 42,
                        borderRadius: 14,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        backgroundColor: eventTone.backgroundColor,
                        color: eventTone.color,
                        borderWidth: 1,
                        borderStyle: 'solid',
                        borderColor: eventTone.borderColor,
                        flexShrink: 0,
                      }}>
                        <EventIcon size={18} strokeWidth={2.1} />
                      </div>

                      <div style={{ minWidth: 0 }}>
                        <div style={{
                          fontSize: 15,
                          fontWeight: 800,
                          letterSpacing: '-0.02em',
                          color: 'var(--t-text)',
                        }}>
                          {item.title}
                        </div>
                        <div style={{
                          marginTop: 4,
                          fontSize: 12,
                          lineHeight: 1.6,
                          color: 'var(--t-text-secondary)',
                        }}>
                          {formatTimestamp(item.timestamp)} · {formatRelativeAge(item.timestamp)}
                        </div>
                      </div>
                    </div>

                    <div style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      flexWrap: 'wrap',
                    }}>
                      <span style={{
                        borderRadius: 999,
                        borderWidth: 1,
                        borderStyle: 'solid',
                        borderColor: eventTone.borderColor,
                        backgroundColor: eventTone.backgroundColor,
                        color: eventTone.color,
                        fontSize: 11,
                        fontWeight: 700,
                        paddingTop: 5,
                        paddingRight: 10,
                        paddingBottom: 5,
                        paddingLeft: 10,
                      }}>
                        {formatEventType(item.type)}
                      </span>
                      {reviewVerdictTone ? (
                        <span style={{
                          borderRadius: 999,
                          borderWidth: 1,
                          borderStyle: 'solid',
                          borderColor: reviewVerdictTone.borderColor,
                          backgroundColor: reviewVerdictTone.backgroundColor,
                          color: reviewVerdictTone.color,
                          fontSize: 11,
                          fontWeight: 700,
                          paddingTop: 5,
                          paddingRight: 10,
                          paddingBottom: 5,
                          paddingLeft: 10,
                        }}>
                          {formatVerdict(item.approved === true)}
                        </span>
                      ) : null}
                      <span style={{
                        borderRadius: 999,
                        borderWidth: 1,
                        borderStyle: 'solid',
                        borderColor: riskTone.borderColor,
                        backgroundColor: riskTone.backgroundColor,
                        color: riskTone.color,
                        fontSize: 11,
                        fontWeight: 700,
                        paddingTop: 5,
                        paddingRight: 10,
                        paddingBottom: 5,
                        paddingLeft: 10,
                      }}>
                        {formatRisk(item.risk)}
                      </span>
                    </div>
                  </div>

                  <div style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
                    gap: 10,
                    marginTop: 14,
                  }}>
                    <MetaField label="Actor" value={formatActor(item.actor)} />
                    <MetaField label="Session Key" value={item.sessionKey} mono />
                    <MetaField label="Approval ID" value={item.approvalId} mono />
                    <MetaField label="Risk" value={formatRisk(item.risk)} />
                    {item.reviewer ? <MetaField label="Reviewer" value={item.reviewer} /> : null}
                    {typeof item.approved === 'boolean' ? <MetaField label="Verdict" value={formatVerdict(item.approved)} /> : null}
                    {item.diffSha ? <MetaField label="Diff SHA" value={item.diffSha} mono /> : null}
                  </div>

                  {item.note ? (
                    <div style={{
                      marginTop: 12,
                      borderRadius: 16,
                      borderWidth: 1,
                      borderStyle: 'solid',
                      borderColor: 'var(--t-divider-subtle)',
                      backgroundColor: 'rgba(255, 255, 255, 0.62)',
                      paddingTop: 12,
                      paddingRight: 14,
                      paddingBottom: 12,
                      paddingLeft: 14,
                    }}>
                      <div style={{
                        fontSize: 10,
                        fontWeight: 700,
                        letterSpacing: '0.06em',
                        textTransform: 'uppercase',
                        color: 'var(--t-text-muted)',
                      }}>
                        Note
                      </div>
                      <div style={{
                        marginTop: 6,
                        fontSize: 13,
                        lineHeight: 1.6,
                        color: 'var(--t-text-secondary)',
                      }}>
                        {item.note}
                      </div>
                    </div>
                  ) : null}

                  {item.type === 'orchestrator_review' ? (
                    <div style={{
                      marginTop: 12,
                      borderRadius: 16,
                      borderWidth: 1,
                      borderStyle: 'solid',
                      borderColor: 'var(--t-divider-subtle)',
                      backgroundColor: 'rgba(255, 255, 255, 0.7)',
                      paddingTop: 12,
                      paddingRight: 14,
                      paddingBottom: 12,
                      paddingLeft: 14,
                    }}>
                      <div style={{
                        fontSize: 10,
                        fontWeight: 700,
                        letterSpacing: '0.06em',
                        textTransform: 'uppercase',
                        color: 'var(--t-text-muted)',
                      }}>
                        Findings
                      </div>
                      {findings.length === 0 ? (
                        <div style={{
                          marginTop: 8,
                          fontSize: 13,
                          lineHeight: 1.6,
                          color: 'var(--t-text-secondary)',
                        }}>
                          No structured findings were recorded for this review.
                        </div>
                      ) : (
                        <div style={{
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 10,
                          marginTop: 10,
                        }}>
                          {findings.map((finding, index) => {
                            const findingTone = FINDING_TONES[finding.severity];
                            const resolutionTone = RESOLUTION_TONES[finding.resolution];

                            return (
                              <div
                                key={`${item.id}:finding:${index}`}
                                style={{
                                  borderRadius: 14,
                                  borderWidth: 1,
                                  borderStyle: 'solid',
                                  borderColor: 'var(--t-divider-subtle)',
                                  backgroundColor: 'rgba(248, 250, 252, 0.88)',
                                  paddingTop: 12,
                                  paddingRight: 12,
                                  paddingBottom: 12,
                                  paddingLeft: 12,
                                }}
                              >
                                <div style={{
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: 8,
                                  flexWrap: 'wrap',
                                }}>
                                  <span style={{
                                    borderRadius: 999,
                                    borderWidth: 1,
                                    borderStyle: 'solid',
                                    borderColor: findingTone.borderColor,
                                    backgroundColor: findingTone.backgroundColor,
                                    color: findingTone.color,
                                    fontSize: 11,
                                    fontWeight: 700,
                                    paddingTop: 4,
                                    paddingRight: 10,
                                    paddingBottom: 4,
                                    paddingLeft: 10,
                                  }}>
                                    {formatFindingSeverity(finding.severity)}
                                  </span>
                                  <span style={{
                                    borderRadius: 999,
                                    borderWidth: 1,
                                    borderStyle: 'solid',
                                    borderColor: resolutionTone.borderColor,
                                    backgroundColor: resolutionTone.backgroundColor,
                                    color: resolutionTone.color,
                                    fontSize: 11,
                                    fontWeight: 700,
                                    paddingTop: 4,
                                    paddingRight: 10,
                                    paddingBottom: 4,
                                    paddingLeft: 10,
                                  }}>
                                    {formatFindingResolution(finding.resolution)}
                                  </span>
                                  <span style={{
                                    fontSize: 12,
                                    fontWeight: 700,
                                    color: 'var(--t-text-secondary)',
                                    fontFamily: MONO_FONT,
                                  }}>
                                    {formatFindingLocation(finding)}
                                  </span>
                                </div>
                                <div style={{
                                  marginTop: 8,
                                  fontSize: 13,
                                  lineHeight: 1.6,
                                  color: 'var(--t-text)',
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
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
