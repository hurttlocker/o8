'use client';

/**
 * Settings → Projects (epic #899 wave 2).
 *
 * Operator-curated repo groupings. UI surfaces:
 *   1. GitHub-org auto-suggest soft strip (when 2+ repos share an org and no
 *      project covers them) with [Group] and [Dismiss] actions.
 *   2. Project cards list — name + slug, member-repo chips with role badges,
 *      Edit + Delete actions.
 *   3. Inline create/edit form (NOT a modal) with name → auto-slug, optional
 *      description, repo picker checkboxes + role popover (custom — no native
 *      <select>, per the packet-card density rule).
 *
 * Subcomponents live in `./projects/*` so the panel stays under the
 * 800-line ceiling. Data + mutations are extracted into `useProjectsData`.
 *
 * Backed by the storage / API layer shipped in wave 1
 * (`src/lib/projects/store.ts` + `/api/projects/*`).
 */

import { useState } from 'react';
import {
  HairlineRule,
  RamsButton,
  SectionLabel,
  TabBreadcrumb,
  TabHeading,
} from './shared';
import {
  APP_FONT_STACK,
  MONO_FONT_STACK,
  RAMS_ACCENT,
  RAMS_HAIRLINE,
  RAMS_INK_QUIET,
  PlusGlyph,
  type ConfirmKind,
} from './projects/shared';
import { OrgSuggestionStrip } from './projects/OrgSuggestionStrip';
import { ProjectCard } from './projects/ProjectCard';
import { ProjectForm, emptyFormState, formStateFromProject } from './projects/ProjectForm';
import { useProjectsData } from './projects/useProjectsData';

export function ProjectsPanel() {
  const data = useProjectsData();
  const {
    projects,
    repos,
    reposById,
    orgSuggestions,
    loading,
    topError,
    busyKey,
    submitCreate,
    submitEdit,
    handleDelete,
    handleDismissSuggestion,
    handleGroupSuggestion,
  } = data;

  const [creating, setCreating] = useState(false);
  const [editingProjectId, setEditingProjectId] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ConfirmKind>(null);

  const isAnythingOpen = creating || editingProjectId !== null;

  return (
    <div style={{
      paddingTop: 8,
      paddingLeft: 8,
      paddingRight: 32,
      paddingBottom: 40,
      maxWidth: 880,
      fontFamily: APP_FONT_STACK,
    }}>
      <TabBreadcrumb tab="projects" />
      <TabHeading
        title="projects"
        subtitle="Group repos that belong to the same product. Decisions in one cascade through all of them — directives, outcomes, and dispatches scope to the project."
      />

      {topError ? (
        <div style={{
          marginBottom: 18,
          paddingTop: 10,
          paddingRight: 14,
          paddingBottom: 10,
          paddingLeft: 14,
          borderRadius: 4,
          borderWidth: 1,
          borderStyle: 'solid',
          borderColor: 'rgba(239, 68, 68, 0.25)',
          background: 'rgba(239, 68, 68, 0.06)',
          color: '#b91c1c',
          fontSize: 12.5,
          lineHeight: 1.5,
        }}>
          {topError}
        </div>
      ) : null}

      <section>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 16, marginBottom: 12 }}>
          <SectionLabel number="01">PROJECTS</SectionLabel>
          {!isAnythingOpen ? (
            <RamsButton onClick={() => setCreating(true)} icon={<PlusGlyph size={11} />}>
              New project
            </RamsButton>
          ) : null}
        </div>

        {loading ? (
          <div style={{ paddingTop: 20, paddingBottom: 20, color: RAMS_INK_QUIET, fontSize: 13 }}>
            Loading…
          </div>
        ) : (
          <>
            {orgSuggestions.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 18 }}>
                {orgSuggestions.map((suggestion) => (
                  <OrgSuggestionStrip
                    key={suggestion.fingerprint}
                    suggestion={suggestion}
                    onGroup={() => { void handleGroupSuggestion(suggestion); }}
                    onDismiss={() => { void handleDismissSuggestion(suggestion); }}
                    busy={busyKey === `group:${suggestion.fingerprint}` || busyKey === `dismiss:${suggestion.fingerprint}`}
                  />
                ))}
              </div>
            ) : null}

            {creating ? (
              <ProjectForm
                mode="create"
                initial={emptyFormState()}
                repos={repos}
                busy={busyKey === 'create'}
                onCancel={() => setCreating(false)}
                onSubmit={async (state) => {
                  await submitCreate(state, 'manual');
                  setCreating(false);
                }}
              />
            ) : null}

            {projects.length === 0 && !creating ? (
              <ProjectsEmptyState onCreate={() => setCreating(true)} />
            ) : null}

            {projects.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: creating ? 14 : 0 }}>
                {projects.map((project) => {
                  const isEditing = editingProjectId === project.id;
                  const isDeleting = busyKey === `delete:${project.id}`;
                  const pendingConfirm = confirm?.kind === 'delete' && confirm.projectId === project.id;
                  return (
                    <ProjectCard
                      key={project.id}
                      project={project}
                      reposById={reposById}
                      onEdit={() => {
                        setCreating(false);
                        setEditingProjectId(project.id);
                      }}
                      onDelete={() => { void handleDelete(project.id); }}
                      isEditing={isEditing}
                      isDeleting={isDeleting}
                      pendingConfirm={pendingConfirm}
                      onRequestConfirm={() => setConfirm({ kind: 'delete', projectId: project.id })}
                      onCancelConfirm={() => setConfirm(null)}
                      formProps={isEditing ? {
                        initial: formStateFromProject(project),
                        repos,
                        busy: busyKey === `edit:${project.id}`,
                        onCancel: () => setEditingProjectId(null),
                        onSubmit: async (state) => {
                          await submitEdit(project.id, project, state);
                          setEditingProjectId(null);
                        },
                      } : undefined}
                    />
                  );
                })}
              </div>
            ) : null}
          </>
        )}

        <div style={{ marginTop: 28 }}>
          <HairlineRule />
        </div>
      </section>
    </div>
  );
}

function ProjectsEmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div
      style={{
        marginTop: 4,
        paddingTop: 28,
        paddingRight: 24,
        paddingBottom: 28,
        paddingLeft: 24,
        borderRadius: 4,
        borderWidth: 1,
        borderStyle: 'dashed',
        borderColor: RAMS_HAIRLINE,
        background: 'transparent',
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      }}
    >
      <div style={{
        fontFamily: APP_FONT_STACK,
        fontSize: 14,
        color: 'var(--t-text-secondary)',
        lineHeight: 1.55,
        letterSpacing: '-0.005em',
        maxWidth: 540,
      }}>
        Group repos that belong to the same product. Decisions in one cascade through all of them.
      </div>
      <div>
        <button
          type="button"
          onClick={onCreate}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            paddingTop: 4,
            paddingRight: 0,
            paddingBottom: 4,
            paddingLeft: 0,
            background: 'transparent',
            borderWidth: 0,
            color: RAMS_ACCENT,
            fontFamily: MONO_FONT_STACK,
            fontSize: 11.5,
            fontWeight: 500,
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
            cursor: 'pointer',
          }}
        >
          Create your first project
          <span aria-hidden="true">→</span>
        </button>
      </div>
    </div>
  );
}
