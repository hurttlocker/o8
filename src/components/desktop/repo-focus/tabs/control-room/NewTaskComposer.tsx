'use client';

import { useState, type CSSProperties, type MouseEvent, type Ref } from 'react';
import { Play, Plus, RefreshCw } from '../../../lucide-shims';
import { REPO_FOCUS_FONT } from '../../utils';
import type { RepoFocusRepo } from '../../types';
import { FIELD_SURFACE, FLOATING_GLASS_SURFACE } from './constants';
import { ActionButton, IconActionButton, StatusChip } from './shared';
import type { TaskExecutionRuntime } from './create-task-request';
import { useRemoteWorkerAvailability } from './useRemoteWorkerAvailability';
import { CODEX_MODEL_IDS, MODEL_IDS } from '@/lib/models';
import { codexSupportsReasoningEffort } from '@/lib/codex/reasoning-effort';
import { THINKING_EFFORTS, THINKING_EFFORT_LABELS, type ThinkingEffort } from '@/lib/orchestrator/thinking-effort';

const composerActionStyle: CSSProperties = { fontSize: 11, fontWeight: 300, letterSpacing: '-0.1px', flexShrink: 0 };

export function TaskStatusStrip({
  counts,
  composerOpen,
  refreshing,
  creating = false,
  onCreateTask,
  onRefresh,
}: {
  counts: Record<'blocked' | 'review' | 'running' | 'ready', number>;
  composerOpen: boolean;
  refreshing: boolean;
  creating?: boolean;
  onCreateTask: (event: MouseEvent<HTMLButtonElement>) => void;
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
        disabled={creating}
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
  titleInputRef,
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
  titleInputRef?: Ref<HTMLInputElement>;
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
  onCreate: (runtime: TaskExecutionRuntime, model: string | null, effort: ThinkingEffort | null) => void;
  onCreateAndDispatch: (runtime: TaskExecutionRuntime, model: string | null, effort: ThinkingEffort | null) => void;
}) {
  const [executionRuntime, setExecutionRuntime] = useState<TaskExecutionRuntime>('codex');
  const remote = useRemoteWorkerAvailability();
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState<ThinkingEffort>('adaptive');
  const effortSupported = effort === 'adaptive' || codexSupportsReasoningEffort(model || MODEL_IDS.codexWorkerDefault, effort);
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
      role="group"
      aria-label="New task"
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || busy || event.defaultPrevented || event.repeat || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
        const target = event.target;
        // Native selectors and child menus own Escape; portals are outside this form.
        if (!(target instanceof Element) || !event.currentTarget.contains(target) || target.closest('select, [role="menu"], [role="listbox"], [role="combobox"], [aria-haspopup][aria-expanded="true"]')) return;
        event.preventDefault();
        event.stopPropagation();
        onCancel();
      }}
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
          <div style={{ fontSize: 11.5, lineHeight: '15px', color: 'var(--t-text)', fontWeight: 300 }}>
            New task
          </div>
          <div style={{ marginTop: 1, fontSize: 10.25, lineHeight: '13px', color: 'var(--t-text-faint)' }}>
            Choose where this task runs
          </div>
        </div>
        <ActionButton label="Cancel" disabled={busy} onClick={onCancel} style={composerActionStyle} />
      </div>
      <input
        ref={titleInputRef}
        aria-label="Task title"
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
      <select
        aria-label="Task execution location"
        value={executionRuntime}
        onChange={(event) => setExecutionRuntime(event.currentTarget.value as TaskExecutionRuntime)}
        style={{ ...fieldStyle, marginTop: 7, fontWeight: 300 }}
      >
        <option value="codex">This machine · Codex</option>
        <option value="cloud">Remote worker · Codex</option>
      </select>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1fr)', gap: 7, marginTop: 7 }}>
        <select aria-label="Task model" value={model} disabled={busy} onChange={(event) => setModel(event.currentTarget.value)} style={fieldStyle}>
          <option value="">Automatic · {MODEL_IDS.codexWorkerDefault}</option>
          {CODEX_MODEL_IDS.map((id) => <option key={id} value={id}>{id}</option>)}
        </select>
        <select aria-label="Task reasoning effort" value={effort} disabled={busy} onChange={(event) => setEffort(event.currentTarget.value as ThinkingEffort)} style={fieldStyle}>
          {THINKING_EFFORTS.map((value) => (
            <option key={value} value={value} disabled={value !== 'adaptive' && !codexSupportsReasoningEffort(model || MODEL_IDS.codexWorkerDefault, value)}>
              {THINKING_EFFORT_LABELS[value].long}
            </option>
          ))}
        </select>
      </div>
      {!effortSupported ? (
        <div role="status" style={{ marginTop: 5, fontSize: 10.5, lineHeight: '15px', fontWeight: 300, color: 'var(--t-text-muted)' }}>
          Choose an effort supported by this model.
        </div>
      ) : null}
      {executionRuntime === 'cloud' ? (
        <div role="status" style={{ marginTop: 5, fontSize: 10.5, lineHeight: '15px', fontWeight: 300, color: 'var(--t-text-muted)' }}>
          {remote?.detail ?? 'Checking remote workers…'}
        </div>
      ) : null}
      <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 7, marginTop: 9 }}>
        <ActionButton label="Add" style={composerActionStyle} disabled={busy || !effortSupported} onClick={() => onCreate(executionRuntime, model || null, effort === 'adaptive' ? null : effort)} />
        <ActionButton label="Add + dispatch" style={composerActionStyle} icon={<Play size={12} strokeWidth={2.2} />} primary disabled={busy || !effortSupported || (executionRuntime === 'cloud' && !remote?.available)} onClick={() => onCreateAndDispatch(executionRuntime, model || null, effort === 'adaptive' ? null : effort)} />
      </div>
    </div>
  );
}
