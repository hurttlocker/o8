'use client';

import { type CSSProperties } from 'react';
import { Play, Plus, RefreshCw, X } from '../../../lucide-shims';
import { REPO_FOCUS_FONT } from '../../utils';
import type { RepoFocusRepo } from '../../types';
import { FIELD_SURFACE, FLOATING_GLASS_SURFACE } from './constants';
import { ActionButton, IconActionButton, StatusChip } from './shared';

export function TaskStatusStrip({
  counts,
  composerOpen,
  refreshing,
  onCreateTask,
  onRefresh,
}: {
  counts: Record<'blocked' | 'review' | 'running' | 'ready', number>;
  composerOpen: boolean;
  refreshing: boolean;
  onCreateTask: () => void;
  onRefresh: () => void;
}) {
  const groups: Array<'blocked' | 'review' | 'running' | 'ready'> = ['blocked', 'review', 'running', 'ready'];
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 5,
        minHeight: 30,
        borderBottom: '1px solid var(--t-divider-subtle)',
        overflowX: 'auto',
        scrollbarWidth: 'none',
      }}
    >
      {groups.map((group) => (
        <StatusChip key={group} group={group} count={counts[group]} />
      ))}
      <span style={{ flex: 1, minWidth: 8 }} />
      <IconActionButton
        label="Create task"
        active={composerOpen}
        onClick={onCreateTask}
      >
        <Plus size={13} strokeWidth={2.2} />
      </IconActionButton>
      <IconActionButton
        label="Refresh task pool"
        active={refreshing}
        onClick={onRefresh}
      >
        <RefreshCw size={12} strokeWidth={2} />
      </IconActionButton>
    </div>
  );
}

export function NewTaskComposer({
  repos,
  selectedRepo,
  title,
  summary,
  repoPath,
  workerIntent,
  busy,
  onTitleChange,
  onSummaryChange,
  onRepoPathChange,
  onWorkerIntentChange,
  onCancel,
  onCreate,
  onCreateAndDispatch,
}: {
  repos: RepoFocusRepo[];
  selectedRepo?: RepoFocusRepo | null;
  title: string;
  summary: string;
  repoPath: string;
  workerIntent: string;
  busy: boolean;
  onTitleChange: (value: string) => void;
  onSummaryChange: (value: string) => void;
  onRepoPathChange: (value: string) => void;
  onWorkerIntentChange: (value: string) => void;
  onCancel: () => void;
  onCreate: () => void;
  onCreateAndDispatch: () => void;
}) {
  const fieldStyle: CSSProperties = {
    width: '100%',
    border: '1px solid var(--t-divider-subtle)',
    borderRadius: 10,
    background: FIELD_SURFACE,
    color: 'var(--t-text)',
    fontFamily: REPO_FOCUS_FONT,
    fontSize: 11.5,
    lineHeight: '16px',
    outline: 'none',
    paddingTop: 8,
    paddingRight: 10,
    paddingBottom: 8,
    paddingLeft: 10,
  };

  return (
    <div
      style={{
        marginTop: 10,
        border: '1px solid var(--t-divider-subtle)',
        borderRadius: 16,
        background: FLOATING_GLASS_SURFACE,
        boxShadow: '0 18px 46px rgba(15, 23, 42, 0.08)',
        backdropFilter: 'blur(18px) saturate(145%)',
        WebkitBackdropFilter: 'blur(18px) saturate(145%)',
        padding: 10,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 11.5, lineHeight: '15px', color: 'var(--t-text)', fontWeight: 640 }}>
            New task
          </div>
          <div style={{ marginTop: 1, fontSize: 10.25, lineHeight: '13px', color: 'var(--t-text-faint)' }}>
            Ready pool - Codex-only dispatch
          </div>
        </div>
        <button
          type="button"
          onClick={onCancel}
          title="Close"
          style={{
            width: 24,
            height: 24,
            border: 0,
            borderRadius: 8,
            background: 'transparent',
            color: 'var(--t-text-muted)',
            cursor: 'pointer',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <X size={13} strokeWidth={2} />
        </button>
      </div>
      <input
        value={title}
        onChange={(event) => onTitleChange(event.currentTarget.value)}
        placeholder="Task title"
        style={fieldStyle}
      />
      <textarea
        value={summary}
        onChange={(event) => onSummaryChange(event.currentTarget.value)}
        placeholder="Brief detail, constraints, or success criteria"
        rows={3}
        style={{
          ...fieldStyle,
          marginTop: 7,
          resize: 'vertical',
          minHeight: 58,
        }}
      />
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 7, marginTop: 7 }}>
        <select
          value={repoPath}
          disabled={Boolean(selectedRepo)}
          onChange={(event) => onRepoPathChange(event.currentTarget.value)}
          style={{
            ...fieldStyle,
            height: 34,
            paddingTop: 0,
            paddingBottom: 0,
            color: selectedRepo ? 'var(--t-text-faint)' : 'var(--t-text-muted)',
          }}
        >
          {repos.map((repo) => (
            <option key={repo.id} value={repo.localPath}>{repo.name}</option>
          ))}
        </select>
        <select
          value={workerIntent}
          onChange={(event) => onWorkerIntentChange(event.currentTarget.value)}
          style={{
            ...fieldStyle,
            height: 34,
            paddingTop: 0,
            paddingBottom: 0,
            color: 'var(--t-text-muted)',
          }}
        >
          <option value="heavy_worker">Heavy worker</option>
          <option value="light_worker">Light worker</option>
          <option value="diagnostic">Diagnostic</option>
          <option value="reviewer">Reviewer</option>
          <option value="orchestrator">Orchestrator</option>
        </select>
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 7, marginTop: 9 }}>
        <ActionButton label="Add" disabled={busy} onClick={onCreate} />
        <ActionButton label="Add + dispatch" icon={<Play size={12} strokeWidth={2.2} />} primary disabled={busy} onClick={onCreateAndDispatch} />
      </div>
    </div>
  );
}
