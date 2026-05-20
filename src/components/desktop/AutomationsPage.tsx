'use client';

/**
 * AutomationsPage — production version of /preview/automations.
 *
 * Mounted from dashboard/page.tsx when activeNavSection === 'automations'.
 * Fetches /api/automations, renders Mine | Team table rows, and provides
 * the "New automation" modal + per-row Run button. Cron triggers run on
 * the server scheduler (P1 task #27).
 *
 * Design borrow: Superset's Automations surface. Locked spec in
 * [[borrow_conductor_steer_queue]] sibling memory + /preview/automations.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';

type TriggerKind = 'manual' | 'cron';
type RunStatus = 'idle' | 'running' | 'ok' | 'error';
type Scope = 'mine' | 'team';

interface AutomationRow {
  id: string;
  name: string;
  owner: string;
  projectId: string | null;
  repoPath: string;
  branch: string;
  runtime: string;
  prompt: string;
  triggerKind: TriggerKind;
  cronExpr: string | null;
  enabled: boolean;
  nextRunAt: number | null;
  lastRunAt: number | null;
  lastRunStatus: RunStatus;
  lastLaneId: string | null;
  createdAt: string;
  updatedAt: string;
}

const MS_MINUTE = 60_000;
const MS_HOUR = 3_600_000;
const MS_DAY = 86_400_000;

function formatRelative(ms: number | null, fallback: string): string {
  if (ms == null) return fallback;
  const delta = ms - Date.now();
  if (delta < 0) {
    const ago = Math.abs(delta);
    if (ago < MS_HOUR) return `${Math.max(1, Math.floor(ago / MS_MINUTE))}m ago`;
    if (ago < MS_DAY) return `${Math.floor(ago / MS_HOUR)}h ago`;
    return `${Math.floor(ago / MS_DAY)}d ago`;
  }
  if (delta < MS_HOUR) {
    const mins = Math.max(1, Math.ceil(delta / MS_MINUTE));
    return `in ${mins}m`;
  }
  if (delta < MS_DAY) {
    const hours = Math.floor(delta / MS_HOUR);
    const mins = Math.floor((delta % MS_HOUR) / MS_MINUTE);
    return mins > 0 ? `in ${hours}h ${mins}m` : `in ${hours}h`;
  }
  const d = new Date(ms);
  const today = new Date();
  const tomorrow = new Date(today.getTime() + MS_DAY);
  const sameDay = d.toDateString() === today.toDateString();
  const tomorrowDay = d.toDateString() === tomorrow.toDateString();
  const timeStr = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (sameDay) return `today · ${timeStr}`;
  if (tomorrowDay) return `tomorrow · ${timeStr}`;
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} · ${timeStr}`;
}

function StatusDot({ status }: { status: RunStatus }) {
  const color =
    status === 'ok' ? '#22c55e'
      : status === 'running' ? '#3b82f6'
      : status === 'error' ? '#ef4444'
      : 'var(--t-text-faint, #94a3b8)';
  return (
    <span style={{
      display: 'inline-block',
      width: 8,
      height: 8,
      borderRadius: 999,
      background: color,
      flexShrink: 0,
    }} />
  );
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  height: 34,
  paddingTop: 0,
  paddingRight: 10,
  paddingBottom: 0,
  paddingLeft: 10,
  borderWidth: 1,
  borderStyle: 'solid',
  borderColor: 'var(--t-divider)',
  borderRadius: 8,
  background: 'var(--t-input-bg)',
  color: 'var(--t-text)',
  fontSize: 13,
  fontFamily: 'var(--font-sans-system)',
  outline: 'none',
  boxSizing: 'border-box',
};

const ghostButton: React.CSSProperties = {
  height: 32,
  paddingTop: 0,
  paddingRight: 14,
  paddingBottom: 0,
  paddingLeft: 14,
  borderWidth: 1,
  borderStyle: 'solid',
  borderColor: 'var(--t-divider)',
  borderRadius: 8,
  background: 'transparent',
  color: 'var(--t-text-muted)',
  fontSize: 12,
  fontWeight: 500,
  cursor: 'pointer',
};

const primaryButton: React.CSSProperties = {
  height: 32,
  paddingTop: 0,
  paddingRight: 14,
  paddingBottom: 0,
  paddingLeft: 14,
  borderWidth: 0,
  borderRadius: 8,
  background: 'var(--t-accent, #2563eb)',
  color: '#ffffff',
  fontSize: 12,
  fontWeight: 600,
  cursor: 'pointer',
};

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span style={{
        fontSize: 10.5,
        fontWeight: 600,
        letterSpacing: '0.04em',
        textTransform: 'uppercase',
        color: 'var(--t-text-muted)',
      }}>
        {label}
      </span>
      {children}
    </label>
  );
}

interface NewAutomationFormState {
  name: string;
  prompt: string;
  runtime: string;
  repoPath: string;
  branch: string;
  triggerKind: TriggerKind;
  cronExpr: string;
}

function NewAutomationModal({
  open,
  defaultOwner,
  onClose,
  onCreated,
}: {
  open: boolean;
  defaultOwner: string;
  onClose: () => void;
  onCreated: (row: AutomationRow) => void;
}) {
  const [form, setForm] = useState<NewAutomationFormState>({
    name: '',
    prompt: '',
    runtime: 'codex',
    repoPath: '',
    branch: 'main',
    triggerKind: 'cron',
    cronExpr: '0 9 * * *',
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  const update = (patch: Partial<NewAutomationFormState>) => setForm((prev) => ({ ...prev, ...patch }));

  const submit = async () => {
    setError(null);
    if (!form.name.trim()) { setError('Name is required.'); return; }
    if (!form.prompt.trim()) { setError('Prompt is required.'); return; }
    if (!form.repoPath.trim()) { setError('Repo path is required.'); return; }
    setSubmitting(true);
    try {
      const response = await fetch('/api/automations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: form.name.trim(),
          owner: defaultOwner,
          prompt: form.prompt.trim(),
          runtime: form.runtime,
          repoPath: form.repoPath.trim(),
          branch: form.branch.trim() || 'main',
          triggerKind: form.triggerKind,
          cronExpr: form.triggerKind === 'cron' ? form.cronExpr.trim() : null,
        }),
      });
      const data = await response.json() as { automation?: AutomationRow; error?: string };
      if (!response.ok || !data.automation) {
        setError(data.error ?? `Create failed (${response.status})`);
        setSubmitting(false);
        return;
      }
      onCreated(data.automation);
      onClose();
      setSubmitting(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Create failed.');
      setSubmitting(false);
    }
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.36)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 100,
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 540,
          maxHeight: '88vh',
          borderRadius: 14,
          borderWidth: 1,
          borderStyle: 'solid',
          borderColor: 'var(--t-divider)',
          background: 'var(--t-bg)',
          color: 'var(--t-text)',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <div style={{
          paddingTop: 16,
          paddingRight: 20,
          paddingBottom: 12,
          paddingLeft: 20,
          borderBottom: '1px solid var(--t-divider)',
          fontSize: 15,
          fontWeight: 600,
        }}>
          New automation
        </div>
        <div style={{
          flex: 1,
          overflow: 'auto',
          paddingTop: 16,
          paddingRight: 20,
          paddingBottom: 16,
          paddingLeft: 20,
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
        }}>
          <Field label="Name">
            <input
              type="text"
              placeholder="e.g. Daily diff summary"
              value={form.name}
              onChange={(e) => update({ name: e.target.value })}
              style={inputStyle}
            />
          </Field>
          <Field label="Prompt">
            <textarea
              rows={4}
              placeholder="What should the agent do each run?"
              value={form.prompt}
              onChange={(e) => update({ prompt: e.target.value })}
              style={{ ...inputStyle, height: 'auto', minHeight: 80, paddingTop: 8, paddingBottom: 8, resize: 'vertical' }}
            />
          </Field>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Field label="Runtime">
              <select
                value={form.runtime}
                onChange={(e) => update({ runtime: e.target.value })}
                style={inputStyle}
              >
                <option value="codex">codex</option>
                <option value="gemini">gemini</option>
                <option value="opencode">opencode</option>
              </select>
            </Field>
            <Field label="Branch">
              <input
                type="text"
                value={form.branch}
                onChange={(e) => update({ branch: e.target.value })}
                style={inputStyle}
              />
            </Field>
          </div>
          <Field label="Repo path">
            <input
              type="text"
              placeholder="/Users/you/your-repo"
              value={form.repoPath}
              onChange={(e) => update({ repoPath: e.target.value })}
              style={{ ...inputStyle, fontFamily: 'var(--font-mono-system, ui-monospace)' }}
            />
          </Field>
          <Field label="Trigger">
            <div style={{ display: 'flex', gap: 6 }}>
              {(['manual', 'cron'] as TriggerKind[]).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => update({ triggerKind: t })}
                  style={{
                    height: 32,
                    paddingTop: 0,
                    paddingRight: 12,
                    paddingBottom: 0,
                    paddingLeft: 12,
                    borderWidth: 1,
                    borderStyle: 'solid',
                    borderColor: form.triggerKind === t ? 'var(--t-accent, #2563eb)' : 'var(--t-divider)',
                    borderRadius: 8,
                    background: form.triggerKind === t ? 'var(--t-accent-soft, rgba(37,99,235,0.08))' : 'transparent',
                    color: form.triggerKind === t ? 'var(--t-accent, #2563eb)' : 'var(--t-text-muted)',
                    fontSize: 12,
                    fontWeight: 500,
                    cursor: 'pointer',
                  }}
                >
                  {t === 'manual' ? 'Manual' : 'Cron'}
                </button>
              ))}
            </div>
          </Field>
          {form.triggerKind === 'cron' ? (
            <Field label="Cron expression">
              <input
                type="text"
                value={form.cronExpr}
                onChange={(e) => update({ cronExpr: e.target.value })}
                placeholder="0 9 * * *"
                style={{ ...inputStyle, fontFamily: 'var(--font-mono-system, ui-monospace)' }}
              />
              <div style={{ fontSize: 11, color: 'var(--t-text-faint)', marginTop: 6 }}>
                e.g. <code>0 9 * * *</code> = every day at 9 AM. Standard 5-field cron — minute, hour, day-of-month, month, day-of-week.
              </div>
            </Field>
          ) : null}
          {error ? (
            <div style={{ fontSize: 12, color: 'var(--t-brand-red, #ef4444)', fontWeight: 500 }}>
              {error}
            </div>
          ) : null}
        </div>
        <div style={{
          display: 'flex',
          justifyContent: 'flex-end',
          gap: 8,
          paddingTop: 12,
          paddingRight: 20,
          paddingBottom: 14,
          paddingLeft: 20,
          borderTop: '1px solid var(--t-divider)',
        }}>
          <button type="button" onClick={onClose} disabled={submitting} style={{ ...ghostButton, opacity: submitting ? 0.5 : 1 }}>Cancel</button>
          <button type="button" onClick={submit} disabled={submitting} style={{ ...primaryButton, opacity: submitting ? 0.7 : 1 }}>
            {submitting ? 'Creating…' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Tabs({ scope, mineCount, teamCount, onChange }: {
  scope: Scope;
  mineCount: number;
  teamCount: number;
  onChange: (next: Scope) => void;
}) {
  const items: { id: Scope; label: string; count: number }[] = [
    { id: 'mine', label: 'Mine', count: mineCount },
    { id: 'team', label: 'Team', count: teamCount },
  ];
  return (
    <div style={{
      display: 'flex',
      gap: 4,
      paddingTop: 14,
      paddingRight: 32,
      paddingBottom: 0,
      paddingLeft: 32,
    }}>
      {items.map((item) => {
        const active = scope === item.id;
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => onChange(item.id)}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              height: 30,
              paddingTop: 0,
              paddingRight: 11,
              paddingBottom: 0,
              paddingLeft: 11,
              borderWidth: 0,
              borderRadius: 8,
              background: active ? 'var(--t-input-bg)' : 'transparent',
              color: active ? 'var(--t-text)' : 'var(--t-text-muted)',
              fontSize: 13,
              fontWeight: active ? 600 : 500,
              cursor: 'pointer',
            }}
          >
            {item.label}
            <span style={{
              fontSize: 11,
              fontWeight: 500,
              color: 'var(--t-text-muted)',
            }}>
              {item.count}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function compactPath(path: string): string {
  const parts = path.split('/').filter(Boolean);
  if (parts.length <= 2) return path;
  return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
}

function RowActions({
  row,
  onRun,
  onDelete,
}: {
  row: AutomationRow;
  onRun: (id: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  const [busy, setBusy] = useState<'run' | 'delete' | null>(null);
  const running = row.lastRunStatus === 'running' || busy === 'run';
  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <button
        type="button"
        title={running ? 'Already running' : 'Run now'}
        disabled={running}
        onClick={async () => {
          setBusy('run');
          try { await onRun(row.id); } finally { setBusy(null); }
        }}
        style={{
          height: 26,
          paddingTop: 0,
          paddingRight: 9,
          paddingBottom: 0,
          paddingLeft: 9,
          borderWidth: 1,
          borderStyle: 'solid',
          borderColor: 'var(--t-divider)',
          borderRadius: 6,
          background: 'transparent',
          color: 'var(--t-text-muted)',
          fontSize: 11,
          fontWeight: 500,
          cursor: running ? 'default' : 'pointer',
          opacity: running ? 0.5 : 1,
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
        }}
      >
        <svg width="9" height="9" viewBox="0 0 16 16" fill="currentColor">
          <path d="M4 3l9 5-9 5V3z" />
        </svg>
        Run
      </button>
      <button
        type="button"
        title="Delete"
        disabled={busy === 'delete'}
        onClick={async () => {
          if (!confirm(`Delete automation "${row.name}"?`)) return;
          setBusy('delete');
          try { await onDelete(row.id); } finally { setBusy(null); }
        }}
        style={{
          width: 26,
          height: 26,
          padding: 0,
          borderWidth: 0,
          borderRadius: 6,
          background: 'transparent',
          color: 'var(--t-text-muted)',
          cursor: 'pointer',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 5h10" />
          <path d="M5 5v8a1 1 0 0 0 1 1h4a1 1 0 0 0 1-1V5" />
          <path d="M6.5 5V3.5a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1V5" />
        </svg>
      </button>
    </div>
  );
}

export function AutomationsPage({ currentOwner }: { currentOwner: string }) {
  const [rows, setRows] = useState<AutomationRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [scope, setScope] = useState<Scope>('mine');
  const [modalOpen, setModalOpen] = useState(false);

  const fetchRows = useCallback(async () => {
    try {
      const response = await fetch('/api/automations');
      const data = await response.json() as { automations?: AutomationRow[]; error?: string };
      if (data.error) {
        setError(data.error);
        setRows([]);
      } else {
        setRows(data.automations ?? []);
        setError(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load automations');
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchRows();
  }, [fetchRows]);

  // Refresh every 15s while the page is visible so cron-fire status updates
  // bubble up without a manual reload. Pause when scope=team (P1 placeholder).
  useEffect(() => {
    if (scope !== 'mine') return;
    const id = window.setInterval(() => { void fetchRows(); }, 15_000);
    return () => window.clearInterval(id);
  }, [scope, fetchRows]);

  const mineRows = useMemo(() => rows.filter((r) => r.owner === currentOwner), [rows, currentOwner]);
  const teamRows = useMemo(() => rows.filter((r) => r.owner !== currentOwner), [rows, currentOwner]);
  const visibleRows = scope === 'mine' ? mineRows : teamRows;
  const activeCount = useMemo(() => mineRows.filter((r) => r.enabled && r.lastRunStatus !== 'idle').length, [mineRows]);

  const handleCreated = (row: AutomationRow) => {
    setRows((prev) => [row, ...prev]);
  };

  const handleRun = useCallback(async (id: string) => {
    // Optimistic: bump local status to running.
    setRows((prev) => prev.map((r) => r.id === id ? { ...r, lastRunStatus: 'running', lastRunAt: Date.now() } : r));
    try {
      const response = await fetch(`/api/automations/${id}/run`, { method: 'POST' });
      const data = await response.json() as { ok?: boolean; note?: string; laneId?: string };
      if (!response.ok || data.ok === false) {
        setRows((prev) => prev.map((r) => r.id === id ? { ...r, lastRunStatus: 'error' } : r));
        return;
      }
      // Refresh to get authoritative state (lastLaneId, nextRunAt).
      void fetchRows();
    } catch {
      setRows((prev) => prev.map((r) => r.id === id ? { ...r, lastRunStatus: 'error' } : r));
    }
  }, [fetchRows]);

  const handleDelete = useCallback(async (id: string) => {
    setRows((prev) => prev.filter((r) => r.id !== id));
    try {
      await fetch(`/api/automations/${id}`, { method: 'DELETE' });
    } catch {
      // Re-fetch on failure to recover the row.
      void fetchRows();
    }
  }, [fetchRows]);

  return (
    <div style={{
      flex: 1,
      minHeight: 0,
      display: 'flex',
      flexDirection: 'column',
      background: 'var(--t-bg)',
      color: 'var(--t-text)',
      overflow: 'auto',
    }}>
      {/* Header */}
      <div style={{
        display: 'flex',
        alignItems: 'baseline',
        gap: 16,
        paddingTop: 32,
        paddingRight: 32,
        paddingBottom: 12,
        paddingLeft: 32,
        borderBottom: '1px solid var(--t-divider)',
      }}>
        <div style={{
          fontSize: 22,
          fontWeight: 600,
          letterSpacing: '-0.02em',
          color: 'var(--t-text)',
        }}>
          Automations
        </div>
        <div style={{ flex: 1 }} />
        <div style={{
          fontSize: 12,
          color: 'var(--t-text-muted)',
          marginRight: 8,
        }}>
          {activeCount} active
        </div>
        <button
          type="button"
          onClick={() => setModalOpen(true)}
          style={{
            height: 30,
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
            fontWeight: 500,
            cursor: 'pointer',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
          }}
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M8 3v10M3 8h10" />
          </svg>
          New automation
        </button>
      </div>

      <Tabs scope={scope} mineCount={mineRows.length} teamCount={teamRows.length} onChange={setScope} />

      {/* Table */}
      <div style={{
        marginTop: 16,
        marginRight: 32,
        marginBottom: 16,
        marginLeft: 32,
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: 'var(--t-divider)',
        borderRadius: 12,
        background: 'var(--t-bg-card)',
        overflow: 'hidden',
      }}>
        {/* Header row */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: '24px 1.6fr 1.4fr 1fr 1.2fr 1fr 90px',
          gap: 0,
          paddingTop: 10,
          paddingRight: 14,
          paddingBottom: 10,
          paddingLeft: 14,
          borderBottom: '1px solid var(--t-divider)',
          background: 'var(--t-input-bg)',
          fontSize: 10.5,
          fontWeight: 600,
          letterSpacing: '0.04em',
          textTransform: 'uppercase',
          color: 'var(--t-text-muted)',
        }}>
          <span />
          <span>Name</span>
          <span>Owner</span>
          <span>Project</span>
          <span>Workspace</span>
          <span>Next run</span>
          <span style={{ textAlign: 'right' }}>Actions</span>
        </div>

        {/* Data rows */}
        {loading ? (
          <div style={{ padding: 24, textAlign: 'center', color: 'var(--t-text-muted)', fontSize: 13 }}>
            Loading…
          </div>
        ) : error ? (
          <div style={{ padding: 24, textAlign: 'center', color: 'var(--t-brand-red, #ef4444)', fontSize: 13 }}>
            {error}
          </div>
        ) : scope === 'team' ? (
          <div style={{ padding: 24, textAlign: 'center', color: 'var(--t-text-muted)', fontSize: 13 }}>
            Team automations require a shared server — coming after P2.
          </div>
        ) : visibleRows.length === 0 ? (
          <div style={{ padding: 32, textAlign: 'center', color: 'var(--t-text-muted)', fontSize: 13 }}>
            No automations yet. Click <strong style={{ color: 'var(--t-text)' }}>New automation</strong> to create one.
          </div>
        ) : (
          visibleRows.map((row) => (
            <div
              key={row.id}
              style={{
                display: 'grid',
                gridTemplateColumns: '24px 1.6fr 1.4fr 1fr 1.2fr 1fr 90px',
                gap: 0,
                alignItems: 'center',
                paddingTop: 10,
                paddingRight: 14,
                paddingBottom: 10,
                paddingLeft: 14,
                borderBottom: '1px solid var(--t-divider)',
                fontSize: 13,
                color: 'var(--t-text)',
              }}
            >
              <StatusDot status={row.lastRunStatus} />
              <span title={row.prompt} style={{ fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {row.name}
              </span>
              <span style={{ color: 'var(--t-text-muted)', fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {row.owner}
              </span>
              <span style={{ color: 'var(--t-text-muted)', fontSize: 12 }}>
                {row.projectId ?? '—'}
              </span>
              <span title={`${row.repoPath} · ${row.branch}`} style={{ color: 'var(--t-text-muted)', fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {compactPath(row.repoPath)} · {row.branch}
              </span>
              <span style={{ color: 'var(--t-text-muted)', fontSize: 12, fontFamily: 'var(--font-mono-system, ui-monospace)' }}>
                {row.triggerKind === 'manual' ? 'manual' : formatRelative(row.nextRunAt, 'pending')}
              </span>
              <span style={{ textAlign: 'right' }}>
                <RowActions row={row} onRun={handleRun} onDelete={handleDelete} />
              </span>
            </div>
          ))
        )}
      </div>

      <div style={{
        marginTop: 8,
        marginRight: 32,
        marginBottom: 32,
        marginLeft: 32,
        fontSize: 11,
        color: 'var(--t-text-faint)',
      }}>
        Tip — use the <code>o8</code> CLI in any terminal to spin up an automation:{' '}
        <code style={{
          paddingTop: 2,
          paddingRight: 6,
          paddingBottom: 2,
          paddingLeft: 6,
          background: 'var(--t-input-bg)',
          borderRadius: 4,
          fontSize: 11,
        }}>
          o8 automation create
        </code>
      </div>

      <NewAutomationModal
        open={modalOpen}
        defaultOwner={currentOwner}
        onClose={() => setModalOpen(false)}
        onCreated={handleCreated}
      />
    </div>
  );
}

export default AutomationsPage;
