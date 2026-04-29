'use client';

/**
 * ProjectCard — single project row with header, repo chips, edit/delete
 * actions, and an embedded ProjectForm when editing. Delete uses an inline
 * confirmation strip (no native confirm modal) to match the rest of the
 * approval-cards pattern.
 */

import { RamsButton } from '../shared';
import {
  APP_FONT_STACK,
  MONO_FONT_STACK,
  RAMS_HAIRLINE_SOFT,
  RAMS_INK_QUIET,
  RepoChip,
} from './shared';
import { ProjectForm, type FormState } from './ProjectForm';
import type { ProjectWithRepos } from '@/lib/projects/types';
import type { RepoRegistryEntry } from '@/lib/repos/types';

export function ProjectCard({
  project,
  reposById,
  onEdit,
  onDelete,
  isEditing,
  isDeleting,
  pendingConfirm,
  onRequestConfirm,
  onCancelConfirm,
  formProps,
}: {
  project: ProjectWithRepos;
  reposById: Map<string, RepoRegistryEntry>;
  onEdit: () => void;
  onDelete: () => void;
  isEditing: boolean;
  isDeleting: boolean;
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
  return (
    <div
      style={{
        position: 'relative',
        paddingTop: 18,
        paddingRight: 20,
        paddingBottom: 18,
        paddingLeft: 20,
        borderRadius: 4,
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: RAMS_HAIRLINE_SOFT,
        background: 'transparent',
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontFamily: APP_FONT_STACK,
            fontSize: 17,
            fontWeight: 500,
            color: 'var(--t-text)',
            letterSpacing: '-0.02em',
            lineHeight: 1.2,
          }}>
            {project.name}
          </div>
          <div style={{
            fontFamily: MONO_FONT_STACK,
            fontSize: 10.5,
            color: RAMS_INK_QUIET,
            marginTop: 4,
            letterSpacing: '0.04em',
          }}>
            {project.slug}
          </div>
          {project.description ? (
            <div style={{
              fontFamily: APP_FONT_STACK,
              fontSize: 12.5,
              color: 'var(--t-text-secondary)',
              marginTop: 8,
              lineHeight: 1.5,
              letterSpacing: '-0.005em',
            }}>
              {project.description}
            </div>
          ) : null}
        </div>

        {!isEditing ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
            {pendingConfirm ? (
              <>
                <span style={{
                  fontFamily: MONO_FONT_STACK,
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
                <RamsButton variant="ghost" onClick={onRequestConfirm}>Delete</RamsButton>
              </>
            )}
          </div>
        ) : null}
      </div>

      {project.repos.length > 0 ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {project.repos.map((link) => (
            <RepoChip
              key={link.repoId}
              repoName={reposById.get(link.repoId)?.name ?? link.repoId}
              role={link.role}
              rolePopoverDisabled
            />
          ))}
        </div>
      ) : (
        <div style={{
          fontFamily: APP_FONT_STACK,
          fontSize: 12,
          color: RAMS_INK_QUIET,
          fontStyle: 'italic',
        }}>
          No repos linked yet.
        </div>
      )}

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
