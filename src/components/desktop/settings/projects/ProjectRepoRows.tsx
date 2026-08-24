'use client';

/**
 * ProjectRepoRows — the repo membership surface INSIDE a project card. Each
 * member repo is a grouped row with inline actions (set main · remove), and an
 * "Add repository" affordance picks from the connected repos not already in the
 * project. Every action hits the real membership API through the passed
 * handlers and the panel refetches, so the rows always reflect server truth.
 *
 * UnassignedReposGroup is the sibling surface: connected repos in no project at
 * all, so the repo inventory that used to live in Connectors has a home here.
 *
 * Extracted from ProjectCard/ProjectsPanel so both stay under the 800-line
 * ceiling.
 */

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { RowDivider, SettingsGroup, SettingsRow, ValuePill } from '../grouped';
import {
  APP_FONT_STACK,
  MONO_FONT_STACK,
  RAMS_HAIRLINE,
  RAMS_HAIRLINE_SOFT,
  RAMS_INK_QUIET,
  FolderGlyph,
  PlusGlyph,
  XGlyph,
} from './shared';
import type { ProjectWithRepos } from '@/lib/projects/types';
import type { RepoRegistryEntry } from '@/lib/repos/types';

const MAIN_BLUE = '#1d4ed8';
const DESTRUCTIVE = '#d94f3a';

// ── Anchored picker popover (portal) — shared by "Add repository" and the
//    "Add to project" control in the unassigned group. ──

interface PickerItem {
  id: string;
  label: string;
  sublabel?: string;
}

const PICKER_WIDTH = 248;
const PICKER_ROW = 34;

function PickerPopover({
  triggerLabel,
  items,
  emptyLabel,
  busy,
  onPick,
}: {
  triggerLabel: string;
  items: PickerItem[];
  emptyLabel: string;
  busy: boolean;
  onPick: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);

  const toggle = () => {
    if (open) { setOpen(false); return; }
    if (!triggerRef.current || typeof window === 'undefined') return;
    const rect = triggerRef.current.getBoundingClientRect();
    const estHeight = Math.min(Math.max(items.length, 1), 7) * PICKER_ROW + 8;
    const belowTop = rect.bottom + 4;
    const aboveTop = rect.top - 4 - estHeight;
    const openAbove = belowTop + estHeight > window.innerHeight - 8 && aboveTop >= 8;
    setPos({
      top: openAbove
        ? aboveTop
        : Math.max(8, Math.min(belowTop, window.innerHeight - estHeight - 8)),
      left: Math.max(8, Math.min(rect.left, window.innerWidth - PICKER_WIDTH - 8)),
    });
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); close(); }
    };
    const onDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && !triggerRef.current?.contains(target) && !popRef.current?.contains(target)) close();
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    document.addEventListener('pointerdown', onDown, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
      document.removeEventListener('pointerdown', onDown, true);
    };
  }, [open]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={toggle}
        disabled={busy}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          paddingTop: 4,
          paddingRight: 9,
          paddingBottom: 4,
          paddingLeft: 8,
          borderRadius: 5,
          borderWidth: 1,
          borderStyle: 'solid',
          borderColor: RAMS_HAIRLINE_SOFT,
          background: 'transparent',
          color: busy ? RAMS_INK_QUIET : 'var(--t-text-secondary)',
          fontFamily: APP_FONT_STACK,
          fontSize: 11.5,
          fontWeight: 400,
          letterSpacing: '-0.01em',
          cursor: busy ? 'default' : 'pointer',
          whiteSpace: 'nowrap',
          opacity: busy ? 0.6 : 1,
        }}
      >
        <PlusGlyph size={11} />
        {busy ? 'Adding…' : triggerLabel}
      </button>

      {open && pos && typeof document !== 'undefined' ? createPortal(
        <div
          ref={popRef}
          data-o8-settings-portal="true"
          style={{
            position: 'fixed',
            top: pos.top,
            left: pos.left,
            zIndex: 40,
            width: PICKER_WIDTH,
            maxHeight: 7 * PICKER_ROW + 8,
            overflowY: 'auto',
            paddingTop: 4,
            paddingBottom: 4,
            borderRadius: 8,
            borderWidth: 1,
            borderStyle: 'solid',
            borderColor: RAMS_HAIRLINE,
            background: 'var(--t-panel-solid, var(--t-panel))',
            boxShadow: '0 8px 24px rgba(0, 0, 0, 0.18)',
          }}
        >
          {items.length === 0 ? (
            <div style={{
              paddingTop: 8,
              paddingBottom: 8,
              paddingLeft: 12,
              paddingRight: 12,
              fontFamily: APP_FONT_STACK,
              fontSize: 11.5,
              fontWeight: 300,
              color: RAMS_INK_QUIET,
              lineHeight: 1.4,
            }}>
              {emptyLabel}
            </div>
          ) : items.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => { onPick(item.id); setOpen(false); }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                width: '100%',
                paddingTop: 7,
                paddingRight: 12,
                paddingBottom: 7,
                paddingLeft: 12,
                borderWidth: 0,
                background: 'transparent',
                color: 'var(--t-text)',
                fontFamily: APP_FONT_STACK,
                fontSize: 12,
                fontWeight: 400,
                cursor: 'pointer',
                textAlign: 'left',
              }}
            >
              <FolderGlyph size={12} />
              <span style={{ flexShrink: 0 }}>{item.label}</span>
              {item.sublabel ? (
                <span style={{
                  fontFamily: MONO_FONT_STACK,
                  fontSize: 9.5,
                  color: RAMS_INK_QUIET,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  flex: 1,
                  minWidth: 0,
                  textAlign: 'right',
                }}>
                  {item.sublabel}
                </span>
              ) : null}
            </button>
          ))}
        </div>,
        document.body,
      ) : null}
    </>
  );
}

// ── Inline row action buttons ──

function SetMainButton({ onClick, disabled }: { onClick: () => void; disabled: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        paddingTop: 3,
        paddingRight: 8,
        paddingBottom: 3,
        paddingLeft: 8,
        borderRadius: 5,
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: RAMS_HAIRLINE_SOFT,
        background: 'transparent',
        color: disabled ? RAMS_INK_QUIET : MAIN_BLUE,
        fontFamily: APP_FONT_STACK,
        fontSize: 11,
        fontWeight: 400,
        letterSpacing: '-0.01em',
        cursor: disabled ? 'default' : 'pointer',
        whiteSpace: 'nowrap',
        opacity: disabled ? 0.55 : 1,
      }}
    >
      Set main
    </button>
  );
}

function RemoveButton({ onClick, disabled }: { onClick: () => void; disabled: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label="Remove from project"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 24,
        height: 24,
        borderRadius: 5,
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: RAMS_HAIRLINE_SOFT,
        background: 'transparent',
        color: RAMS_INK_QUIET,
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.55 : 1,
        flexShrink: 0,
      }}
      onMouseEnter={(e) => { if (!disabled) e.currentTarget.style.color = DESTRUCTIVE; }}
      onMouseLeave={(e) => { (e.currentTarget.style.color as string) = RAMS_INK_QUIET as string; }}
    >
      <XGlyph size={10} />
    </button>
  );
}

// ── Project repo rows (inside a card) ──

export function ProjectRepoRows({
  project,
  reposById,
  availableRepos,
  interactive,
  busyKey,
  onSetMain,
  onRemoveRepo,
  onAddRepo,
}: {
  project: ProjectWithRepos;
  reposById: Map<string, RepoRegistryEntry>;
  availableRepos: RepoRegistryEntry[];
  interactive: boolean;
  busyKey: string | null;
  onSetMain: (repoId: string) => void;
  onRemoveRepo: (repoId: string) => void;
  onAddRepo: (repoId: string) => void;
}) {
  const links = project.repos;

  return (
    <>
      {links.length > 0 ? (
        links.map((link, index) => {
          const isMain = project.mainRepoId === link.repoId;
          const repoBusy = busyKey === `repo-main:${project.id}:${link.repoId}`
            || busyKey === `repo-remove:${project.id}:${link.repoId}`;
          return (
            <SettingsRow
              key={link.repoId}
              icon={<FolderGlyph size={15} />}
              label={reposById.get(link.repoId)?.name ?? link.repoId}
              accessory={
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                  {link.role ? <ValuePill>{link.role}</ValuePill> : null}
                  {isMain ? (
                    <ValuePill tone="success">Main</ValuePill>
                  ) : interactive ? (
                    <SetMainButton onClick={() => onSetMain(link.repoId)} disabled={repoBusy} />
                  ) : null}
                  {interactive ? (
                    <RemoveButton onClick={() => onRemoveRepo(link.repoId)} disabled={repoBusy} />
                  ) : null}
                </span>
              }
              divider={index < links.length - 1}
            />
          );
        })
      ) : (
        <SettingsRow
          icon={<FolderGlyph size={15} />}
          label="Repositories"
          subtitle="None linked yet"
        />
      )}

      {interactive ? (
        <>
          <RowDivider />
          <div style={{
            display: 'flex',
            alignItems: 'center',
            minHeight: 44,
            paddingTop: 6,
            paddingBottom: 6,
            paddingLeft: 14,
            paddingRight: 14,
          }}>
            <PickerPopover
              triggerLabel="Add repository"
              items={availableRepos.map((repo) => ({ id: repo.id, label: repo.name, sublabel: repo.localPath }))}
              emptyLabel="Every connected repository is already in this project."
              busy={!!busyKey && busyKey.startsWith(`repo-add:${project.id}:`)}
              onPick={onAddRepo}
            />
          </div>
        </>
      ) : null}
    </>
  );
}

// ── Unassigned repos — connected but in no project ──

export function UnassignedReposGroup({
  repos,
  projects,
  busyKey,
  onAddRepoToProject,
}: {
  repos: RepoRegistryEntry[];
  projects: ProjectWithRepos[];
  busyKey: string | null;
  onAddRepoToProject: (projectId: string, repoId: string) => void;
}) {
  if (repos.length === 0) return null;

  return (
    <section style={{ marginTop: 28 }}>
      <SettingsGroup
        header="Not in a project"
        footnote="Connected repositories that aren’t grouped into a project yet."
      >
        {repos.map((repo, index) => (
          <SettingsRow
            key={repo.id}
            icon={<FolderGlyph size={15} />}
            label={repo.name}
            subtitle={repo.localPath}
            accessory={projects.length > 0 ? (
              <PickerPopover
                triggerLabel="Add to project"
                items={projects.map((project) => ({ id: project.id, label: project.name, sublabel: project.slug }))}
                emptyLabel="No projects yet."
                busy={!!busyKey && busyKey.startsWith('repo-add:') && busyKey.endsWith(`:${repo.id}`)}
                onPick={(projectId) => onAddRepoToProject(projectId, repo.id)}
              />
            ) : (
              <ValuePill>Unassigned</ValuePill>
            )}
            divider={index < repos.length - 1}
          />
        ))}
      </SettingsGroup>
    </section>
  );
}
