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
  mainRepoId: string | null;
}

export function emptyFormState(): FormState {
  return { name: '', slug: '', slugTouched: false, description: '', selected: new Map(), mainRepoId: null };
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
    mainRepoId: project.mainRepoId ?? project.repos[0]?.repoId ?? null,
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
      let mainRepoId = current.mainRepoId;
      if (next.has(repoId)) {
        next.delete(repoId);
        if (mainRepoId === repoId) {
          mainRepoId = next.keys().next().value ?? null;
        }
      } else {
        next.set(repoId, null);
        if (!mainRepoId) mainRepoId = repoId;
      }
      return { ...current, selected: next, mainRepoId };
    });
  };
  const setRepoRole = (repoId: string, role: ProjectRole | null) => {
    setState((current) => {
      const next = new Map(current.selected);
      next.set(repoId, role);
      return { ...current, selected: next };
    });
  };
  const setMainRepo = (repoId: string) => {
    setState((current) => {
      if (!current.selected.has(repoId)) return current;
      return { ...current, mainRepoId: repoId };
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
    borderRadius: 12,
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
        borderRadius: 12,
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: RAMS_HAIRLINE_SOFT,
        background: 'color-mix(in srgb, var(--t-panel-solid, #fff) 72%, transparent)',
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div style={{
          fontFamily: APP_FONT_STACK,
          fontSize: 18,
          fontWeight: 350,
          letterSpacing: '-0.025em',
          color: 'var(--t-text)',
          lineHeight: 1.15,
        }}>
          {mode === 'create' ? 'Create project context' : 'Edit project context'}
        </div>
        <div style={{
          fontFamily: APP_FONT_STACK,
          fontSize: 12.5,
          lineHeight: 1.45,
          color: RAMS_INK_QUIET,
          maxWidth: 560,
        }}>
          Combine repositories, project instructions, and file context for the work agents should understand together.
        </div>
      </div>

      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
        gap: 12,
      }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ fontFamily: APP_FONT_STACK, fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: RAMS_INK_QUIET }}>
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
          <span style={{ fontFamily: APP_FONT_STACK, fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: RAMS_INK_QUIET }}>
            Slug
          </span>
          <input
            value={state.slug}
            onChange={(e) => updateSlug(e.target.value)}
            placeholder="o8"
            style={{ ...inputStyle, fontFamily: MONO_FONT_STACK, fontSize: 12 }}
          />
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span style={{ fontFamily: APP_FONT_STACK, fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: RAMS_INK_QUIET }}>
          Instructions
        </span>
        <textarea
          value={state.description}
          onChange={(e) => updateDescription(e.target.value)}
          rows={4}
          placeholder="Tell agents how to work in this project."
          style={{ ...inputStyle, resize: 'vertical', minHeight: 96, lineHeight: 1.5 }}
        />
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <span style={{ fontFamily: APP_FONT_STACK, fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: RAMS_INK_QUIET }}>
          Repositories
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
                isMain={state.mainRepoId === repo.id}
                onToggle={() => toggleRepo(repo.id)}
                onSetMain={() => setMainRepo(repo.id)}
                onChangeRole={(role) => setRepoRole(repo.id, role)}
              />
            ))}
          </div>
        )}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <span style={{ fontFamily: APP_FONT_STACK, fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: RAMS_INK_QUIET }}>
          Files
        </span>
        <button
          type="button"
          disabled
          style={{
            minHeight: 70,
            borderRadius: 6,
            borderWidth: 1,
            borderStyle: 'dashed',
            borderColor: RAMS_HAIRLINE_SOFT,
            background: 'transparent',
            color: RAMS_INK_QUIET,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
            fontFamily: APP_FONT_STACK,
            fontSize: 13,
            cursor: 'default',
          }}
        >
          <span aria-hidden style={{ fontSize: 18, lineHeight: 1 }}>+</span>
          Add files
          <span style={{
            fontFamily: APP_FONT_STACK,
            fontSize: 9.5,
            letterSpacing: '0.12em',
            textTransform: 'uppercase',
            color: RAMS_INK_QUIET,
          }}>
            soon
          </span>
        </button>
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
