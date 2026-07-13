'use client';

/**
 * ProjectCard — one project as ONE dense inset-grouped card (#1450 redesign,
 * operator 2026-07-06: the old four-sub-cards layout was "too spaced out").
 * Title row with actions, then rows: instructions preview, one row per repo
 * (role + main pills), locks (expands only when locks exist), files. Empty
 * sections collapse to a single quiet row instead of an empty card. Delete
 * keeps the inline confirmation strip; editing embeds ProjectForm.
 */

import { RamsButton } from '../shared';
import { RowDivider, SettingsGroup, SettingsRow } from '../grouped';
import { useState } from 'react';
import {
  APP_FONT_STACK,
  MONO_FONT_STACK,
  RAMS_HAIRLINE_SOFT,
  RAMS_INK_QUIET,
  PlusGlyph,
  type ProjectContextApiResponse,
  type ProjectLockView,
} from './shared';
import { ProjectForm, type FormState } from './ProjectForm';
import { ProjectRepoRows } from './ProjectRepoRows';
import type { ProjectWithRepos } from '@/lib/projects/types';
import type { RepoRegistryEntry } from '@/lib/repos/types';

function DocIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="8" y1="13" x2="16" y2="13" />
      <line x1="8" y1="17" x2="13" y2="17" />
    </svg>
  );
}

function LockGlyph() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" style={{ display: 'block', flexShrink: 0 }}>
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}

/** One-line preview for row subtitles — first line, hard cap, ellipsis. */
function oneLine(text: string, max = 96): string {
  const first = text.split('\n').find((line) => line.trim().length > 0)?.trim() ?? '';
  return first.length > max ? `${first.slice(0, max - 1)}…` : first;
}

export function ProjectCard({
  project,
  reposById,
  availableRepos,
  repoBusyKey,
  locks,
  onEdit,
  onDelete,
  onArchiveLock,
  onSetMainRepo,
  onRemoveRepo,
  onAddRepo,
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
  availableRepos: RepoRegistryEntry[];
  repoBusyKey: string | null;
  locks: ProjectLockView[];
  onEdit: () => void;
  onDelete: () => void;
  onArchiveLock: (laneId: string) => void;
  onSetMainRepo: (repoId: string) => void;
  onRemoveRepo: (repoId: string) => void;
  onAddRepo: (repoId: string) => void;
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
  const [locksOpen, setLocksOpen] = useState(false);

  const staleCount = locks.filter((lock) => lock.stale).length;
  const locksValue = locks.length === 0
    ? 'None'
    : staleCount > 0
      ? `${locks.length} active · ${staleCount} stale`
      : `${locks.length} active`;

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
    <SettingsGroup>
      {/* Title row */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        minHeight: 52,
        paddingTop: 10,
        paddingBottom: 10,
        paddingLeft: 14,
        paddingRight: 14,
      }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <span style={{
            fontFamily: APP_FONT_STACK,
            fontSize: 14.5,
            fontWeight: 500,
            color: 'var(--t-text)',
            letterSpacing: '-0.015em',
          }}>
            {project.name}
          </span>
          <span style={{
            fontFamily: MONO_FONT_STACK,
            fontSize: 10.5,
            color: RAMS_INK_QUIET,
            marginLeft: 10,
            letterSpacing: 0,
          }}>
            {project.slug}
          </span>
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
      <RowDivider />

      {/* Instructions */}
      <SettingsRow
        icon={<DocIcon />}
        label="Instructions"
        subtitle={project.description
          ? oneLine(project.description)
          : 'None yet — add standing guidance for dispatched agents'}
        onPress={!isEditing ? onEdit : undefined}
        chevron={!isEditing}
        divider
      />

      {/* Repositories — one row each, inline set-main / remove / add */}
      <ProjectRepoRows
        project={project}
        reposById={reposById}
        availableRepos={availableRepos}
        interactive={!isEditing}
        busyKey={repoBusyKey}
        onSetMain={onSetMainRepo}
        onRemoveRepo={onRemoveRepo}
        onAddRepo={onAddRepo}
      />
      <RowDivider />

      {/* Locks — expands only when there are locks */}
      <SettingsRow
        icon={<LockGlyph />}
        label="Locks"
        value={locksValue}
        pill={staleCount > 0}
        onPress={locks.length > 0 ? () => setLocksOpen((v) => !v) : undefined}
        chevron={locks.length > 0}
        divider
      />
      {locksOpen && locks.length > 0 ? (
        <div style={{ paddingLeft: 54, paddingRight: 14, paddingBottom: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
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
            <div style={{ fontFamily: APP_FONT_STACK, fontSize: 11.5, color: RAMS_INK_QUIET }}>
              {locks.length - 4} more locks hidden.
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Files */}
      <SettingsRow
        icon={<PlusGlyph size={14} />}
        label="Add files"
        value="Soon"
        pill
        disabled
      />

      {/* Task brief preview */}
      {briefOpen ? (
        <>
          <RowDivider />
          <div style={{ paddingTop: 10, paddingBottom: 12, paddingLeft: 14, paddingRight: 14 }}>
            <div style={{
              fontFamily: APP_FONT_STACK,
              fontSize: 10,
              fontWeight: 400,
              letterSpacing: '0.14em',
              textTransform: 'uppercase',
              color: RAMS_INK_QUIET,
              marginBottom: 8,
            }}>
              Task brief
            </div>
            {briefLoading ? (
              <div style={{ fontFamily: APP_FONT_STACK, fontSize: 12.5, color: RAMS_INK_QUIET }}>
                Loading brief...
              </div>
            ) : briefError ? (
              <div style={{ fontFamily: APP_FONT_STACK, fontSize: 12.5, color: '#b91c1c', lineHeight: 1.45 }}>
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
          </div>
        </>
      ) : null}

      {/* Embedded edit form */}
      {isEditing && formProps ? (
        <>
          <RowDivider />
          <div style={{ paddingTop: 12, paddingBottom: 14, paddingLeft: 14, paddingRight: 14 }}>
            <ProjectForm
              mode="edit"
              initial={formProps.initial}
              repos={formProps.repos}
              busy={formProps.busy}
              onCancel={formProps.onCancel}
              onSubmit={formProps.onSubmit}
            />
          </div>
        </>
      ) : null}
    </SettingsGroup>
  );
}
