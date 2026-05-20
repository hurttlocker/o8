'use client';

/**
 * /preview/automations — isolated dev scaffold for the Automations page
 * (epic from the a community member Superset borrow, [[borrow_conductor_steer_queue]]
 * sibling tracker). Mocks the page shell, table rows, empty state, and the
 * "New automation" modal so the operator can visual-approve before wiring
 * lands in dashboard/page.tsx.
 *
 * Not part of the shipped chrome.
 */

import { useState } from 'react';
import { ThemeProvider } from '@/lib/theme/context';

type TriggerKind = 'manual' | 'cron';

interface AutomationRow {
  id: string;
  name: string;
  owner: string;
  project: string;
  repoBranch: string;
  runtime: string;
  trigger: TriggerKind;
  cron?: string;
  nextRunRelative?: string;
  lastRunStatus: 'idle' | 'running' | 'ok' | 'error';
}

const MINE_ROWS: AutomationRow[] = [
  {
    id: 'a1',
    name: 'Daily diff summary',
    owner: 'quisesyeklimye@gmail.com',
    project: 'o8',
    repoBranch: 'cortex-ide · main',
    runtime: 'codex',
    trigger: 'cron',
    cron: '0 9 * * *',
    nextRunRelative: 'tomorrow · 9:00 AM',
    lastRunStatus: 'ok',
  },
  {
    id: 'a2',
    name: 'Groom unlabeled issues',
    owner: 'quisesyeklimye@gmail.com',
    project: 'o8',
    repoBranch: 'cortex-ide · main',
    runtime: 'codex',
    trigger: 'cron',
    cron: '0 */6 * * *',
    nextRunRelative: 'in 2h 14m',
    lastRunStatus: 'running',
  },
  {
    id: 'a3',
    name: 'Refresh marketing copy',
    owner: 'quisesyeklimye@gmail.com',
    project: 'eyes-web',
    repoBranch: 'mybeautifulwife · main',
    runtime: 'codex',
    trigger: 'manual',
    nextRunRelative: 'manual',
    lastRunStatus: 'idle',
  },
];

const TEAM_ROWS: AutomationRow[] = [
  {
    id: 't1',
    name: '(Team automations require server — coming after P2)',
    owner: '',
    project: '',
    repoBranch: '',
    runtime: '',
    trigger: 'manual',
    nextRunRelative: '',
    lastRunStatus: 'idle',
  },
];

function StatusDot({ status }: { status: AutomationRow['lastRunStatus'] }) {
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

function PageHeader({
  count,
  onNew,
}: {
  count: number;
  onNew: () => void;
}) {
  return (
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
        {count} active
      </div>
      <button
        type="button"
        onClick={onNew}
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
  );
}

function Tabs({ scope, onChange }: { scope: 'mine' | 'team'; onChange: (next: 'mine' | 'team') => void }) {
  const items: { id: 'mine' | 'team'; label: string; count: number }[] = [
    { id: 'mine', label: 'Mine', count: MINE_ROWS.length },
    { id: 'team', label: 'Team', count: TEAM_ROWS.length },
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

function Table({ rows, isTeam }: { rows: AutomationRow[]; isTeam?: boolean }) {
  return (
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
        gridTemplateColumns: '24px 1.6fr 1.4fr 1fr 1.2fr 1fr 28px',
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
        <span />
      </div>

      {/* Data rows */}
      {rows.map((row) => (
        <div
          key={row.id}
          style={{
            display: 'grid',
            gridTemplateColumns: '24px 1.6fr 1.4fr 1fr 1.2fr 1fr 28px',
            gap: 0,
            alignItems: 'center',
            paddingTop: 10,
            paddingRight: 14,
            paddingBottom: 10,
            paddingLeft: 14,
            borderBottom: '1px solid var(--t-divider)',
            fontSize: 13,
            color: 'var(--t-text)',
            opacity: isTeam ? 0.6 : 1,
          }}
        >
          <StatusDot status={row.lastRunStatus} />
          <span style={{ fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {row.name}
          </span>
          <span style={{ color: 'var(--t-text-muted)', fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {row.owner}
          </span>
          <span style={{ color: 'var(--t-text-muted)', fontSize: 12 }}>
            {row.project}
          </span>
          <span style={{ color: 'var(--t-text-muted)', fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {row.repoBranch}
          </span>
          <span style={{ color: 'var(--t-text-muted)', fontSize: 12, fontFamily: 'var(--font-mono-system, ui-monospace)' }}>
            {row.nextRunRelative}
          </span>
          <span style={{ textAlign: 'right' }}>
            <button
              type="button"
              title="More"
              style={{
                width: 24,
                height: 24,
                padding: 0,
                borderWidth: 0,
                borderRadius: 6,
                background: 'transparent',
                color: 'var(--t-text-muted)',
                cursor: 'pointer',
                fontSize: 14,
                lineHeight: 1,
              }}
            >
              ⋯
            </button>
          </span>
        </div>
      ))}
    </div>
  );
}

function NewAutomationModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [trigger, setTrigger] = useState<TriggerKind>('cron');
  if (!open) return null;
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
            <input type="text" placeholder="e.g. Daily diff summary" style={inputStyle} />
          </Field>
          <Field label="Prompt">
            <textarea rows={4} placeholder="What should the agent do each run?" style={{ ...inputStyle, resize: 'vertical', minHeight: 80 }} />
          </Field>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Field label="Runtime">
              <SelectMock value="codex" options={['codex', 'gemini', 'opencode']} />
            </Field>
            <Field label="Project">
              <SelectMock value="o8" options={['o8', 'eyes-web']} />
            </Field>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 12 }}>
            <Field label="Repo">
              <SelectMock value="cortex-ide" options={['cortex-ide', 'mybeautifulwife']} />
            </Field>
            <Field label="Branch">
              <input type="text" placeholder="main" defaultValue="main" style={inputStyle} />
            </Field>
          </div>
          <Field label="Trigger">
            <div style={{ display: 'flex', gap: 6 }}>
              {(['manual', 'cron'] as TriggerKind[]).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTrigger(t)}
                  style={{
                    height: 32,
                    paddingTop: 0,
                    paddingRight: 12,
                    paddingBottom: 0,
                    paddingLeft: 12,
                    borderWidth: 1,
                    borderStyle: 'solid',
                    borderColor: trigger === t ? 'var(--t-accent, #2563eb)' : 'var(--t-divider)',
                    borderRadius: 8,
                    background: trigger === t ? 'var(--t-accent-soft, rgba(37,99,235,0.08))' : 'transparent',
                    color: trigger === t ? 'var(--t-accent, #2563eb)' : 'var(--t-text-muted)',
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
          {trigger === 'cron' ? (
            <Field label="Cron expression">
              <input type="text" defaultValue="0 9 * * *" placeholder="0 9 * * *" style={{ ...inputStyle, fontFamily: 'var(--font-mono-system, ui-monospace)' }} />
              <div style={{ fontSize: 11, color: 'var(--t-text-faint)', marginTop: 6 }}>
                e.g. <code>0 9 * * *</code> = every day at 9 AM
              </div>
            </Field>
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
          <button type="button" onClick={onClose} style={ghostButton}>Cancel</button>
          <button type="button" style={primaryButton}>Create</button>
        </div>
      </div>
    </div>
  );
}

const inputStyle = {
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
} as React.CSSProperties;

const ghostButton = {
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
} as React.CSSProperties;

const primaryButton = {
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
} as React.CSSProperties;

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

function SelectMock({ value, options }: { value: string; options: string[] }) {
  return (
    <button type="button" style={{
      ...inputStyle,
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      cursor: 'pointer',
      textAlign: 'left',
    }}>
      <span>{value}</span>
      <span style={{ fontSize: 10, color: 'var(--t-text-muted)' }}>▾</span>
      <span style={{ position: 'absolute', clip: 'rect(0 0 0 0)', overflow: 'hidden' }}>
        Options: {options.join(', ')}
      </span>
    </button>
  );
}

function AutomationsPreviewInner() {
  const [scope, setScope] = useState<'mine' | 'team'>('mine');
  // Set ?modal=1 in the URL to open the New-automation modal on mount —
  // used to screenshot the modal-open state in headless Chrome.
  const initialModal = typeof window !== 'undefined' && /[?&]modal=1/.test(window.location.search);
  const [modalOpen, setModalOpen] = useState(initialModal);
  const rows = scope === 'mine' ? MINE_ROWS : TEAM_ROWS;

  return (
    <div style={{
      minHeight: '100vh',
      background: 'var(--t-bg)',
      color: 'var(--t-text)',
      display: 'flex',
      flexDirection: 'column',
    }}>
      <PageHeader count={MINE_ROWS.filter((r) => r.lastRunStatus !== 'idle').length} onNew={() => setModalOpen(true)} />
      <Tabs scope={scope} onChange={setScope} />
      <Table rows={rows} isTeam={scope === 'team'} />

      {/* Inline empty-state demo when scope changes — kept inline for screenshot */}
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

      <NewAutomationModal open={modalOpen} onClose={() => setModalOpen(false)} />
    </div>
  );
}

export default function AutomationsPreviewPage() {
  return (
    <ThemeProvider>
      <AutomationsPreviewInner />
    </ThemeProvider>
  );
}
