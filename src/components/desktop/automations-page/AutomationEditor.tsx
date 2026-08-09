'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { computeNextRunAt, validateCron } from '@/lib/automations/cron';
import { useExperimentalGeminiFlag } from '@/lib/operator/use-experimental-gemini';
import { useExperimentalOpencodeFlag } from '@/lib/operator/use-experimental-opencode';
import type {
  AutomationFormState,
  AutomationRecord,
  RegisteredRepo,
  TriggerKind,
} from './types';

const UI_FONT = 'var(--font-sans-system)';
const MONO_FONT = 'var(--font-mono, "SF Mono", Menlo, monospace)';

const inputStyle: React.CSSProperties = {
  width: '100%',
  minHeight: 36,
  paddingTop: 8,
  paddingRight: 11,
  paddingBottom: 8,
  paddingLeft: 11,
  borderWidth: 1,
  borderStyle: 'solid',
  borderColor: 'var(--t-divider)',
  borderRadius: 9,
  background: 'var(--t-input-bg)',
  color: 'var(--t-text)',
  fontSize: 12.5,
  fontWeight: 300,
  letterSpacing: '-0.1px',
  fontFamily: UI_FONT,
  lineHeight: 1.4,
  outline: 'none',
  boxSizing: 'border-box',
};

const buttonStyle: React.CSSProperties = {
  height: 30,
  paddingTop: 0,
  paddingRight: 12,
  paddingBottom: 0,
  paddingLeft: 12,
  borderWidth: 1,
  borderStyle: 'solid',
  borderColor: 'var(--t-divider)',
  borderRadius: 8,
  background: 'transparent',
  color: 'var(--t-text-muted)',
  fontSize: 12,
  fontWeight: 300,
  letterSpacing: '-0.1px',
  fontFamily: UI_FONT,
  cursor: 'pointer',
};

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
  };
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span style={{
        fontSize: 10,
        fontWeight: 300,
        letterSpacing: '0.04em',
        lineHeight: '14px',
        textTransform: 'uppercase',
        color: 'var(--t-text-faint)',
      }}>
        {label}
      </span>
      {children}
    </div>
  );
}

interface PickerOption {
  value: string;
  label: string;
  detail?: string;
}

function InlinePicker({
  value,
  options,
  onChange,
  ariaLabel,
}: {
  value: string;
  options: PickerOption[];
  onChange: (value: string) => void;
  ariaLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const selected = options.find((option) => option.value === value) ?? options[0];

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [open]);

  return (
    <div ref={rootRef} style={{ position: 'relative' }}>
      <button
        type="button"
        aria-label={ariaLabel}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        style={{
          ...inputStyle,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 10,
          cursor: 'pointer',
          textAlign: 'left',
        }}
      >
        <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {selected?.label ?? value}
        </span>
        <ChevronGlyph open={open} />
      </button>
      {open ? (
        <div style={{
          position: 'absolute',
          top: 42,
          right: 0,
          left: 0,
          zIndex: 4,
          maxHeight: 220,
          overflowY: 'auto',
          paddingTop: 4,
          paddingRight: 4,
          paddingBottom: 4,
          paddingLeft: 4,
          borderWidth: 1,
          borderStyle: 'solid',
          borderColor: 'var(--t-divider)',
          borderRadius: 10,
          background: 'var(--t-panel)',
          boxShadow: 'var(--t-shadow-card)',
        }}>
          {options.map((option) => {
            const active = option.value === value;
            return (
              <button
                key={option.value}
                type="button"
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
                style={{
                  width: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  paddingTop: 7,
                  paddingRight: 8,
                  paddingBottom: 7,
                  paddingLeft: 8,
                  borderWidth: 0,
                  borderRadius: 7,
                  background: active ? 'var(--t-input-bg)' : 'transparent',
                  color: 'var(--t-text)',
                  textAlign: 'left',
                  fontFamily: UI_FONT,
                  cursor: 'pointer',
                }}
              >
                <span style={{ width: 12, flexShrink: 0 }}>{active ? <CheckGlyph /> : null}</span>
                <span style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
                  <span style={{ fontSize: 13.5, fontWeight: 300, letterSpacing: '-0.1px', lineHeight: 1.25 }}>
                    {option.label}
                  </span>
                  {option.detail ? (
                    <span style={{
                      fontSize: 9.5,
                      fontWeight: 260,
                      letterSpacing: '-0.4px',
                      lineHeight: 1.25,
                      color: 'var(--t-text-muted)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}>
                      {option.detail}
                    </span>
                  ) : null}
                </span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function ChevronGlyph({ open }: { open: boolean }) {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{
        flexShrink: 0,
        color: 'var(--t-text-faint)',
        transform: open ? 'rotate(180deg)' : 'rotate(0deg)',
        transition: 'transform 120ms cubic-bezier(0.22, 1, 0.36, 1)',
      }}
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

function CheckGlyph() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
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
          <Field label="Trigger">
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              {(['manual', 'cron'] as TriggerKind[]).map((triggerKind) => {
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
                    {triggerKind === 'manual' ? 'Manual' : 'Cron'}
                  </button>
                );
              })}
            </div>
          </Field>
          {form.triggerKind === 'cron' ? (
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
