'use client';

import { memo } from 'react';
import { RepoCardExpandedContent } from './RepoCardExpandedContent';
import { RepoCardHeader } from './RepoCardHeader';
import { RepoCardSettings } from './RepoCardSettings';
import { useRepoCardModel, type RepoCardProps } from './useRepoCardModel';

function RepoCardBase(props: RepoCardProps) {
  const model = useRepoCardModel(props);
  const { cardRef, ...renderModel } = model;

  return (
    <div
      ref={cardRef}
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

      {props.expanded ? (
        <RepoCardExpandedContent
          repo={props.repo}
          agentsByBranch={props.agentsByBranch}
          orchestratorPackets={props.orchestratorPackets}
          activeSessionKey={props.activeSessionKey}
          activeWorkspacePath={props.activeWorkspacePath}
          onSelectSession={props.onSelectSession}
          model={renderModel}
        />
      ) : null}

      <RepoCardSettings repo={props.repo} model={renderModel} />
    </div>
  );
}

export const RepoCard = memo(RepoCardBase);
