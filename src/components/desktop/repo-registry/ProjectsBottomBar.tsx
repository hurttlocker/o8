'use client';

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { PROJECT_COLOR_PALETTE, type ProjectColor, type ProjectRecord } from './useProjects';

interface ProjectsBottomBarProps {
  projects: ProjectRecord[];
  activeProjectId: string;
  onSwitch: (projectId: string) => void;
  onCreate: (name: string) => Promise<ProjectRecord | null>;
  onRename: (projectId: string, name: string) => Promise<boolean>;
  onDelete: (projectId: string) => Promise<boolean>;
  onSetColor: (projectId: string, color: ProjectColor) => Promise<boolean>;
  /** Called when a repo card is dropped onto a project dot. */
  onDropRepoOnProject?: (repoLocalPath: string, targetProjectId: string) => void | Promise<void>;
}

interface DotMenuState {
  projectId: string;
  x: number;
  y: number;
}

const DEFAULT_COLOR: ProjectColor = PROJECT_COLOR_PALETTE[0];

/** MIME-ish key used by the repo-card drag source. Kept in sync with
 *  RepoCard so any drag stays scoped to project moves and doesn't conflict
 *  with native file drops. */
export const REPO_DRAG_TYPE = 'application/x-o8-repo-path';

function ProjectsBottomBarBase({
  projects,
  activeProjectId,
  onSwitch,
  onCreate,
  onRename,
  onDelete,
  onSetColor,
  onDropRepoOnProject,
}: ProjectsBottomBarProps) {
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [draftName, setDraftName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [menu, setMenu] = useState<DotMenuState | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const renameInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (creating && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [creating]);

  useEffect(() => {
    if (renamingId && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [renamingId]);

  useEffect(() => {
    if (!menu) return;
    const handler = () => setMenu(null);
    window.addEventListener('mousedown', handler);
    window.addEventListener('keydown', handler);
    return () => {
      window.removeEventListener('mousedown', handler);
      window.removeEventListener('keydown', handler);
    };
  }, [menu]);

  const cancelCreate = useCallback(() => {
    setCreating(false);
    setDraftName('');
    setSubmitting(false);
  }, []);

  const submitCreate = useCallback(async () => {
    const name = draftName.trim();
    if (!name) {
      cancelCreate();
      return;
    }
    setSubmitting(true);
    const created = await onCreate(name);
    setSubmitting(false);
    if (created) cancelCreate();
  }, [cancelCreate, draftName, onCreate]);

  const beginRename = useCallback((project: ProjectRecord) => {
    setRenamingId(project.id);
    setRenameDraft(project.name);
    setMenu(null);
  }, []);

  const cancelRename = useCallback(() => {
    setRenamingId(null);
    setRenameDraft('');
  }, []);

  const submitRename = useCallback(async () => {
    if (!renamingId) return;
    const name = renameDraft.trim();
    if (!name) {
      cancelRename();
      return;
    }
    const project = projects.find((p) => p.id === renamingId);
    if (project && project.name !== name) {
      await onRename(renamingId, name);
    }
    cancelRename();
  }, [cancelRename, onRename, projects, renameDraft, renamingId]);

  const handleDelete = useCallback(async (projectId: string) => {
    setMenu(null);
    setConfirmDeleteId(null);
    await onDelete(projectId);
  }, [onDelete]);

  const canDelete = projects.length > 1;

  const handleDotDragOver = useCallback((event: React.DragEvent<HTMLButtonElement>, projectId: string) => {
    if (!onDropRepoOnProject) return;
    if (!event.dataTransfer.types.includes(REPO_DRAG_TYPE)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    setDropTargetId(projectId);
  }, [onDropRepoOnProject]);

  const handleDotDragLeave = useCallback((projectId: string) => {
    setDropTargetId((current) => (current === projectId ? null : current));
  }, []);

  const handleDotDrop = useCallback((event: React.DragEvent<HTMLButtonElement>, projectId: string) => {
    if (!onDropRepoOnProject) return;
    const payload = event.dataTransfer.getData(REPO_DRAG_TYPE);
    if (!payload) return;
    event.preventDefault();
    setDropTargetId(null);
    void onDropRepoOnProject(payload, projectId);
  }, [onDropRepoOnProject]);

  return (
    <div
      style={{
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        paddingTop: 8,
        paddingBottom: 8,
        paddingLeft: 14,
        paddingRight: 14,
        borderTop: '1px solid var(--t-divider-subtle)',
        background: 'var(--t-panel, transparent)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          flex: 1,
          minWidth: 0,
          overflowX: 'auto',
          scrollbarWidth: 'none',
        }}
        className="hide-scrollbar"
      >
        {projects.map((project) => {
          const isActive = project.id === activeProjectId;
          const isHovered = hoveredId === project.id;
          const isRenaming = renamingId === project.id;
          const isDropTarget = dropTargetId === project.id;
          const color: ProjectColor = (project.color ?? DEFAULT_COLOR);

          if (isRenaming) {
            return (
              <input
                key={project.id}
                ref={renameInputRef}
                type="text"
                value={renameDraft}
                onChange={(event) => setRenameDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    void submitRename();
                  } else if (event.key === 'Escape') {
                    event.preventDefault();
                    cancelRename();
                  }
                }}
                onBlur={() => { void submitRename(); }}
                placeholder={project.name}
                maxLength={60}
                style={{
                  flexShrink: 0,
                  minWidth: 90,
                  maxWidth: 160,
                  fontSize: 11,
                  fontWeight: 500,
                  color: 'var(--t-text)',
                  background: 'var(--t-input-bg)',
                  border: '1px solid var(--t-input-border, var(--t-divider))',
                  borderRadius: 6,
                  paddingTop: 3,
                  paddingBottom: 3,
                  paddingLeft: 8,
                  paddingRight: 8,
                  outline: 'none',
                  fontFamily: 'var(--font-sans-system)',
                }}
              />
            );
          }

          return (
            <button
              key={project.id}
              type="button"
              title={project.name}
              onClick={() => onSwitch(project.id)}
              onDoubleClick={(event) => {
                event.preventDefault();
                beginRename(project);
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                setMenu({ projectId: project.id, x: event.clientX, y: event.clientY });
              }}
              onMouseEnter={() => setHoveredId(project.id)}
              onMouseLeave={() => setHoveredId((current) => (current === project.id ? null : current))}
              onDragOver={(event) => handleDotDragOver(event, project.id)}
              onDragLeave={() => handleDotDragLeave(project.id)}
              onDrop={(event) => handleDotDrop(event, project.id)}
              style={{
                position: 'relative',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 22,
                height: 22,
                padding: 0,
                borderRadius: 999,
                borderWidth: 1,
                borderStyle: 'solid',
                borderColor: isDropTarget ? color : 'transparent',
                background: isDropTarget ? `${color}1a` : 'transparent',
                cursor: 'pointer',
                transition: 'background 120ms cubic-bezier(0.22, 1, 0.36, 1), border-color 120ms cubic-bezier(0.22, 1, 0.36, 1)',
              }}
            >
              <span
                style={{
                  width: isActive ? 9 : 8,
                  height: isActive ? 9 : 8,
                  borderRadius: '50%',
                  background: color,
                  opacity: isActive ? 1 : isHovered ? 0.78 : 0.55,
                  transition: 'opacity 120ms cubic-bezier(0.22, 1, 0.36, 1), width 120ms cubic-bezier(0.22, 1, 0.36, 1), height 120ms cubic-bezier(0.22, 1, 0.36, 1)',
                  boxShadow: isActive ? `0 0 0 1.5px ${color}33` : 'none',
                }}
              />
            </button>
          );
        })}

        {creating ? (
          <input
            ref={inputRef}
            type="text"
            value={draftName}
            disabled={submitting}
            onChange={(event) => setDraftName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void submitCreate();
              } else if (event.key === 'Escape') {
                event.preventDefault();
                cancelCreate();
              }
            }}
            onBlur={() => {
              if (!submitting) void submitCreate();
            }}
            placeholder="Project name"
            maxLength={60}
            style={{
              flex: 1,
              minWidth: 80,
              maxWidth: 140,
              fontSize: 11,
              fontWeight: 500,
              color: 'var(--t-text)',
              background: 'var(--t-input-bg)',
              border: '1px solid var(--t-input-border, var(--t-divider))',
              borderRadius: 6,
              paddingTop: 3,
              paddingBottom: 3,
              paddingLeft: 8,
              paddingRight: 8,
              outline: 'none',
              fontFamily: 'var(--font-sans-system)',
            }}
          />
        ) : (
          <button
            type="button"
            title="New project"
            onClick={() => setCreating(true)}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 18,
              height: 18,
              borderRadius: 4,
              border: 'none',
              background: 'transparent',
              color: 'var(--t-text-faint)',
              cursor: 'pointer',
              fontSize: 14,
              lineHeight: 1,
              padding: 0,
            }}
            onMouseEnter={(event) => {
              event.currentTarget.style.color = 'var(--t-text)';
              event.currentTarget.style.background = 'var(--t-hover, rgba(148, 163, 184, 0.16))';
            }}
            onMouseLeave={(event) => {
              event.currentTarget.style.color = 'var(--t-text-faint)';
              event.currentTarget.style.background = 'transparent';
            }}
          >
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
              <path d="M5 1 V9 M1 5 H9" />
            </svg>
          </button>
        )}
      </div>

      {menu && typeof document !== 'undefined' ? createPortal(
        <div
          role="menu"
          onMouseDown={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.preventDefault()}
          style={{
            position: 'fixed',
            left: menu.x,
            top: menu.y - 8,
            transform: 'translateY(-100%)',
            minWidth: 200,
            background: 'rgba(20, 24, 30, 0.96)',
            border: '1px solid rgba(255, 255, 255, 0.12)',
            borderRadius: 10,
            boxShadow: '0 18px 44px rgba(0, 0, 0, 0.32)',
            paddingTop: 6,
            paddingBottom: 4,
            paddingLeft: 4,
            paddingRight: 4,
            zIndex: 60,
            fontFamily: 'var(--font-sans-system)',
            // Overlay chrome stays dark + light-text in every theme so the
            // popover never inherits the page's body text color (which is
            // dark in light theme and would render invisible here).
            color: 'rgba(255, 255, 255, 0.94)',
          }}
        >
          <div
            style={{
              fontSize: 10,
              fontWeight: 600,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              color: 'rgba(226, 232, 240, 0.62)',
              paddingTop: 2,
              paddingBottom: 6,
              paddingLeft: 10,
              paddingRight: 10,
            }}
          >
            Color
          </div>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(4, 1fr)',
              gap: 6,
              paddingTop: 2,
              paddingBottom: 4,
              paddingLeft: 8,
              paddingRight: 8,
            }}
          >
            {PROJECT_COLOR_PALETTE.map((swatch) => {
              const project = projects.find((p) => p.id === menu.projectId);
              const active = (project?.color ?? DEFAULT_COLOR) === swatch;
              return (
                <button
                  key={swatch}
                  type="button"
                  aria-label={`Color ${swatch}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    void onSetColor(menu.projectId, swatch);
                    setMenu(null);
                  }}
                  style={{
                    width: 22,
                    height: 22,
                    borderRadius: 999,
                    borderWidth: 1.5,
                    borderStyle: 'solid',
                    borderColor: active ? 'var(--t-text)' : 'transparent',
                    background: swatch,
                    cursor: 'pointer',
                    padding: 0,
                  }}
                />
              );
            })}
          </div>
          <div style={{ height: 1, background: 'rgba(255, 255, 255, 0.08)', marginTop: 6, marginBottom: 4 }} />
          <MenuItem
            label="Rename"
            onClick={() => {
              const project = projects.find((p) => p.id === menu.projectId);
              if (project) beginRename(project);
            }}
          />
          <MenuItem
            label={confirmDeleteId === menu.projectId ? 'Confirm delete' : 'Delete'}
            tone={confirmDeleteId === menu.projectId ? 'fail' : 'default'}
            disabled={!canDelete}
            onClick={() => {
              if (!canDelete) return;
              if (confirmDeleteId === menu.projectId) {
                void handleDelete(menu.projectId);
              } else {
                setConfirmDeleteId(menu.projectId);
              }
            }}
          />
        </div>,
        document.body,
      ) : null}
    </div>
  );
}

function MenuItem({
  label,
  onClick,
  disabled = false,
  tone = 'default',
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  tone?: 'default' | 'fail';
}) {
  // Overlay chrome — always dark surface + light text, see the popover wrapper.
  const color = tone === 'fail'
    ? '#c98686'
    : disabled
      ? 'rgba(226, 232, 240, 0.4)'
      : 'rgba(255, 255, 255, 0.94)';
  return (
    <button
      type="button"
      role="menuitem"
      onClick={(event) => {
        event.stopPropagation();
        if (!disabled) onClick();
      }}
      disabled={disabled}
      style={{
        display: 'flex',
        alignItems: 'center',
        width: '100%',
        paddingTop: 6,
        paddingBottom: 6,
        paddingLeft: 10,
        paddingRight: 10,
        borderRadius: 7,
        border: 'none',
        background: 'transparent',
        color,
        cursor: disabled ? 'default' : 'pointer',
        textAlign: 'left',
        fontSize: 12,
        fontWeight: 500,
        letterSpacing: '-0.005em',
        fontFamily: 'inherit',
      }}
      onMouseEnter={(event) => {
        if (!disabled) event.currentTarget.style.background = 'rgba(255, 255, 255, 0.08)';
      }}
      onMouseLeave={(event) => { event.currentTarget.style.background = 'transparent'; }}
    >
      {label}
    </button>
  );
}

export const ProjectsBottomBar = memo(ProjectsBottomBarBase);
