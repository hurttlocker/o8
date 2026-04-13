'use client';

import { memo } from 'react';
import { GitBranch, X } from '../lucide-shims';
import type {
  BoardFormProps,
  BoardPillProps,
  DependencyRowProps,
  LabeledFieldProps,
  MetricChipProps,
} from './types';

function BoardFormBase({
  value,
  availableRuntimes,
  onChange,
}: BoardFormProps) {
  return (
    <div className="board-task-form">
      <LabeledField label="Title">
        <input
          value={value.title}
          onChange={(event) => onChange({ ...value, title: event.target.value })}
          placeholder="Summarize the task"
          className="board-task-input"
        />
      </LabeledField>

      <LabeledField label="Prompt">
        <textarea
          value={value.prompt}
          onChange={(event) => onChange({ ...value, prompt: event.target.value })}
          placeholder="Operator prompt or implementation brief"
          className="board-task-textarea operator-textarea"
        />
      </LabeledField>

      <div className="board-task-field-grid">
        <LabeledField label="Runtime">
          <select
            value={value.preferredRuntime}
            onChange={(event) => onChange({ ...value, preferredRuntime: event.target.value === 'claude-code' ? 'claude-code' : 'codex' })}
            className="board-task-select"
          >
            {availableRuntimes.map((runtime) => (
              <option key={runtime.id} value={runtime.id}>
                {runtime.label}
              </option>
            ))}
          </select>
        </LabeledField>

        <LabeledField label="Base Branch">
          <div style={{ position: 'relative' }}>
            <GitBranch size={13} style={{ position: 'absolute', left: 10, top: 11, color: '#64748b' }} />
            <input
              value={value.baseBranch}
              onChange={(event) => onChange({ ...value, baseBranch: event.target.value })}
              placeholder="main"
              className="board-task-input"
              style={{ paddingLeft: 32 }}
            />
          </div>
        </LabeledField>
      </div>

      <div className="board-task-field-grid">
        <LabeledField label="Issue">
          <input
            value={value.issueId}
            onChange={(event) => onChange({ ...value, issueId: event.target.value })}
            placeholder="#123"
            className="board-task-input"
          />
        </LabeledField>

        <LabeledField label="PR">
          <input
            value={value.prId}
            onChange={(event) => onChange({ ...value, prId: event.target.value })}
            placeholder="#456"
            className="board-task-input"
          />
        </LabeledField>
      </div>

      <label className="board-task-checkbox">
        <input
          type="checkbox"
          checked={value.startInPlanMode}
          onChange={(event) => onChange({ ...value, startInPlanMode: event.target.checked })}
        />
        <span>Start in plan mode first</span>
      </label>
    </div>
  );
}

export const BoardForm = memo(BoardFormBase);

function LabeledFieldBase({
  label,
  children,
}: LabeledFieldProps) {
  return (
    <label className="board-task-field">
      <span>
        {label}
      </span>
      {children}
    </label>
  );
}

export const LabeledField = memo(LabeledFieldBase);

function DependencyRowBase({
  label,
  onRemove,
}: DependencyRowProps) {
  return (
    <div className="workflow-file-item board-task-dependency-row">
      <span>{label}</span>
      {onRemove ? (
        <button type="button" onClick={onRemove} className="board-task-inline-button board-task-inline-button-danger">
          <X size={12} />
        </button>
      ) : null}
    </div>
  );
}

export const DependencyRow = memo(DependencyRowBase);

function MetricChipBase({
  label,
  value,
  tone,
}: MetricChipProps) {
  const palette = tone === 'orange'
    ? { color: '#b45309', background: 'rgba(249,115,22,0.12)', border: 'rgba(249,115,22,0.18)' }
    : tone === 'green'
      ? { color: '#15803d', background: 'rgba(34,197,94,0.12)', border: 'rgba(34,197,94,0.18)' }
      : { color: '#1d4ed8', background: 'rgba(37,99,235,0.12)', border: 'rgba(37,99,235,0.18)' };
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      paddingTop: 8,
      paddingRight: 12,
      paddingBottom: 8,
      paddingLeft: 12,
      borderRadius: 999,
      background: palette.background,
      border: `1px solid ${palette.border}`,
      color: palette.color,
      fontSize: 11,
      fontWeight: 700,
    }}>
      <span>{label}</span>
      <span style={{ fontSize: 12 }}>{value}</span>
    </div>
  );
}

export const MetricChip = memo(MetricChipBase);

function BoardPillBase({ children }: BoardPillProps) {
  return (
    <span className="board-task-pill">
      {children}
    </span>
  );
}

export const BoardPill = memo(BoardPillBase);
