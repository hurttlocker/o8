'use client';

import { memo, useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { RepoCardExpandedContent } from './RepoCardExpandedContent';
import { RepoCardHeader } from './RepoCardHeader';
import { RepoCardSettings } from './RepoCardSettings';
import { useRepoCardModel, type RepoCardProps } from './useRepoCardModel';

interface ProjectMoveOption {
  id: string;
  name: string;
}

interface RepoCardBaseProps extends RepoCardProps {
  /** All projects available to the operator. The right-click "Move to →"
   *  menu is populated from this list, minus the current project. */
  projectsForMove?: ProjectMoveOption[];
  /** Project that currently owns this repo. Filtered out of the move list. */
  currentProjectId?: string | null;
  /** Move the repo to a different project. */
  onMoveToProject?: (repoLocalPath: string, targetProjectId: string) => void | Promise<void>;
}

function RepoCardBase(props: RepoCardBaseProps) {
  const model = useRepoCardModel(props);
  const { cardRef, ...renderModel } = model;

  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (!contextMenu) return;
    const handler = () => setContextMenu(null);
    window.addEventListener('mousedown', handler);
    window.addEventListener('keydown', handler);
    return () => {
      window.removeEventListener('mousedown', handler);
      window.removeEventListener('keydown', handler);
    };
  }, [contextMenu]);

  const moveTargets = (props.projectsForMove ?? []).filter((entry) => entry.id !== props.currentProjectId);

  const handleContextMenu = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (!props.onMoveToProject || moveTargets.length === 0) return;
    event.preventDefault();
    setContextMenu({ x: event.clientX, y: event.clientY });
  }, [moveTargets.length, props.onMoveToProject]);

  const handleDragStart = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (!props.onMoveToProject) return;
    // application/x-o8-repo-path is the scoped MIME used by ProjectsBottomBar
    // drop targets. Plain text fallback so a drop into a generic input still
    // surfaces the path instead of nothing at all.
    event.dataTransfer.setData('application/x-o8-repo-path', props.repo.localPath);
    event.dataTransfer.setData('text/plain', props.repo.localPath);
    event.dataTransfer.effectAllowed = 'move';
  }, [props.onMoveToProject, props.repo.localPath]);

  return (
    <div
      ref={cardRef}
      draggable={Boolean(props.onMoveToProject && moveTargets.length > 0)}
      onDragStart={handleDragStart}
      onContextMenu={handleContextMenu}
      style={{
        position: 'relative',
        borderRadius: 0,
        background: props.isActive ? 'var(--t-panel-hover)' : 'transparent',
        borderTopWidth: 0,
        borderRightWidth: 0,
        borderBottomWidth: 1,
        borderLeftWidth: 0,
        borderTopStyle: 'solid',
        borderRightStyle: 'solid',
        borderBottomStyle: 'solid',
        borderLeftStyle: 'solid',
        borderTopColor: 'transparent',
        borderRightColor: 'transparent',
        borderBottomColor: 'var(--t-divider-subtle)',
        borderLeftColor: 'transparent',
        overflow: 'hidden',
      }}
    >
      <RepoCardHeader
        repo={props.repo}
        agentsByBranch={props.agentsByBranch}
        activePorts={props.activePorts}
        isActive={props.isActive ?? false}
        expanded={props.expanded}
        activeWorkspacePath={props.activeWorkspacePath}
        onToggle={props.onToggle}
        onSelectRepo={props.onSelectRepo ?? (() => {})}
        onRemove={props.onRemove}
        onSelectPR={props.onSelectPR}
        onReviewPR={props.onReviewPR}
        model={renderModel}
      />

      {props.expanded && props.repo.readiness?.state !== 'missing' ? (
        <RepoCardExpandedContent
          repo={props.repo}
          agentsByBranch={props.agentsByBranch}
          orchestratorPackets={props.orchestratorPackets}
          activeSessionKey={props.activeSessionKey}
          activeWorkspacePath={props.activeWorkspacePath}
          activeWorkspaceTabKind={props.activeWorkspaceTabKind}
          onFocusOrchestratorTab={props.onFocusOrchestratorTab}
          onFocusAssistantTab={props.onFocusAssistantTab}
          onSelectSession={props.onSelectSession}
          model={renderModel}
        />
      ) : null}

      {props.repo.readiness?.state !== 'missing' ? <RepoCardSettings repo={props.repo} model={renderModel} /> : null}

      {contextMenu && typeof document !== 'undefined' ? createPortal(
        <div
          role="menu"
          onMouseDown={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.preventDefault()}
          style={{
            position: 'fixed',
            left: contextMenu.x,
            top: contextMenu.y,
            minWidth: 200,
            background: 'rgba(20, 24, 30, 0.96)',
            border: '1px solid rgba(255, 255, 255, 0.12)',
            borderRadius: 10,
            boxShadow: '0 18px 44px rgba(0, 0, 0, 0.32)',
            paddingTop: 4,
            paddingBottom: 4,
            paddingLeft: 4,
            paddingRight: 4,
            zIndex: 60,
            fontFamily: 'var(--font-sans-system)',
            // Overlay chrome — always dark + light text regardless of theme.
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
              paddingTop: 6,
              paddingBottom: 4,
              paddingLeft: 10,
              paddingRight: 10,
            }}
          >
            Move to project
          </div>
          {moveTargets.map((target) => (
            <button
              key={target.id}
              type="button"
              role="menuitem"
              onClick={(event) => {
                event.stopPropagation();
                setContextMenu(null);
                void props.onMoveToProject?.(props.repo.localPath, target.id);
              }}
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
                color: 'rgba(255, 255, 255, 0.94)',
                cursor: 'pointer',
                textAlign: 'left',
                fontSize: 12,
                fontWeight: 500,
                letterSpacing: '-0.005em',
                fontFamily: 'inherit',
              }}
              onMouseEnter={(event) => { event.currentTarget.style.background = 'rgba(255, 255, 255, 0.08)'; }}
              onMouseLeave={(event) => { event.currentTarget.style.background = 'transparent'; }}
            >
              {target.name}
            </button>
          ))}
        </div>,
        document.body,
      ) : null}
    </div>
  );
}

export const RepoCard = memo(RepoCardBase);
