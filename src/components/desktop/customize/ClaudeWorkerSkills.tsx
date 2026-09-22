'use client';

import { useEffect, useMemo, useState } from 'react';
import { RamsButton } from '../settings/shared';

type ProfileResponse = {
  ok?: boolean;
  profile?: { repoSkillAllowlist?: string[] };
  error?: string | { message?: string };
};

const UI_FONT = 'var(--font-sans-system)';
const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,79}$/i;

function responseError(payload: ProfileResponse, fallback: string): string {
  if (typeof payload.error === 'string') return payload.error;
  return payload.error?.message ?? fallback;
}

function parseSkillNames(value: string): { names: string[]; error: string | null } {
  const names = [...new Set(value.split(',').map((name) => name.trim()).filter(Boolean))];
  if (names.length > 8) return { names, error: 'Choose no more than 8 skill names.' };
  if (names.some((name) => !SKILL_NAME_PATTERN.test(name))) {
    return { names, error: 'Use letters, numbers, dots, underscores, or hyphens in skill names.' };
  }
  return { names, error: null };
}

export function ClaudeWorkerSkills() {
  const [value, setValue] = useState('');
  const [savedValue, setSavedValue] = useState('');
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const parsed = useMemo(() => parseSkillNames(value), [value]);

  useEffect(() => {
    let cancelled = false;
    void fetch('/api/runtime/claude-code-profile', { cache: 'no-store' })
      .then(async (response) => {
        const payload = await response.json().catch(() => ({})) as ProfileResponse;
        if (!response.ok || !payload.ok || !payload.profile) {
          throw new Error(responseError(payload, 'Claude Code worker skills are unavailable.'));
        }
        if (cancelled) return;
        const nextValue = (payload.profile.repoSkillAllowlist ?? []).join(', ');
        setValue(nextValue);
        setSavedValue(nextValue);
        setLoaded(true);
      })
      .catch((error) => {
        if (!cancelled) setNotice(error instanceof Error ? error.message : 'Claude Code worker skills are unavailable.');
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const save = async () => {
    if (parsed.error) {
      setNotice(parsed.error);
      return;
    }
    setSaving(true);
    setNotice(null);
    try {
      const response = await fetch('/api/runtime/claude-code-profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repoSkillAllowlist: parsed.names }),
      });
      const payload = await response.json().catch(() => ({})) as ProfileResponse;
      if (!response.ok || !payload.ok || !payload.profile) {
        throw new Error(responseError(payload, 'Repository skill access could not be saved.'));
      }
      const nextValue = (payload.profile.repoSkillAllowlist ?? []).join(', ');
      setValue(nextValue);
      setSavedValue(nextValue);
      setNotice('Saved for future Claude Code worker dispatches.');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Repository skill access could not be saved.');
    } finally {
      setSaving(false);
    }
  };

  const dirty = value !== savedValue;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, paddingTop: 16 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5, paddingLeft: 10, paddingRight: 10 }}>
        <span style={{ fontSize: 13.5, fontWeight: 400, color: 'var(--t-text)' }}>Claude Code worker skills</span>
        <span style={{ fontSize: 12, fontWeight: 300, lineHeight: 1.55, color: 'var(--t-text-secondary)' }}>
          This global list applies across repositories and only affects dispatched Claude Code workers. For each worker, o8 embeds matching .claude/skills/&lt;name&gt;/SKILL.md instructions from that worker&apos;s repository. Missing skills are skipped.
        </span>
      </div>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, paddingLeft: 10, paddingRight: 10 }}>
        <label style={{ minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ fontSize: 10, fontWeight: 300, color: 'var(--t-text-faint)' }}>Allowed skill names, comma-separated (up to 8)</span>
          <input
            aria-label="Claude Code worker skill names"
            value={value}
            onChange={(event) => { setValue(event.target.value); setNotice(null); }}
            disabled={loading || saving || !loaded}
            placeholder="review-only, security-audit"
            style={{
              width: '100%',
              minHeight: 36,
              boxSizing: 'border-box',
              paddingTop: 0,
              paddingRight: 10,
              paddingBottom: 0,
              paddingLeft: 10,
              borderWidth: 1,
              borderStyle: 'solid',
              borderColor: parsed.error ? 'var(--t-brand-red, #b91c1c)' : 'var(--t-border)',
              borderRadius: 9,
              background: 'var(--t-input-bg)',
              color: 'var(--t-text)',
              fontFamily: UI_FONT,
              fontSize: 12,
              outline: 'none',
            }}
          />
        </label>
        <RamsButton
          onClick={() => { void save(); }}
          disabled={loading || saving || !loaded || !dirty || Boolean(parsed.error)}
          busy={saving}
        >
          {saving ? 'Saving…' : 'Save'}
        </RamsButton>
      </div>
      {parsed.error || notice ? (
        <div role="status" style={{ paddingLeft: 10, paddingRight: 10, fontSize: 11, lineHeight: 1.4, color: parsed.error ? 'var(--t-brand-red, #b91c1c)' : 'var(--t-text-muted)' }}>
          {parsed.error ?? notice}
        </div>
      ) : null}
    </div>
  );
}
