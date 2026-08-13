'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

import { ipcFetch } from '@/lib/tauri/ipc-fetch';
import {
  correlatedActionIsUnsettled,
  fetchCorrelatedActionReceipt,
} from '@/lib/orchestrator/action-receipt';
import type {
  ProblemDossier,
  ProblemDossierStatus,
  ProblemRemedy,
} from '@/lib/problems/dossiers';

interface ProjectedProblemDossier extends ProblemDossier {
  remedies: ProblemRemedy[];
}

interface ProblemDossierResponse {
  dossiers?: ProjectedProblemDossier[];
  error?: string;
}

interface O8ProblemDossiersProps {
  active: boolean;
  repoPath?: string | null;
  refreshKey?: string | number | null;
}

const STATUS_LABELS: Record<ProblemDossierStatus, string> = {
  candidate: 'Needs a decision',
  accepted: 'Accepted',
  investigating: 'Investigating',
  remedy_active: 'Remedy running',
  provisionally_resolved: 'Proving the fix',
  verified_closed: 'Verified closed',
  reopened: 'Pain returned',
  suppressed: 'Suppressed',
};

function formatDate(value: string | null): string {
  if (!value) return 'Unknown';
  return new Date(value).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function statusColor(status: ProblemDossierStatus): string {
  if (status === 'verified_closed') return 'var(--t-success, #57b894)';
  if (status === 'suppressed') return 'var(--t-text-faint)';
  if (status === 'provisionally_resolved') return 'var(--t-warning, #d6a552)';
  if (status === 'reopened') return 'var(--t-danger, #e8796f)';
  return 'var(--t-accent, #9e8cff)';
}

function actionFor(dossier: ProjectedProblemDossier): Array<'accept' | 'suppress' | 'stop' | 'resume'> {
  if (dossier.status === 'suppressed') return ['resume'];
  if (dossier.status === 'candidate' || dossier.status === 'reopened') return ['accept', 'suppress'];
  if (dossier.status === 'verified_closed') return [];
  return ['stop'];
}

export function O8ProblemDossiers({ active, repoPath, refreshKey }: O8ProblemDossiersProps) {
  const [dossiers, setDossiers] = useState<ProjectedProblemDossier[]>([]);
  const [open, setOpen] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!active) return;
    try {
      const response = await ipcFetch('/api/panel/problem-dossiers?includeSuppressed=true');
      const payload = await response.json() as ProblemDossierResponse;
      if (!response.ok) throw new Error(payload.error || 'Unable to read recurring problems.');
      setDossiers(Array.isArray(payload.dossiers) ? payload.dossiers : []);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to read recurring problems.');
    }
  }, [active]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const visible = useMemo(() => dossiers.filter((dossier) => (
    !repoPath || dossier.repoPath === repoPath
  )), [dossiers, repoPath]);
  const actionable = visible.filter((dossier) => (
    dossier.status !== 'verified_closed' && dossier.status !== 'suppressed'
  )).length;

  const act = useCallback(async (
    dossier: ProjectedProblemDossier,
    action: 'accept' | 'suppress' | 'stop' | 'resume',
  ) => {
    setPendingId(dossier.id);
    setError(null);
    let receiptSettled = false;
    try {
      const requestBody = JSON.stringify({
        action,
        dossierId: dossier.id,
        clientMutationId: crypto.randomUUID(),
        ...(action === 'suppress' ? { cooldownDays: 7 } : {}),
      });
      const { response, payload } = await fetchCorrelatedActionReceipt<{
        ok: boolean;
        error?: string;
        outcomeUnknown?: boolean;
      }>('/api/panel/problem-dossiers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: requestBody,
      });
      if (payload?.outcomeUnknown) {
        setError(payload.error || 'This decision needs manual inspection before another action.');
        return;
      }
      receiptSettled = true;
      if (!response.ok || !payload?.ok) throw new Error(payload?.error || `Unable to ${action} this problem.`);
      await load();
    } catch (caught) {
      setError(correlatedActionIsUnsettled(caught)
        ? 'This decision is still unsettled. Refresh the dossier before taking another action.'
        : caught instanceof Error ? caught.message : `Unable to ${action} this problem.`);
    } finally {
      if (receiptSettled) setPendingId(null);
    }
  }, [load]);

  if (visible.length === 0 && !error) return null;

  return (
    <section style={{
      marginTop: 8,
      marginRight: 10,
      marginBottom: 8,
      marginLeft: 10,
      border: '1px solid var(--t-border-subtle)',
      borderRadius: 12,
      background: 'var(--t-panel)',
      overflow: 'hidden',
    }}>
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          paddingTop: 9,
          paddingRight: 10,
          paddingBottom: 9,
          paddingLeft: 10,
          border: 'none',
          background: 'transparent',
          color: 'var(--t-text)',
          cursor: 'pointer',
          textAlign: 'left',
          fontFamily: 'var(--font-sans-system)',
        }}
      >
        <span style={{
          width: 7,
          height: 7,
          borderRadius: 999,
          background: actionable > 0 ? 'var(--t-accent, #9e8cff)' : 'var(--t-success, #57b894)',
          boxShadow: actionable > 0 ? '0 0 0 3px color-mix(in srgb, var(--t-accent, #9e8cff) 16%, transparent)' : 'none',
        }} />
        <span style={{ flex: 1, fontSize: 11.5, fontWeight: 520, letterSpacing: '-0.1px' }}>
          Recurring problems
        </span>
        <span style={{ fontSize: 10, color: 'var(--t-text-muted)' }}>
          {actionable > 0 ? `${actionable} active` : `${visible.length} verified`}
        </span>
        <span aria-hidden style={{ fontSize: 11, color: 'var(--t-text-faint)', transform: open ? 'rotate(90deg)' : 'none' }}>
          ›
        </span>
      </button>

      {open ? (
        <div style={{ borderTop: '1px solid var(--t-border-subtle)' }}>
          {error ? (
            <div style={{ padding: 10, fontSize: 11, lineHeight: 1.45, color: 'var(--t-danger, #e8796f)' }}>
              {error}
            </div>
          ) : null}
          {visible.map((dossier, index) => {
            const expanded = expandedId === dossier.id;
            const actions = actionFor(dossier);
            const latestRemedy = dossier.remedies.at(-1) ?? null;
            return (
              <div key={dossier.id} style={{
                paddingTop: 10,
                paddingRight: 10,
                paddingBottom: 10,
                paddingLeft: 10,
                borderTop: index === 0 ? 'none' : '1px solid var(--t-border-subtle)',
              }}>
                <button
                  type="button"
                  onClick={() => setExpandedId(expanded ? null : dossier.id)}
                  style={{
                    width: '100%',
                    display: 'block',
                    padding: 0,
                    border: 'none',
                    background: 'transparent',
                    color: 'inherit',
                    cursor: 'pointer',
                    textAlign: 'left',
                    fontFamily: 'var(--font-sans-system)',
                  }}
                >
                  <span style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                    <span style={{
                      fontSize: 9.5,
                      fontWeight: 560,
                      color: statusColor(dossier.status),
                      textTransform: 'uppercase',
                      letterSpacing: '0.035em',
                    }}>
                      {STATUS_LABELS[dossier.status]}
                    </span>
                    <span style={{ flex: 1 }} />
                    <span style={{ fontSize: 9.5, color: 'var(--t-text-faint)' }}>
                      {dossier.occurrenceCount} signals
                    </span>
                  </span>
                  <span style={{
                    display: 'block',
                    marginTop: 5,
                    fontSize: 11.5,
                    lineHeight: 1.42,
                    color: 'var(--t-text)',
                  }}>
                    {dossier.painStatement}
                  </span>
                  {dossier.status === 'provisionally_resolved' ? (
                    <span style={{ display: 'block', marginTop: 5, fontSize: 10, color: 'var(--t-text-muted)' }}>
                      {dossier.comparableExposureCount} of {dossier.closureContract.requiredComparableExposures} clean exposures
                    </span>
                  ) : null}
                </button>

                {expanded ? (
                  <div style={{ marginTop: 9, fontSize: 10.5, lineHeight: 1.5, color: 'var(--t-text-muted)' }}>
                    <div>First seen {formatDate(dossier.firstObservedAt)} · Last seen {formatDate(dossier.lastObservedAt)}</div>
                    <div>Confidence {dossier.evidenceConfidence} · Impact {dossier.impactBand}</div>
                    {dossier.linkedTaskId ? <div>Task {dossier.linkedTaskId}</div> : null}
                    {dossier.remedies.length > 0 ? <div>{dossier.remedies.length} remedy attempt{dossier.remedies.length === 1 ? '' : 's'}</div> : null}
                    {latestRemedy?.missionId ? <div>Mission {latestRemedy.missionId}</div> : null}
                    {latestRemedy?.laneId ? <div>Lane {latestRemedy.laneId}</div> : null}
                    {latestRemedy?.approvalId ? <div>Approval {latestRemedy.approvalId}</div> : null}
                    {latestRemedy?.releaseRef ? <div>Release {latestRemedy.releaseRef}</div> : null}
                    <div style={{ marginTop: 5 }}>
                      {dossier.evidence.map((evidence) => (
                        <div key={evidence.id}>{evidence.sourceKind.replaceAll('_', ' ')} · {evidence.packetId}</div>
                      ))}
                    </div>
                    {dossier.history.length > 0 ? (
                      <div style={{ marginTop: 7, paddingTop: 7, borderTop: '1px solid var(--t-border-subtle)' }}>
                        {dossier.history.map((event) => (
                          <div key={event.id}>
                            {formatDate(event.at)} · {event.eventType.replaceAll('_', ' ')}
                            {event.note ? ` · ${event.note}` : ''}
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ) : null}

                <div style={{ display: 'flex', gap: 6, marginTop: 9 }}>
                  <button
                    type="button"
                    onClick={() => setExpandedId(expanded ? null : dossier.id)}
                    style={{
                      paddingTop: 4,
                      paddingRight: 8,
                      paddingBottom: 4,
                      paddingLeft: 8,
                      borderRadius: 7,
                      border: '1px solid var(--t-border-subtle)',
                      background: 'transparent',
                      color: 'var(--t-text-muted)',
                      fontSize: 10.5,
                      cursor: 'pointer',
                    }}
                  >
                    {expanded ? 'Hide history' : 'Inspect history'}
                  </button>
                  {actions.length > 0 ? (
                    actions.map((action) => (
                      <button
                        key={action}
                        type="button"
                        disabled={pendingId === dossier.id}
                        onClick={() => void act(dossier, action)}
                        style={{
                          paddingTop: 4,
                          paddingRight: 8,
                          paddingBottom: 4,
                          paddingLeft: 8,
                          borderRadius: 7,
                          border: '1px solid var(--t-border-subtle)',
                          background: action === 'accept' ? 'var(--t-accent, #7567d8)' : 'transparent',
                          color: action === 'accept' ? 'white' : 'var(--t-text-muted)',
                          fontSize: 10.5,
                          fontWeight: 450,
                          cursor: pendingId === dossier.id ? 'wait' : 'pointer',
                          opacity: pendingId === dossier.id ? 0.55 : 1,
                        }}
                      >
                        {pendingId === dossier.id ? 'Working…' : action[0]?.toUpperCase() + action.slice(1)}
                      </button>
                    ))
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}
