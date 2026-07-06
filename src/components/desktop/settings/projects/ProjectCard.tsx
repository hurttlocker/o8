'use client';

/**
 * ProjectCard — single project row with header, repo chips, edit/delete
 * actions, and an embedded ProjectForm when editing. Delete uses an inline
 * confirmation strip (no native confirm modal) to match the rest of the
 * approval-cards pattern.
 */

import { RamsButton } from '../shared';
import { SettingsRow } from '../grouped';
import { useState, type ReactNode } from 'react';
import {
  APP_FONT_STACK,
  MONO_FONT_STACK,
  RAMS_ACCENT,
  RAMS_HAIRLINE,
  RAMS_HAIRLINE_SOFT,
  RAMS_INK_QUIET,
  FolderGlyph,
  PlusGlyph,
  RepoChip,
  type ProjectContextApiResponse,
  type ProjectLockView,
} from './shared';
import { ProjectForm, type FormState } from './ProjectForm';
import type { ProjectWithRepos } from '@/lib/projects/types';
import type { RepoRegistryEntry } from '@/lib/repos/types';

export function ProjectCard({
  project,
  reposById,
  locks,
  onEdit,
  onDelete,
  onArchiveLock,
  isEditing,
  isDeleting,
  archivingLaneId,
  pendingConfirm,
  onRequestConfirm,
  onCancelConfirm,
  formProps,
}: {
  project: ProjectWithRepos;
  reposById: Map<string, RepoRegistryEntry>;
  locks: ProjectLockView[];
  onEdit: () => void;
  onDelete: () => void;
  onArchiveLock: (laneId: string) => void;
  isEditing: boolean;
  isDeleting: boolean;
  archivingLaneId: string | null;
  pendingConfirm: boolean;
  onRequestConfirm: () => void;
  onCancelConfirm: () => void;
  formProps?: {
    initial: FormState;
    repos: RepoRegistryEntry[];
    busy: boolean;
    onCancel: () => void;
    onSubmit: (state: FormState) => Promise<void>;
  };
}) {
  const [briefOpen, setBriefOpen] = useState(false);
  const [brief, setBrief] = useState<string | null>(null);
  const [briefLoading, setBriefLoading] = useState(false);
  const [briefError, setBriefError] = useState<string | null>(null);

  const toggleBrief = () => {
    const nextOpen = !briefOpen;
    setBriefOpen(nextOpen);
    if (!nextOpen || brief || briefLoading) return;
    setBriefLoading(true);
    setBriefError(null);
    fetch(`/api/projects/context?projectId=${encodeURIComponent(project.id)}`, { cache: 'no-store' })
      .then(async (res) => {
        const data = (await res.json().catch(() => ({}))) as ProjectContextApiResponse;
        if (!res.ok) throw new Error(data.error ?? 'Failed to load task brief.');
        setBrief(data.taskBrief ?? 'No task brief returned.');
      })
      .catch((err) => {
        setBriefError(err instanceof Error ? err.message : 'Failed to load task brief.');
      })
      .finally(() => setBriefLoading(false));
  };

  return (
    <div
      style={{
        position: 'relative',
        paddingTop: 18,
        paddingRight: 20,
        paddingBottom: 18,
        paddingLeft: 20,
        borderRadius: 12,
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: RAMS_HAIRLINE_SOFT,
        background: 'color-mix(in srgb, var(--t-panel-solid, #fff) 78%, transparent)',
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontFamily: APP_FONT_STACK,
            fontSize: 18,
            fontWeight: 350,
            color: 'var(--t-text)',
            letterSpacing: '-0.02em',
            lineHeight: 1.2,
          }}>
            {project.name}
          </div>
          <div style={{
            fontFamily: APP_FONT_STACK,
            fontSize: 11,
            color: RAMS_INK_QUIET,
            marginTop: 4,
            letterSpacing: '-0.01em',
          }}>
            {project.slug}
          </div>
        </div>

        {!isEditing ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
            {pendingConfirm ? (
              <>
                <span style={{
                  fontFamily: APP_FONT_STACK,
                  fontSize: 10,
                  letterSpacing: '0.14em',
                  textTransform: 'uppercase',
                  color: '#b91c1c',
                  marginRight: 4,
                }}>
                  Delete?
                </span>
                <RamsButton variant="danger" onClick={onDelete} busy={isDeleting} disabled={isDeleting}>
                  Confirm
                </RamsButton>
                <RamsButton variant="ghost" onClick={onCancelConfirm} disabled={isDeleting}>
                  Cancel
                </RamsButton>
              </>
            ) : (
              <>
                <RamsButton variant="ghost" onClick={onEdit}>Edit</RamsButton>
                <RamsButton variant="ghost" onClick={toggleBrief}>
                  {briefOpen ? 'Hide brief' : 'Preview brief'}
                </RamsButton>
                <RamsButton variant="ghost" onClick={onRequestConfirm}>Delete</RamsButton>
              </>
            )}
          </div>
        ) : null}
      </div>

      <ProjectContextSection
        label="Instructions"
        action={!isEditing ? 'Edit' : undefined}
        onAction={!isEditing ? onEdit : undefined}
      >
        {project.description ? (
          <div style={{
            fontFamily: APP_FONT_STACK,
            fontSize: 13,
            color: 'var(--t-text-secondary)',
            lineHeight: 1.55,
            letterSpacing: '-0.005em',
            whiteSpace: 'pre-wrap',
          }}>
            {project.description}
          </div>
        ) : (
          <EmptyContextText>No instructions yet.</EmptyContextText>
        )}
      </ProjectContextSection>

      <ProjectContextSection
        label="Repositories"
        action={!isEditing ? 'Edit' : undefined}
        onAction={!isEditing ? onEdit : undefined}
      >
        {project.repos.length > 0 ? (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {project.repos.map((link) => (
              <span key={link.repoId} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                <RepoChip
                  repoName={reposById.get(link.repoId)?.name ?? link.repoId}
                  role={link.role}
                  rolePopoverDisabled
                />
                {project.mainRepoId === link.repoId ? (
                  <span style={{
                    fontFamily: APP_FONT_STACK,
                    fontSize: 9,
                    fontWeight: 400,
                    letterSpacing: '0.08em',
                    textTransform: 'uppercase',
                    color: '#1d4ed8',
                  }}>
                    main
                  </span>
                ) : null}
              </span>
            ))}
          </div>
        ) : (
          <EmptyContextText>No repos linked yet.</EmptyContextText>
        )}
      </ProjectContextSection>

      {briefOpen ? (
        <ProjectContextSection label="Task brief">
          {briefLoading ? (
            <EmptyContextText>Loading brief...</EmptyContextText>
          ) : briefError ? (
            <div style={{
              fontFamily: APP_FONT_STACK,
              fontSize: 12.5,
              color: '#b91c1c',
              lineHeight: 1.45,
            }}>
              {briefError}
            </div>
          ) : (
            <pre style={{
              margin: 0,
              maxHeight: 220,
              overflow: 'auto',
              whiteSpace: 'pre-wrap',
              fontFamily: MONO_FONT_STACK,
              fontSize: 10.5,
              lineHeight: 1.55,
              color: 'var(--t-text-secondary)',
            }}>
              {brief ?? 'No brief loaded.'}
            </pre>
          )}
        </ProjectContextSection>
      ) : null}

      <ProjectContextSection label="Locks">
        {locks.length > 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {locks.slice(0, 4).map((lock) => (
              <div
                key={lock.laneId}
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'minmax(0, 1fr) auto',
                  gap: 10,
                  alignItems: 'center',
                  minHeight: 30,
                  borderRadius: 7,
                  borderWidth: 1,
                  borderStyle: 'solid',
                  borderColor: lock.stale ? 'rgba(245, 158, 11, 0.25)' : RAMS_HAIRLINE_SOFT,
                  paddingTop: 6,
                  paddingRight: 8,
                  paddingBottom: 6,
                  paddingLeft: 8,
                  background: lock.stale ? 'rgba(245, 158, 11, 0.055)' : 'transparent',
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <div style={{
                    fontFamily: APP_FONT_STACK,
                    fontSize: 12,
                    fontWeight: 350,
                    color: 'var(--t-text)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}>
                    {lock.label}
                  </div>
                  <div style={{
                    marginTop: 2,
                    fontFamily: APP_FONT_STACK,
                    fontSize: 10,
                    letterSpacing: '-0.01em',
                    color: RAMS_INK_QUIET,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}>
                    {lock.repoName} / {lock.runtime} / {lock.branch}
                  </div>
                </div>
                <div style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                  <span style={{
                    fontFamily: APP_FONT_STACK,
                    fontSize: 9.5,
                    fontWeight: 400,
                    letterSpacing: '0.1em',
                    textTransform: 'uppercase',
                    color: lock.stale ? '#b45309' : RAMS_INK_QUIET,
                  }}>
                    {lock.stale ? 'stale' : lock.status}
                  </span>
                  {lock.stale || lock.status === 'failed' ? (
                    <button
                      type="button"
                      onClick={() => onArchiveLock(lock.laneId)}
                      disabled={archivingLaneId === lock.laneId}
                      style={{
                        borderWidth: 1,
                        borderStyle: 'solid',
                        borderColor: 'rgba(245, 158, 11, 0.24)',
                        borderRadius: 5,
                        background: 'transparent',
                        color: '#b45309',
                        cursor: archivingLaneId === lock.laneId ? 'default' : 'pointer',
                        paddingTop: 3,
                        paddingRight: 7,
                        paddingBottom: 3,
                        paddingLeft: 7,
                        fontFamily: APP_FONT_STACK,
                        fontSize: 11,
                        fontWeight: 400,
                        letterSpacing: '-0.01em',
                        textTransform: 'capitalize',
                        opacity: archivingLaneId === lock.laneId ? 0.55 : 1,
                      }}
                    >
                      {archivingLaneId === lock.laneId ? 'archiving' : 'archive'}
                    </button>
                  ) : null}
                </div>
              </div>
            ))}
            {locks.length > 4 ? (
              <EmptyContextText>{locks.length - 4} more locks hidden.</EmptyContextText>
            ) : null}
          </div>
        ) : (
          <EmptyContextText>No active locks.</EmptyContextText>
        )}
      </ProjectContextSection>

      <ProjectContextSection label="Files">
        <SettingsRow
          icon={<PlusGlyph size={12} />}
          label="Add files"
          value="Soon"
          disabled
        />
      </ProjectContextSection>

      {isEditing && formProps ? (
        <ProjectForm
          mode="edit"
          initial={formProps.initial}
          repos={formProps.repos}
          busy={formProps.busy}
          onCancel={formProps.onCancel}
          onSubmit={formProps.onSubmit}
        />
      ) : null}
    </div>
  );
}

function ProjectContextSection({
  label,
  action,
  onAction,
  children,
}: {
  label: string;
  action?: string;
  onAction?: () => void;
  children: ReactNode;
}) {
  return (
    <section
      style={{
        borderRadius: 10,
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: RAMS_HAIRLINE_SOFT,
        paddingTop: 12,
        paddingRight: 14,
        paddingBottom: 12,
        paddingLeft: 14,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 7,
            flex: 1,
            minWidth: 0,
            fontFamily: APP_FONT_STACK,
            fontSize: 10,
            fontWeight: 400,
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
            color: RAMS_INK_QUIET,
          }}
        >
          <FolderGlyph size={11} />
          {label}
        </div>
        {action && onAction ? (
          <button
            type="button"
            onClick={onAction}
            style={{
              borderWidth: 1,
              borderStyle: 'solid',
              borderColor: RAMS_HAIRLINE,
              borderRadius: 6,
              background: 'transparent',
              color: RAMS_ACCENT,
              cursor: 'pointer',
              paddingTop: 4,
              paddingRight: 8,
              paddingBottom: 4,
              paddingLeft: 8,
              fontFamily: APP_FONT_STACK,
              fontSize: 11,
              fontWeight: 400,
              letterSpacing: '-0.01em',
            }}
            onMouseEnter={(event) => { event.currentTarget.style.background = 'var(--t-settings-accent-active-bg, rgba(29, 78, 216, 0.06))'; }}
            onMouseLeave={(event) => { event.currentTarget.style.background = 'transparent'; }}
          >
            {action}
          </button>
        ) : null}
      </div>
      {children}
    </section>
  );
}

function EmptyContextText({ children }: { children: ReactNode }) {
  return (
    <div style={{
      fontFamily: APP_FONT_STACK,
      fontSize: 12.5,
      color: RAMS_INK_QUIET,
      lineHeight: 1.45,
    }}>
      {children}
    </div>
  );
}
