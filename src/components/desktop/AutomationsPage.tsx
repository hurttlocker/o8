'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AutomationEditor } from './automations-page/AutomationEditor';
import { AutomationListRow } from './automations-page/AutomationRow';
import type {
  AutomationRecord,
  AutomationScope,
  RegisteredRepo,
} from './automations-page/types';

const UI_FONT = 'var(--font-sans-system)';

function ScopeTabs({ scope, mineCount, teamCount, onChange }: {
  scope: AutomationScope;
  mineCount: number;
  teamCount: number;
  onChange: (scope: AutomationScope) => void;
}) {
  const tabs: Array<{ id: AutomationScope; label: string; count: number }> = [
    { id: 'mine', label: 'Mine', count: mineCount },
    { id: 'team', label: 'Team', count: teamCount },
  ];
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
      {tabs.map((tab) => {
        const active = scope === tab.id;
        return (
          <button
            key={tab.id}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(tab.id)}
            style={{
              height: 26,
              display: 'inline-flex',
              alignItems: 'center',
              paddingTop: 0,
              paddingRight: 10,
              paddingBottom: 0,
              paddingLeft: 10,
              borderWidth: 0,
              borderRadius: 7,
              background: active ? 'var(--t-input-bg)' : 'transparent',
              color: active ? 'var(--t-text)' : 'var(--t-text-muted)',
              fontSize: 12,
              fontWeight: 300,
              letterSpacing: '-0.1px',
              lineHeight: 1.25,
              fontFamily: UI_FONT,
              cursor: 'pointer',
              transition: 'background 120ms ease, color 120ms ease',
            }}
          >
            {tab.label}
            <span style={{
              marginLeft: 5,
              color: 'var(--t-text-faint)',
              fontSize: 9.5,
              fontWeight: 260,
              letterSpacing: '-0.4px',
            }}>
              {tab.count}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function SectionHeader({ label, count }: { label: string; count: number }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 7, paddingTop: 14, paddingBottom: 4 }}>
      <span style={{ color: 'var(--t-text-faint)', fontSize: 10, fontWeight: 300, letterSpacing: '-0.1px', lineHeight: '14px', textTransform: 'uppercase' }}>
        {label}
      </span>
      <span style={{ color: 'var(--t-text-faint)', fontSize: 9.5, fontWeight: 260, letterSpacing: '-0.4px', lineHeight: 1.25 }}>
        {count}
      </span>
    </div>
  );
}

function TruncatedRows({ children, count, limit = 6 }: { children: React.ReactNode[]; count: number; limit?: number }) {
  const [showAll, setShowAll] = useState(false);
  if (showAll || count <= limit) return <>{children}</>;
  return (
    <>
      {children.slice(0, limit)}
      <button
        type="button"
        onClick={() => setShowAll(true)}
        style={{
          alignSelf: 'flex-start',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          paddingTop: 5,
          paddingRight: 10,
          paddingBottom: 5,
          paddingLeft: 10,
          borderWidth: 0,
          background: 'transparent',
          color: 'var(--t-text-muted)',
          fontSize: 12,
          fontWeight: 300,
          letterSpacing: '-0.1px',
          fontFamily: UI_FONT,
          cursor: 'pointer',
        }}
      >
        Show {count - limit} more
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ color: 'var(--t-text-faint)' }}>
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
    </>
  );
}

function PrimaryButton({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        height: 30,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        paddingTop: 0,
        paddingRight: 12,
        paddingBottom: 0,
        paddingLeft: 12,
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: 'var(--t-divider)',
        borderRadius: 8,
        background: 'var(--t-input-bg)',
        color: 'var(--t-text)',
        fontSize: 12,
        fontWeight: 300,
        letterSpacing: '-0.1px',
        fontFamily: UI_FONT,
        cursor: 'pointer',
      }}
    >
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M8 3v10M3 8h10" />
      </svg>
      {children}
    </button>
  );
}

function EmptyState({ title, body, actionLabel, onAction }: {
  title: string;
  body: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <div style={{
      marginTop: 16,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      gap: 6,
      paddingTop: 30,
      paddingRight: 24,
      paddingBottom: 30,
      paddingLeft: 24,
      borderWidth: 1,
      borderStyle: 'solid',
      borderColor: 'var(--t-divider)',
      borderRadius: 10,
      textAlign: 'center',
    }}>
      <span style={{ color: 'var(--t-text)', fontSize: 13.5, fontWeight: 400, letterSpacing: '-0.1px', lineHeight: 1.25 }}>
        {title}
      </span>
      <span style={{ maxWidth: 420, color: 'var(--t-text-muted)', fontSize: 12, fontWeight: 300, letterSpacing: '-0.1px', lineHeight: 1.5 }}>
        {body}
      </span>
      {actionLabel && onAction ? (
        <div style={{ marginTop: 8 }}>
          <PrimaryButton onClick={onAction}>{actionLabel}</PrimaryButton>
        </div>
      ) : null}
    </div>
  );
}

export function AutomationsPage({ currentOwner, onClose }: { currentOwner: string; onClose?: () => void }) {
  const [rows, setRows] = useState<AutomationRecord[]>([]);
  const [repos, setRepos] = useState<RegisteredRepo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [scope, setScope] = useState<AutomationScope>('mine');
  const [modalOpen, setModalOpen] = useState(false);
  const [editingRow, setEditingRow] = useState<AutomationRecord | null>(null);

  const fetchRows = useCallback(async () => {
    try {
      const response = await fetch('/api/automations');
      const data = await response.json() as { automations?: AutomationRecord[]; error?: string };
      if (data.error) {
        setError(data.error);
        setRows([]);
      } else {
        setRows(data.automations ?? []);
        setError(null);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to load automations');
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchRepos = useCallback(async () => {
    try {
      const response = await fetch('/api/panel/repos');
      const data = await response.json() as { repos?: RegisteredRepo[] };
      setRepos(data.repos ?? []);
    } catch {
      setRepos([]);
    }
  }, []);

  useEffect(() => {
    void fetchRows();
    void fetchRepos();
  }, [fetchRepos, fetchRows]);

  useEffect(() => {
    if (scope !== 'mine') return;
    const intervalId = window.setInterval(() => { void fetchRows(); }, 15_000);
    return () => window.clearInterval(intervalId);
  }, [fetchRows, scope]);

  const mineRows = useMemo(() => rows.filter((row) => row.owner === currentOwner), [currentOwner, rows]);
  const teamRows = useMemo(() => rows.filter((row) => row.owner !== currentOwner), [currentOwner, rows]);
  const activeCount = useMemo(
    () => mineRows.filter((row) => row.enabled && row.lastRunStatus !== 'idle').length,
    [mineRows],
  );

  const handlePersisted = useCallback((record: AutomationRecord) => {
    setRows((current) => {
      const index = current.findIndex((row) => row.id === record.id);
      if (index < 0) return [record, ...current];
      const next = current.slice();
      next[index] = record;
      return next;
    });
  }, []);

  const handleToggle = useCallback(async (id: string, enabled: boolean) => {
    setRows((current) => current.map((row) => row.id === id ? { ...row, enabled } : row));
    try {
      const response = await fetch(`/api/automations/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      if (!response.ok) {
        setRows((current) => current.map((row) => row.id === id ? { ...row, enabled: !enabled } : row));
        return;
      }
      const data = await response.json() as { automation?: AutomationRecord };
      if (data.automation) handlePersisted(data.automation);
    } catch {
      setRows((current) => current.map((row) => row.id === id ? { ...row, enabled: !enabled } : row));
    }
  }, [handlePersisted]);

  const handleRun = useCallback(async (id: string, options: { runAnyway?: boolean } = {}) => {
    setRows((current) => current.map((row) => row.id === id ? { ...row, lastRunStatus: 'running', lastRunAt: Date.now() } : row));
    try {
      const response = await fetch(`/api/automations/${id}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientMutationId: crypto.randomUUID(),
          runAnyway: options.runAnyway === true,
        }),
      });
      const data = await response.json() as { ok?: boolean; note?: string };
      if (!response.ok || data.ok === false) {
        setRows((current) => current.map((row) => row.id === id
          ? { ...row, lastRunStatus: 'error', lastErrorMessage: data.note ?? 'run failed' }
          : row));
        void fetchRows();
        return;
      }
      void fetchRows();
    } catch (caught) {
      setRows((current) => current.map((row) => row.id === id
        ? { ...row, lastRunStatus: 'error', lastErrorMessage: caught instanceof Error ? caught.message : 'run failed' }
        : row));
    }
  }, [fetchRows]);

  const handleDelete = useCallback(async (id: string) => {
    setRows((current) => current.filter((row) => row.id !== id));
    try {
      await fetch(`/api/automations/${id}`, { method: 'DELETE' });
    } catch {
      void fetchRows();
    }
  }, [fetchRows]);

  const handleNew = useCallback(() => {
    setEditingRow(null);
    setModalOpen(true);
  }, []);

  const handleOpenLane = useCallback((row: AutomationRecord) => {
    if (typeof window === 'undefined' || !row.lastLaneId) return;
    window.dispatchEvent(new CustomEvent('o8:focus-spawned-agent-lane', {
      detail: { laneId: row.lastLaneId, title: row.name },
    }));
  }, []);

  const closeEditor = useCallback(() => {
    setModalOpen(false);
    setEditingRow(null);
  }, []);

  return (
    <div style={{
      height: '100%',
      minHeight: 0,
      overflowY: 'auto',
      background: 'var(--t-chat-surface-bg, var(--t-canvas-bg))',
      color: 'var(--t-text)',
      fontFamily: UI_FONT,
    }}>
      <div style={{
        width: '100%',
        maxWidth: 760,
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
        marginRight: 'auto',
        marginLeft: 'auto',
        paddingTop: 36,
        paddingRight: 24,
        paddingBottom: 64,
        paddingLeft: 24,
        boxSizing: 'border-box',
      }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16 }}>
          <div style={{ minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column', gap: 5 }}>
            <h1 style={{
              marginTop: 0,
              marginRight: 0,
              marginBottom: 0,
              marginLeft: 0,
              color: 'var(--t-text)',
              fontSize: 18,
              fontWeight: 400,
              letterSpacing: '-0.2px',
              lineHeight: 1.25,
            }}>
              Automations
            </h1>
            <p style={{
              marginTop: 0,
              marginRight: 0,
              marginBottom: 0,
              marginLeft: 0,
              color: 'var(--t-text-muted)',
              fontSize: 12,
              fontWeight: 300,
              letterSpacing: '-0.1px',
              lineHeight: 1.45,
            }}>
              Automate repetitive tasks with agents that run on schedules and triggers.
            </p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ color: 'var(--t-text-faint)', fontSize: 9.5, fontWeight: 260, letterSpacing: '-0.4px', whiteSpace: 'nowrap' }}>
              {activeCount} active
            </span>
            <PrimaryButton onClick={handleNew}>New automation</PrimaryButton>
            {onClose ? (
              <button
                type="button"
                onClick={onClose}
                style={{
                  height: 30,
                  paddingTop: 0,
                  paddingRight: 8,
                  paddingBottom: 0,
                  paddingLeft: 8,
                  borderWidth: 0,
                  borderRadius: 8,
                  background: 'transparent',
                  color: 'var(--t-text-muted)',
                  fontSize: 12,
                  fontWeight: 300,
                  letterSpacing: '-0.1px',
                  fontFamily: UI_FONT,
                  cursor: 'pointer',
                }}
              >
                Done
              </button>
            ) : null}
          </div>
        </div>

        <ScopeTabs scope={scope} mineCount={mineRows.length} teamCount={teamRows.length} onChange={setScope} />

        {loading ? (
          <div style={{ paddingTop: 32, color: 'var(--t-text-faint)', fontSize: 11, fontWeight: 300, letterSpacing: '-0.1px' }}>
            Loading…
          </div>
        ) : error ? (
          <EmptyState title="Automations unavailable" body={error} />
        ) : scope === 'team' ? (
          <EmptyState
            title="Team automations aren’t available yet"
            body="Shared automations need a team server. Your local automations stay available under Mine."
          />
        ) : mineRows.length === 0 ? (
          <EmptyState
            title="Let agents handle the repeat work"
            body="Create a local automation that runs a prompt manually or on a cron schedule."
            actionLabel="New automation"
            onAction={handleNew}
          />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <SectionHeader label="Automations" count={mineRows.length} />
            <TruncatedRows count={mineRows.length}>
              {mineRows.map((row) => (
                <AutomationListRow
                  key={row.id}
                  row={row}
                  onToggle={handleToggle}
                  onEdit={(record) => {
                    setEditingRow(record);
                    setModalOpen(true);
                  }}
                  onRun={handleRun}
                  onDelete={handleDelete}
                  onOpenLane={handleOpenLane}
                />
              ))}
            </TruncatedRows>
          </div>
        )}

        <div style={{ paddingTop: 4, color: 'var(--t-text-faint)', fontSize: 9.5, fontWeight: 260, letterSpacing: '-0.4px', lineHeight: 1.25 }}>
          Automations refresh every 15 seconds while Mine is open.
        </div>
      </div>

      <AutomationEditor
        open={modalOpen}
        initial={editingRow}
        repos={repos}
        defaultOwner={currentOwner}
        onClose={closeEditor}
        onPersisted={handlePersisted}
      />
    </div>
  );
}

export default AutomationsPage;
