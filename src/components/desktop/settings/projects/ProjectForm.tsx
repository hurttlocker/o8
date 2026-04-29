'use client';

/**
 * ProjectForm — inline create/edit form for a Project. Used in two places:
 *   - At the top of ProjectsPanel when "New project" is clicked.
 *   - Embedded inside an expanded ProjectCard when "Edit" is clicked.
 *
 * Shape lives in FormState; the slug auto-tracks the name until the user
 * touches the slug input themselves.
 */

import { useState, type CSSProperties } from 'react';
import { RamsButton } from '../shared';
import {
  APP_FONT_STACK,
  MONO_FONT_STACK,
  RAMS_ACCENT,
  RAMS_HAIRLINE,
  RAMS_HAIRLINE_SOFT,
  RAMS_INK_QUIET,
  slugifyName,
} from './shared';
import { RepoPickerRow } from './RepoPickerRow';
import type { ProjectRole, ProjectWithRepos } from '@/lib/projects/types';
import type { RepoRegistryEntry } from '@/lib/repos/types';

export interface FormState {
  name: string;
  slug: string;
  slugTouched: boolean;
  description: string;
  selected: Map<string, ProjectRole | null>;
}

export function emptyFormState(): FormState {
  return { name: '', slug: '', slugTouched: false, description: '', selected: new Map() };
}

export function formStateFromProject(project: ProjectWithRepos): FormState {
  const selected = new Map<string, ProjectRole | null>();
  for (const link of project.repos) {
    selected.set(link.repoId, link.role);
  }
  return {
    name: project.name,
    slug: project.slug,
    slugTouched: true,
    description: project.description ?? '',
    selected,
  };
}

export function ProjectForm({
  mode,
  initial,
  repos,
  busy,
  onCancel,
  onSubmit,
}: {
  mode: 'create' | 'edit';
  initial: FormState;
  repos: RepoRegistryEntry[];
  busy: boolean;
  onCancel: () => void;
  onSubmit: (state: FormState) => Promise<void>;
}) {
  const [state, setState] = useState<FormState>(initial);
  const [error, setError] = useState<string | null>(null);

  const updateName = (next: string) => {
    setState((current) => ({
      ...current,
      name: next,
      slug: current.slugTouched ? current.slug : slugifyName(next),
    }));
  };
  const updateSlug = (next: string) => {
    setState((current) => ({ ...current, slug: next, slugTouched: true }));
  };
  const updateDescription = (next: string) => {
    setState((current) => ({ ...current, description: next }));
  };
  const toggleRepo = (repoId: string) => {
    setState((current) => {
      const next = new Map(current.selected);
      if (next.has(repoId)) next.delete(repoId);
      else next.set(repoId, null);
      return { ...current, selected: next };
    });
  };
  const setRepoRole = (repoId: string, role: ProjectRole | null) => {
    setState((current) => {
      const next = new Map(current.selected);
      next.set(repoId, role);
      return { ...current, selected: next };
    });
  };

  const submit = async () => {
    setError(null);
    if (!state.name.trim()) {
      setError('Project name is required.');
      return;
    }
    try {
      await onSubmit(state);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save project.');
    }
  };

  const inputStyle: CSSProperties = {
    width: '100%',
    paddingTop: 8,
    paddingRight: 12,
    paddingBottom: 8,
    paddingLeft: 12,
    borderRadius: 4,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: RAMS_HAIRLINE,
    background: 'var(--t-input-bg, transparent)',
    color: 'var(--t-text)',
    fontFamily: APP_FONT_STACK,
    fontSize: 13,
    letterSpacing: '-0.005em',
    outline: 'none',
  };

  return (
    <div
      style={{
        position: 'relative',
        marginTop: 14,
        paddingTop: 18,
        paddingRight: 18,
        paddingBottom: 18,
        paddingLeft: 18,
        borderRadius: 4,
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: RAMS_HAIRLINE_SOFT,
        background: 'transparent',
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
      }}
    >
      <div style={{
        fontFamily: MONO_FONT_STACK,
        fontSize: 10,
        fontWeight: 500,
        letterSpacing: '0.18em',
        textTransform: 'uppercase',
        color: RAMS_ACCENT,
      }}>
        {mode === 'create' ? '[ NEW PROJECT ]' : '[ EDIT PROJECT ]'}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span style={{ fontFamily: MONO_FONT_STACK, fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: RAMS_INK_QUIET }}>
          Name
        </span>
        <input
          autoFocus
          value={state.name}
          onChange={(e) => updateName(e.target.value)}
          placeholder="o8"
          style={inputStyle}
        />
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span style={{ fontFamily: MONO_FONT_STACK, fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: RAMS_INK_QUIET }}>
          Slug
        </span>
        <input
          value={state.slug}
          onChange={(e) => updateSlug(e.target.value)}
          placeholder="o8"
          style={{ ...inputStyle, fontFamily: MONO_FONT_STACK, fontSize: 12 }}
        />
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span style={{ fontFamily: MONO_FONT_STACK, fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: RAMS_INK_QUIET }}>
          Description (optional)
        </span>
        <textarea
          value={state.description}
          onChange={(e) => updateDescription(e.target.value)}
          rows={2}
          placeholder="What does this product surface include?"
          style={{ ...inputStyle, resize: 'vertical', minHeight: 60, lineHeight: 1.5 }}
        />
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <span style={{ fontFamily: MONO_FONT_STACK, fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: RAMS_INK_QUIET }}>
          Repos
        </span>
        {repos.length === 0 ? (
          <div style={{
            fontFamily: APP_FONT_STACK,
            fontSize: 12,
            color: RAMS_INK_QUIET,
            paddingTop: 8,
            paddingBottom: 8,
            paddingLeft: 8,
          }}>
            No repos in the registry yet. Add some from Connectors first.
          </div>
        ) : (
          <div style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
            maxHeight: 240,
            overflowY: 'auto',
            borderRadius: 4,
            borderWidth: 1,
            borderStyle: 'solid',
            borderColor: RAMS_HAIRLINE_SOFT,
          }}>
            {repos.map((repo) => (
              <RepoPickerRow
                key={repo.id}
                repo={repo}
                checked={state.selected.has(repo.id)}
                role={state.selected.get(repo.id) ?? null}
                onToggle={() => toggleRepo(repo.id)}
                onChangeRole={(role) => setRepoRole(repo.id, role)}
              />
            ))}
          </div>
        )}
      </div>

      {error ? (
        <div style={{
          fontFamily: APP_FONT_STACK,
          fontSize: 12,
          color: '#b91c1c',
          paddingTop: 8,
          paddingRight: 10,
          paddingBottom: 8,
          paddingLeft: 10,
          borderRadius: 4,
          background: 'rgba(239, 68, 68, 0.06)',
          borderWidth: 1,
          borderStyle: 'solid',
          borderColor: 'rgba(239, 68, 68, 0.25)',
        }}>
          {error}
        </div>
      ) : null}

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
        <RamsButton
          onClick={() => { void submit(); }}
          busy={busy}
          disabled={busy || !state.name.trim()}
        >
          {mode === 'create' ? 'Create' : 'Save'}
        </RamsButton>
        <RamsButton variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </RamsButton>
      </div>
    </div>
  );
}
