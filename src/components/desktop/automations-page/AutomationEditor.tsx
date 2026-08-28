'use client';

import { useEffect, useMemo, useState } from 'react';
import { computeNextRunAt, validateCron } from '@/lib/automations/cron';
import { useExperimentalGeminiFlag } from '@/lib/operator/use-experimental-gemini';
import { useExperimentalOpencodeFlag } from '@/lib/operator/use-experimental-opencode';
import {
  buttonStyle,
  Field,
  InlinePicker,
  inputStyle,
  MONO_FONT,
  type PickerOption,
  UI_FONT,
} from './AutomationEditorControls';
import { AutomationWatchFields } from './AutomationWatchFields';
import type {
  AutomationFormState,
  AutomationRecord,
  RegisteredRepo,
  TriggerKind,
} from './types';

function emptyForm(repos: RegisteredRepo[]): AutomationFormState {
  const first = repos[0];
  return {
    name: '',
    prompt: '',
    runtime: 'codex',
    repoPath: first?.localPath ?? '',
    branch: first?.defaultBranch ?? 'main',
    triggerKind: 'cron',
    cronExpr: '0 9 * * *',
    catchUpPolicy: 'latest',
    repoConcurrencyLimit: 1,
    precheckCommand: '',
    precheckTimeoutMs: 10_000,
    watchSourceKind: 'packet',
    watchSourceId: '',
    watchEventTypes: 'review_requested, completed, failed',
    watchLiteralFilter: '',
    watchQuietMs: 60_000,
    watchMinIntervalMs: 0,
    watchBatchWindowMs: 0,
    watchMaxFiresPerTick: 4,
    watchActionKind: 'dispatch',
    watchTargetLaneId: '',
  };
}

function formFromRecord(record: AutomationRecord): AutomationFormState {
  return {
    name: record.name,
    prompt: record.prompt,
    runtime: record.runtime,
    repoPath: record.repoPath,
    branch: record.branch,
    triggerKind: record.triggerKind,
    cronExpr: record.cronExpr ?? '0 9 * * *',
    catchUpPolicy: record.catchUpPolicy,
    repoConcurrencyLimit: record.repoConcurrencyLimit,
    precheckCommand: record.precheckCommand ?? '',
    precheckTimeoutMs: record.precheckTimeoutMs,
    watchSourceKind: record.watchSourceKind ?? 'packet',
    watchSourceId: record.watchSourceId ?? '',
    watchEventTypes: record.watchEventTypes.join(', '),
    watchLiteralFilter: record.watchLiteralFilter ?? '',
    watchQuietMs: record.watchQuietMs ?? 60_000,
    watchMinIntervalMs: record.watchMinIntervalMs,
    watchBatchWindowMs: record.watchBatchWindowMs,
    watchMaxFiresPerTick: record.watchMaxFiresPerTick,
    watchActionKind: record.watchActionKind,
    watchTargetLaneId: record.watchTargetLaneId ?? '',
  };
}

export function AutomationEditor({
  open,
  initial,
  repos,
  defaultOwner,
  onClose,
  onPersisted,
}: {
  open: boolean;
  initial: AutomationRecord | null;
  repos: RegisteredRepo[];
  defaultOwner: string;
  onClose: () => void;
  onPersisted: (record: AutomationRecord) => void;
}) {
  const editing = initial !== null;
  const [form, setForm] = useState<AutomationFormState>(() => (
    initial ? formFromRecord(initial) : emptyForm(repos)
  ));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const geminiEnabled = useExperimentalGeminiFlag();
  const opencodeEnabled = useExperimentalOpencodeFlag();

  useEffect(() => {
    if (!open) return;
    setForm(initial ? formFromRecord(initial) : emptyForm(repos));
    setError(null);
  }, [initial, open, repos]);

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [onClose, open]);

  const runtimeOptions = useMemo(() => {
    const options: PickerOption[] = [{ value: 'codex', label: 'Codex' }];
    if (geminiEnabled || form.runtime === 'gemini') options.push({ value: 'gemini', label: 'Gemini' });
    if (opencodeEnabled || form.runtime === 'opencode') options.push({ value: 'opencode', label: 'OpenCode 2' });
    return options;
  }, [form.runtime, geminiEnabled, opencodeEnabled]);

  const repoOptions = useMemo<PickerOption[]>(() => repos.map((repo) => ({
    value: repo.localPath,
    label: repo.name,
    detail: repo.localPath,
  })), [repos]);

  const cronValid = form.triggerKind === 'cron' && validateCron(form.cronExpr);
  const nextRunAt = useMemo(
    () => cronValid ? computeNextRunAt(form.cronExpr, Date.now()) : null,
    [cronValid, form.cronExpr],
  );
  const nextRunLabel = nextRunAt
    ? new Date(nextRunAt).toLocaleString([], {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      })
    : null;

  if (!open) return null;

  const update = (patch: Partial<AutomationFormState>) => {
    setForm((current) => ({ ...current, ...patch }));
  };

  const submit = async () => {
    setError(null);
    if (!form.name.trim()) { setError('Name is required.'); return; }
    if (!form.prompt.trim()) { setError('Prompt is required.'); return; }
    if (!form.repoPath.trim()) { setError('Repo is required.'); return; }
    if (form.triggerKind === 'cron' && !validateCron(form.cronExpr)) {
      setError('Enter a valid five-field cron expression.');
      return;
    }
    setSubmitting(true);
    try {
      const payload = {
        ...(editing ? {} : { owner: defaultOwner }),
        name: form.name.trim(),
        prompt: form.prompt.trim(),
        runtime: form.runtime,
        repoPath: form.repoPath.trim(),
        branch: form.branch.trim() || 'main',
        triggerKind: form.triggerKind,
        cronExpr: form.triggerKind === 'cron' ? form.cronExpr.trim() : null,
        catchUpPolicy: form.catchUpPolicy,
        repoConcurrencyLimit: form.repoConcurrencyLimit,
        precheckCommand: form.precheckCommand.trim() || null,
        precheckTimeoutMs: form.precheckTimeoutMs,
        watchSourceKind: form.triggerKind === 'watch' ? form.watchSourceKind : undefined,
        watchSourceId: form.triggerKind === 'watch' ? form.watchSourceId.trim() || null : undefined,
        watchEventTypes: form.triggerKind === 'watch'
          ? form.watchEventTypes.split(',').map((value) => value.trim()).filter(Boolean)
          : undefined,
        watchLiteralFilter: form.triggerKind === 'watch' ? form.watchLiteralFilter.trim() || null : undefined,
        watchQuietMs: form.triggerKind === 'watch' && form.watchSourceKind === 'managed_run'
          ? form.watchQuietMs
          : null,
        watchMinIntervalMs: form.watchMinIntervalMs,
        watchBatchWindowMs: form.watchBatchWindowMs,
        watchMaxFiresPerTick: form.watchMaxFiresPerTick,
        watchActionKind: form.triggerKind === 'watch' ? form.watchActionKind : undefined,
        watchTargetLaneId: form.triggerKind === 'watch' ? form.watchTargetLaneId.trim() || null : undefined,
      };
      const response = await fetch(editing ? `/api/automations/${initial.id}` : '/api/automations', {
        method: editing ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await response.json() as { automation?: AutomationRecord; error?: string };
      if (!response.ok || !data.automation) {
        setError(data.error ?? `${editing ? 'Save' : 'Create'} failed (${response.status})`);
        return;
      }
      onPersisted(data.automation);
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : `${editing ? 'Save' : 'Create'} failed.`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
        zIndex: 100,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        paddingTop: 24,
        paddingRight: 24,
        paddingBottom: 24,
        paddingLeft: 24,
        background: 'var(--t-overlay-scrim)',
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={editing ? 'Edit automation' : 'New automation'}
        onClick={(event) => event.stopPropagation()}
        style={{
          width: '100%',
          maxWidth: 560,
          maxHeight: '88vh',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          borderWidth: 1,
          borderStyle: 'solid',
          borderColor: 'var(--t-divider)',
          borderRadius: 12,
          background: 'var(--t-panel)',
          color: 'var(--t-text)',
          boxShadow: 'var(--t-shadow-card)',
          fontFamily: UI_FONT,
        }}
      >
        <div style={{
          display: 'flex',
          alignItems: 'center',
          paddingTop: 15,
          paddingRight: 18,
          paddingBottom: 13,
          paddingLeft: 18,
          borderBottomWidth: 1,
          borderBottomStyle: 'solid',
          borderBottomColor: 'var(--t-divider)',
        }}>
          <span style={{ fontSize: 13.5, fontWeight: 400, letterSpacing: '-0.1px', lineHeight: 1.25 }}>
            {editing ? 'Edit automation' : 'New automation'}
          </span>
          <span style={{ flex: 1 }} />
          <button type="button" onClick={onClose} aria-label="Close automation editor" style={{ ...buttonStyle, width: 28, paddingRight: 0, paddingLeft: 0, borderWidth: 0 }}>
            <CloseGlyph />
          </button>
        </div>

        <div style={{
          overflowY: 'auto',
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
          paddingTop: 16,
          paddingRight: 18,
          paddingBottom: 18,
          paddingLeft: 18,
        }}>
          <Field label="Name">
            <input
              type="text"
              autoFocus
              aria-label="Automation name"
              placeholder="Daily diff summary"
              value={form.name}
              onChange={(event) => update({ name: event.target.value })}
              style={inputStyle}
            />
          </Field>
          <Field label="Prompt">
            <textarea
              rows={4}
              aria-label="Automation prompt"
              placeholder="What should the agent do each run?"
              value={form.prompt}
              onChange={(event) => update({ prompt: event.target.value })}
              style={{
                ...inputStyle,
                minHeight: 88,
                resize: 'vertical',
              }}
            />
            <span style={{ color: 'var(--t-text-muted)', fontSize: 9.5, fontWeight: 260, letterSpacing: '-0.4px', lineHeight: 1.35 }}>
              For a scheduled read-only Symon check-in, have the automation finish by running{' '}
              <code style={{ fontFamily: MONO_FONT }}>o8 broadcast automation-say &quot;&lt;concise summary&gt;&quot;</code>.
              Quiet hours, subscriptions, deduplication, and the hourly budget still apply.
            </span>
          </Field>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Field label="Runtime">
              <InlinePicker
                value={form.runtime}
                options={runtimeOptions}
                onChange={(runtime) => update({ runtime })}
                ariaLabel="Choose runtime"
              />
            </Field>
            <Field label="Branch">
              <input type="text" aria-label="Branch" value={form.branch} onChange={(event) => update({ branch: event.target.value })} style={inputStyle} />
            </Field>
          </div>
          <Field label="Repo">
            {repoOptions.length > 0 ? (
              <InlinePicker
                value={form.repoPath}
                options={repoOptions}
                onChange={(repoPath) => {
                  const repo = repos.find((candidate) => candidate.localPath === repoPath);
                  update({
                    repoPath,
                    branch: form.branch === 'main' && repo ? repo.defaultBranch : form.branch,
                  });
                }}
                ariaLabel="Choose repository"
              />
            ) : (
              <input
                type="text"
                aria-label="Repository path"
                placeholder="/Users/you/your-repo"
                value={form.repoPath}
                onChange={(event) => update({ repoPath: event.target.value })}
                style={{ ...inputStyle, fontFamily: MONO_FONT }}
              />
            )}
          </Field>
          <Field label="Precheck (optional)">
            <input
              type="text"
              aria-label="Automation precheck command"
              placeholder="git diff --quiet origin/main...HEAD"
              value={form.precheckCommand}
              onChange={(event) => update({ precheckCommand: event.target.value })}
              spellCheck={false}
              style={{ ...inputStyle, fontFamily: MONO_FONT }}
            />
            <span style={{ color: 'var(--t-text-muted)', fontSize: 9.5, fontWeight: 260, letterSpacing: '-0.4px', lineHeight: 1.25 }}>
              Exit 0 launches the agent. Any other exit skips it. Errors fail closed.
            </span>
          </Field>
          {form.precheckCommand.trim() ? (
            <Field label="Precheck timeout (ms)">
              <input
                type="number"
                min={1000}
                max={300000}
                aria-label="Automation precheck timeout in milliseconds"
                value={form.precheckTimeoutMs}
                onChange={(event) => update({
                  precheckTimeoutMs: Math.min(300_000, Math.max(1_000, Number.parseInt(event.target.value, 10) || 10_000)),
                })}
                style={inputStyle}
              />
            </Field>
          ) : null}
          <Field label="Trigger">
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              {(['manual', 'cron', 'watch'] as TriggerKind[]).map((triggerKind) => {
                const active = form.triggerKind === triggerKind;
                return (
                  <button
                    key={triggerKind}
                    type="button"
                    aria-pressed={active}
                    onClick={() => update({ triggerKind })}
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
                    }}
                  >
                    {triggerKind === 'manual' ? 'Manual' : triggerKind === 'cron' ? 'Cron' : 'Watch'}
                  </button>
                );
              })}
            </div>
          </Field>
          {form.triggerKind === 'cron' ? (
            <>
              <Field label="Cron expression">
                <input
                  type="text"
                  aria-label="Cron expression"
                  value={form.cronExpr}
                  onChange={(event) => update({ cronExpr: event.target.value })}
                  placeholder="0 9 * * *"
                  spellCheck={false}
                  style={{ ...inputStyle, fontFamily: MONO_FONT }}
                />
                <span style={{
                  fontSize: 9.5,
                  fontWeight: 260,
                  letterSpacing: '-0.4px',
                  lineHeight: 1.25,
                  color: cronValid ? 'var(--t-text-muted)' : 'var(--t-brand-red)',
                }}>
                  {cronValid
                    ? nextRunLabel ? `Next run ${nextRunLabel}` : 'This schedule has no run in the next year.'
                    : 'Use five fields: minute, hour, day of month, month, day of week.'}
                </span>
              </Field>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <Field label="After downtime">
                  <InlinePicker
                    value={form.catchUpPolicy}
                    options={[
                      { value: 'latest', label: 'Run latest', detail: 'Run only the newest missed slot.' },
                      { value: 'all', label: 'Run all', detail: 'Keep every missed scheduled slot.' },
                      { value: 'skip', label: 'Skip missed', detail: 'Resume at the next future slot.' },
                    ]}
                    onChange={(catchUpPolicy) => update({ catchUpPolicy: catchUpPolicy as AutomationFormState['catchUpPolicy'] })}
                    ariaLabel="Choose catch-up policy"
                  />
                </Field>
                <Field label="Repo concurrency">
                  <input
                    type="number"
                    min={1}
                    max={16}
                    aria-label="Repository concurrency limit"
                    value={form.repoConcurrencyLimit}
                    onChange={(event) => update({
                      repoConcurrencyLimit: Math.min(16, Math.max(1, Number.parseInt(event.target.value, 10) || 1)),
                    })}
                    style={inputStyle}
                  />
                </Field>
              </div>
            </>
          ) : null}
          {form.triggerKind === 'watch' ? (
            <AutomationWatchFields form={form} update={update} />
          ) : null}
          {error ? (
            <div role="alert" style={{ fontSize: 11, fontWeight: 300, letterSpacing: '-0.1px', lineHeight: 1.35, color: 'var(--t-brand-red)' }}>
              {error}
            </div>
          ) : null}
        </div>

        <div style={{
          display: 'flex',
          justifyContent: 'flex-end',
          gap: 8,
          paddingTop: 11,
          paddingRight: 18,
          paddingBottom: 13,
          paddingLeft: 18,
          borderTopWidth: 1,
          borderTopStyle: 'solid',
          borderTopColor: 'var(--t-divider)',
        }}>
          <button type="button" onClick={onClose} disabled={submitting} style={{ ...buttonStyle, opacity: submitting ? 0.5 : 1 }}>
            Cancel
          </button>
          <button
            type="button"
            onClick={() => { void submit(); }}
            disabled={submitting}
            style={{
              ...buttonStyle,
              borderColor: 'var(--t-accent)',
              background: 'var(--t-accent)',
              color: 'var(--t-on-accent)',
              fontWeight: 400,
              opacity: submitting ? 0.65 : 1,
            }}
          >
            {submitting ? (editing ? 'Saving…' : 'Creating…') : (editing ? 'Save' : 'Create')}
          </button>
        </div>
      </div>
    </div>
  );
}

function CloseGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}
