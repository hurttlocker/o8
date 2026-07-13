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
  RamsButton,
  TabHeading,
  SETTINGS_CONTENT_MAX_WIDTH,
} from './shared';
import { SettingsGroup } from './grouped';
import {
  APP_FONT_STACK,
  RAMS_ACCENT,
  RAMS_HAIRLINE,
  RAMS_HAIRLINE_SOFT,
  RAMS_INK_QUIET,
  PlusGlyph,
  type ConfirmKind,
  type ProjectContextView,
  type ProjectLockView,
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
    runtimeContext,
    projectLocks,
    orgSuggestions,
    loading,
    topError,
    busyKey,
    submitCreate,
    submitEdit,
    handleDelete,
    handleArchiveLock,
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
      maxWidth: SETTINGS_CONTENT_MAX_WIDTH,
      fontFamily: APP_FONT_STACK,
    }}>
      <div style={{
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        gap: 24,
      }}>
        <div style={{ minWidth: 0 }}>
          <TabHeading
            title="projects"
            subtitle="A project is the shared context for a product: multiple repositories, standing instructions, and attached files."
          />
        </div>

        {!isAnythingOpen ? (
          <RamsButton
            onClick={() => {
              setEditingProjectId(null);
              setCreating(true);
            }}
            icon={<PlusGlyph size={11} />}
          >
            New project
          </RamsButton>
        ) : null}
      </div>

      <section>
        <SettingsGroup header="Overview">
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
            gap: 10,
            paddingTop: 14,
            paddingRight: 14,
            paddingBottom: 14,
            paddingLeft: 14,
          }}>
            <ProjectCapability label="Repositories" value={`${repos.length} available`} />
            <ProjectCapability label="Context" value={runtimeContext ? `${runtimeContext.repos.length} scoped` : 'Resolving'} />
            <ProjectCapability
              label="Locks"
              value={`${projectLocks.length} active${projectLocks.some((lock) => lock.stale) ? ' / stale' : ''}`}
              muted={projectLocks.length === 0}
            />
          </div>
        </SettingsGroup>
      </section>

      <section style={{ marginTop: 28 }}>
        <SettingsGroup header="Runtime context">
          <RuntimeContextPanel context={runtimeContext} locks={projectLocks} />
        </SettingsGroup>
      </section>

      {topError ? (
        <div style={{
          marginTop: 28,
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

      <section style={{ marginTop: 28 }}>
        {loading ? (
          <div style={{ paddingTop: 20, paddingBottom: 20, color: RAMS_INK_QUIET, fontSize: 13 }}>
            Loading...
          </div>
        ) : (
          <>
            {orgSuggestions.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 14 }}>
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
              <div style={{ marginBottom: 16 }}>
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
              </div>
            ) : null}

            {projects.length === 0 && !creating ? (
              <ProjectsEmptyState onCreate={() => setCreating(true)} />
            ) : null}

            {projects.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                {projects.map((project) => {
                  const isEditing = editingProjectId === project.id;
                  const isDeleting = busyKey === `delete:${project.id}`;
                  const pendingConfirm = confirm?.kind === 'delete' && confirm.projectId === project.id;
                  const locksForProject = projectLocks.filter((lock) => (
                    lock.projectId === project.id
                    || lock.runtimeProjectId === project.id
                    || lock.projectName.toLowerCase() === project.name.toLowerCase()
                  ));
                  return (
                    <ProjectCard
                      key={project.id}
                      project={project}
                      reposById={reposById}
                      locks={locksForProject}
                      onArchiveLock={(laneId) => { void handleArchiveLock(laneId); }}
                      onEdit={() => {
                        setCreating(false);
                        setEditingProjectId(project.id);
                      }}
                      onDelete={() => { void handleDelete(project.id); }}
                      isEditing={isEditing}
                      isDeleting={isDeleting}
                      archivingLaneId={busyKey?.startsWith('archive-lock:')
                        ? busyKey.slice('archive-lock:'.length)
                        : null}
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
      </section>
    </div>
  );
}

function RuntimeContextPanel({
  context,
  locks,
}: {
  context: ProjectContextView | null;
  locks: ProjectLockView[];
}) {
  const staleCount = locks.filter((lock) => lock.stale).length;

  return (
    <div
      style={{
        paddingTop: 14,
        paddingRight: 16,
        paddingBottom: 14,
        paddingLeft: 16,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{
            fontFamily: APP_FONT_STACK,
            fontSize: 16,
            fontWeight: 350,
            color: 'var(--t-text)',
            letterSpacing: '-0.02em',
          }}>
            {context?.name ?? 'Resolving project'}
          </div>
        </div>
        <div style={{
          fontFamily: APP_FONT_STACK,
          fontSize: 10,
          fontWeight: 350,
          letterSpacing: '0.1em',
          textTransform: 'uppercase',
          color: staleCount > 0 ? '#b45309' : RAMS_INK_QUIET,
          whiteSpace: 'nowrap',
        }}>
          {locks.length} locks{staleCount > 0 ? ` / ${staleCount} stale` : ''}
        </div>
      </div>

      {context ? (
        <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
            {context.repos.map((repo) => (
              <span
                key={repo.id}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  minHeight: 24,
                  padding: '4px 8px',
                  borderRadius: 999,
                  borderWidth: 1,
                  borderStyle: 'solid',
                  borderColor: repo.isPrimary
                    ? 'rgba(37, 99, 235, 0.24)'
                    : repo.isCurrent
                      ? 'rgba(249, 115, 22, 0.22)'
                      : RAMS_HAIRLINE_SOFT,
                  background: repo.isPrimary
                    ? 'rgba(37, 99, 235, 0.055)'
                    : repo.isCurrent
                      ? 'rgba(249, 115, 22, 0.045)'
                      : 'transparent',
                  color: repo.isPrimary ? '#1d4ed8' : 'var(--t-text-secondary)',
                  fontFamily: APP_FONT_STACK,
                  fontSize: 12,
                  fontWeight: repo.isPrimary ? 650 : 500,
                }}
              >
                {repo.name}
                {repo.isPrimary ? (
                  <span style={{
                    fontFamily: APP_FONT_STACK,
                    fontSize: 9,
                    letterSpacing: '0.08em',
                    textTransform: 'uppercase',
                    color: RAMS_INK_QUIET,
                  }}>
                    main
                  </span>
                ) : repo.isCurrent ? (
                  <span style={{
                    fontFamily: APP_FONT_STACK,
                    fontSize: 9,
                    letterSpacing: '0.08em',
                    textTransform: 'uppercase',
                    color: '#c2410c',
                  }}>
                    current
                  </span>
                ) : null}
                {repo.role ? (
                  <span style={{
                    fontFamily: APP_FONT_STACK,
                    fontSize: 9,
                    letterSpacing: '0.08em',
                    textTransform: 'uppercase',
                    color: RAMS_INK_QUIET,
                  }}>
                    {repo.role}
                  </span>
                ) : null}
              </span>
            ))}
          </div>

          <div style={{
            fontFamily: APP_FONT_STACK,
            fontSize: 12.5,
            lineHeight: 1.45,
            color: 'var(--t-text-secondary)',
          }}>
            {context.instructions ? 'Project instructions are active in worker context.' : 'No project instructions yet. Add them on the project card before dispatching cross-repo work.'}
          </div>
        </div>
      ) : (
        <div style={{
          marginTop: 12,
          fontFamily: APP_FONT_STACK,
          fontSize: 12.5,
          lineHeight: 1.45,
          color: RAMS_INK_QUIET,
        }}>
          The app is resolving the active project context.
        </div>
      )}
    </div>
  );
}

function ProjectCapability({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div style={{
      borderRadius: 10,
      borderWidth: 1,
      borderStyle: 'solid',
      borderColor: RAMS_HAIRLINE_SOFT,
      paddingTop: 12,
      paddingRight: 12,
      paddingBottom: 12,
      paddingLeft: 12,
      background: 'transparent',
      minWidth: 0,
    }}>
      <div style={{
        fontFamily: APP_FONT_STACK,
        fontSize: 9.5,
        fontWeight: 350,
        letterSpacing: '0.14em',
        textTransform: 'uppercase',
        color: RAMS_INK_QUIET,
        marginBottom: 5,
      }}>
        {label}
      </div>
      <div style={{
        fontFamily: APP_FONT_STACK,
        fontSize: 13,
        fontWeight: 350,
        color: muted ? RAMS_INK_QUIET : 'var(--t-text)',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      }}>
        {value}
      </div>
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
            fontFamily: APP_FONT_STACK,
            fontSize: 12,
            fontWeight: 400,
            letterSpacing: '-0.01em',
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
