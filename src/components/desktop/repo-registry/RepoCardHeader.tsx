'use client';

import { memo, useState } from 'react';
import { ArrowRight, ExternalLink } from 'lucide-react';
import {
  AlertCircle,
  BlueGlassActionButton,
  BlueGlassHoverCard,
  BlueGlassMetricPill,
  BlueGlassSparklineLane,
  GitBranch,
  GitPullRequest,
  THEME_ACCENT,
  THEME_ACCENT_BORDER,
  THEME_ACCENT_SOFT,
  THEME_SUCCESS_BORDER,
  THEME_SUCCESS_SOFT,
  THEME_SUCCESS_TEXT,
  formatRelativeTime,
  repoReadinessDisplayLabel,
  repoReadinessExplanation,
  repoReadinessPalette,
  shortenPath,
  worktreeStageTone,
  worktreeStatusExplanation,
  type BranchAgent,
  type RepoRegistryEntry,
} from './shared';
import type { RepoCardModel } from './useRepoCardModel';
import { useTheme } from '@/lib/theme/context';

interface RepoCardHeaderProps {
  repo: RepoRegistryEntry;
  agentsByBranch?: Map<string, BranchAgent[]>;
  activePorts?: number[];
  isActive: boolean;
  activeWorkspacePath?: string | null;
  onToggle: () => void;
  onRemove: (repo: RepoRegistryEntry) => void;
  onSelectPR?: (prNumber: number, repo?: string) => void;
  onReviewPR?: (prNumber: number, repo?: string) => void;
  model: Omit<RepoCardModel, 'cardRef'>;
}

function RepoCardHeaderBase({
  repo,
  agentsByBranch,
  activePorts,
  isActive,
  activeWorkspacePath = null,
  onToggle,
  onRemove,
  onSelectPR,
  onReviewPR,
  model,
}: RepoCardHeaderProps) {
  const { themeId } = useTheme();
  const {
    cardWidth,
    hoveringHeader,
    hoverPreviewRect,
    prPreviewLoading,
    prPreview,
    prPreviewDetail,
    previewCheckCounts,
    previewFailingChecks,
    mergeRisk,
    worktreeSummary,
    githubSlug,
    schedulePreviewHover,
    holdPreviewHover,
    closePreviewHover,
  } = model;
  const [confirmingRemove, setConfirmingRemove] = useState(false);

  const compactLayout = cardWidth > 0 && cardWidth < 320;
  const repoAgents = Array.from(
    new Map(
      Array.from(agentsByBranch?.values() ?? []).flatMap((branchAgents) => branchAgents.map((agent) => [agent.sessionKey, agent])),
    ).values(),
  );
  const activeWorktree = (worktreeSummary?.worktrees ?? []).find((worktree) => worktree.path === activeWorkspacePath) ?? null;
  const activeWorktreeTone = activeWorktree ? worktreeStageTone(activeWorktree.status) : null;
  const readinessPalette = repo.readiness ? repoReadinessPalette(repo.readiness.state) : null;
  const readinessDisplayLabel = repoReadinessDisplayLabel(repo.readiness?.state, repo.readiness?.label);
  const readinessExplanation = repoReadinessExplanation(repo.readiness);
  const activeWorktreeExplanation = worktreeStatusExplanation(activeWorktree);
  const rowStatusLabel = activeWorktreeTone?.label ?? readinessDisplayLabel ?? null;
  const rowStatusColor = activeWorktreeTone?.color ?? readinessPalette?.color ?? 'var(--t-text-faint)';
  const rowStatusExplanation = activeWorktreeExplanation ?? readinessExplanation;
  const darkHoverCardStyle = themeId === 'dark'
    ? {
        background: 'linear-gradient(180deg, rgba(68, 75, 85, 0.96) 0%, rgba(54, 60, 69, 0.94) 100%)',
        boxShadow: '0 22px 56px rgba(0, 0, 0, 0.28), 0 8px 24px rgba(15, 23, 42, 0.12)',
      }
    : undefined;
  const showStatusInfo = Boolean(
    rowStatusLabel
    && rowStatusExplanation
    && (activeWorktreeTone?.label || repo.readiness?.state === 'blocked' || repo.readiness?.state === 'needs_setup'),
  );
  const currentBadge = isActive && !activeWorktree ? (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        padding: compactLayout ? '1px 6px' : '2px 7px',
        borderRadius: 999,
        background: 'var(--t-divider-subtle)',
        border: 'none',
        color: 'var(--t-text-secondary)',
        fontSize: 9,
        fontWeight: 600,
        letterSpacing: '0.02em',
        textTransform: 'uppercase',
        flexShrink: 0,
      }}
    >
      Current
    </span>
  ) : null;
  const portsBadge = activePorts && activePorts.length > 0 ? (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: compactLayout ? '1px 5px' : '1px 6px',
        borderRadius: 999,
        background: THEME_SUCCESS_SOFT,
        border: `1px solid ${THEME_SUCCESS_BORDER}`,
        flexShrink: 0,
      }}
    >
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: THEME_SUCCESS_TEXT }} />
      <span
        style={{
          fontSize: 10,
          fontWeight: 600,
          color: THEME_SUCCESS_TEXT,
          fontFamily: '"SF Mono", ui-monospace, monospace',
        }}
      >
        {activePorts.length === 1 ? `:${activePorts[0]}` : `${activePorts.length} ports`}
      </span>
    </span>
  ) : null;
  const prBadge = prPreview.length > 0 ? (
    <span
      role="button"
      tabIndex={0}
      onClick={(event) => {
        event.stopPropagation();
        if (onReviewPR) onReviewPR(0, githubSlug ?? undefined);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && onReviewPR) {
          event.stopPropagation();
          onReviewPR(0, githubSlug ?? undefined);
        }
      }}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        padding: compactLayout ? '2px 7px' : '2px 8px',
        borderRadius: 999,
        background: THEME_ACCENT_SOFT,
        border: `1px solid ${THEME_ACCENT_BORDER}`,
        flexShrink: 0,
        cursor: onReviewPR ? 'pointer' : 'default',
      }}
    >
      <GitPullRequest size={10} strokeWidth={2.2} color="currentColor" />
      <span
        style={{
          fontSize: 10,
          fontWeight: 700,
          color: THEME_ACCENT,
          fontFamily: '"SF Mono", ui-monospace, monospace',
        }}
      >
        {prPreview.length} PR{prPreview.length === 1 ? '' : 's'}
      </span>
    </span>
  ) : null;
  const mergeRiskBadge = prPreview.length > 0 ? (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        padding: '2px 8px',
        borderRadius: 999,
        background: `${mergeRisk.color}14`,
        border: `1px solid ${mergeRisk.color}28`,
        color: mergeRisk.color,
        fontSize: 10,
        fontWeight: 700,
        textTransform: 'uppercase',
        letterSpacing: '0.05em',
        flexShrink: 0,
      }}
    >
      {mergeRisk.label}
    </span>
  ) : null;
  const readinessBadge = repo.readiness ? (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        padding: compactLayout ? '2px 7px' : '2px 8px',
        borderRadius: 999,
        background: readinessPalette?.background,
        border: `1px solid ${readinessPalette?.border}`,
        color: readinessPalette?.color,
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: '0.04em',
        textTransform: 'uppercase',
        flexShrink: 0,
      }}
      title={readinessExplanation ?? repo.readiness.summary}
    >
      {readinessDisplayLabel}
      {readinessExplanation && repo.readiness.state !== 'ready' ? (
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'help',
          }}
          title={readinessExplanation}
          aria-label={readinessExplanation}
        >
          <AlertCircle size={11} strokeWidth={2.1} />
        </span>
      ) : null}
    </span>
  ) : null;
  const branchBadge = (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 3,
        padding: compactLayout ? '1px 5px' : '1px 6px',
        borderRadius: 999,
        background: 'var(--t-divider-subtle)',
        color: 'var(--t-text-secondary)',
        fontSize: 10,
        fontWeight: 600,
        fontFamily: '"SF Mono", ui-monospace, monospace',
        flexShrink: 0,
      }}
    >
      <GitBranch size={10} strokeWidth={2} />
      {repo.defaultBranch}
    </span>
  );
  const repoAgentsBadge = repoAgents.length > 0 ? (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        padding: compactLayout ? '2px 7px' : '2px 8px',
        borderRadius: 999,
        background: 'var(--t-panel-hover)',
        border: '1px solid var(--t-panel-border)',
        color: 'var(--t-text-secondary)',
        fontSize: 10,
        fontWeight: 700,
        flexShrink: 0,
      }}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: '50%',
          background: '#34c759',
          boxShadow: '0 0 8px rgba(52, 199, 89, 0.32)',
        }}
      />
      {repoAgents.length} live
    </span>
  ) : null;
  const headerMetaBadges = [
    currentBadge,
    readinessBadge,
    portsBadge,
    branchBadge,
    repoAgentsBadge,
    prBadge,
    mergeRiskBadge,
  ].filter(Boolean);
  const primaryPreview = prPreview[0] ?? null;
  const rowMetaSegments: Array<{ key: string; content: React.ReactNode }> = [
    {
      key: 'branch',
      content: (
        <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {activeWorktree?.branch ?? repo.defaultBranch}
        </span>
      ),
    },
  ];
  if (rowStatusLabel) {
    rowMetaSegments.push({
      key: 'status',
      content: (
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            minWidth: 0,
            color: rowStatusColor,
            fontWeight: 600,
          }}
          title={rowStatusExplanation ?? undefined}
        >
          <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {rowStatusLabel}
          </span>
          {showStatusInfo ? (
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
                cursor: 'help',
              }}
              title={rowStatusExplanation ?? undefined}
              aria-label={rowStatusExplanation ?? undefined}
            >
              <AlertCircle size={10} strokeWidth={2.1} />
            </span>
          ) : null}
        </span>
      ),
    });
  }
  if (primaryPreview) {
    rowMetaSegments.push({ key: 'pr', content: <span>{`PR #${primaryPreview.number}`}</span> });
  }
  if (repoAgents.length > 0) {
    rowMetaSegments.push({ key: 'live', content: <span>{`${repoAgents.length} live`}</span> });
  }
  rowMetaSegments.splice(3);
  const repoHeaderLeadingInset = 19;
  const showHeaderHover = hoveringHeader && (
    prPreviewLoading
    || prPreview.length > 0
    || headerMetaBadges.length > 0
    || Boolean(repo.readiness?.summary)
  );

  return (
    <>
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
            padding: compactLayout ? '9px 14px 8px' : '10px 14px 9px',
            cursor: 'pointer',
          }}
          onClick={onToggle}
          onMouseEnter={(event) => schedulePreviewHover(event.currentTarget as HTMLDivElement, event.clientX, event.clientY)}
          onMouseLeave={closePreviewHover}
        >
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, minWidth: 0 }}>
            <div style={{ flex: 1, minWidth: 0, paddingLeft: repoHeaderLeadingInset }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                <span
                  style={{
                    fontSize: 13,
                    fontWeight: 700,
                    color: 'var(--t-text)',
                    letterSpacing: '-0.01em',
                    minWidth: 0,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {repo.name}
                </span>
                {isActive ? currentBadge : null}
              </div>
              <div
                style={{
                  marginTop: 2,
                  fontSize: 10,
                  lineHeight: 1.3,
                  color: 'var(--t-text-faint)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {rowMetaSegments.length > 0 ? (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 0, minWidth: 0, maxWidth: '100%' }}>
                    {rowMetaSegments.map((segment, index) => (
                      <span key={segment.key} style={{ display: 'inline-flex', alignItems: 'center', minWidth: 0 }}>
                        {index > 0 ? (
                          <span style={{ padding: '0 5px', color: 'var(--t-text-faint)' }}>·</span>
                        ) : null}
                        {segment.content}
                      </span>
                    ))}
                  </span>
                ) : shortenPath(repo.localPath)}
              </div>
            </div>
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                setConfirmingRemove(true);
              }}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 26,
                height: 26,
                borderRadius: 8,
                border: 'none',
                background: 'transparent',
                color: '#9ca3af',
                cursor: 'pointer',
                flexShrink: 0,
                fontSize: 18,
                fontWeight: 300,
                lineHeight: 0,
                fontFamily: '-apple-system, system-ui, sans-serif',
                appearance: 'none',
                WebkitAppearance: 'none',
                marginRight: -2,
                transition: 'background 140ms ease, color 140ms ease',
              } as React.CSSProperties}
              onMouseEnter={(event) => {
                event.currentTarget.style.color = '#ef4444';
                event.currentTarget.style.background = 'rgba(239, 68, 68, 0.06)';
              }}
              onMouseLeave={(event) => {
                event.currentTarget.style.color = '#9ca3af';
                event.currentTarget.style.background = 'transparent';
              }}
              aria-label={`Remove ${repo.name}`}
            >
              &minus;
            </button>
          </div>
        </div>

        {showHeaderHover ? (
          <BlueGlassHoverCard
            eyebrow={prPreviewLoading || prPreview.length > 0 ? 'Repository Status' : 'Repository'}
            title={prPreviewLoading ? `Checking ${repo.name}…` : repo.name}
            subtitle={prPreviewLoading ? 'Looking for active merge work and repo status.' : shortenPath(repo.localPath)}
            anchorRect={hoverPreviewRect}
            interactive
            onMouseEnter={holdPreviewHover}
            onMouseLeave={closePreviewHover}
            style={darkHoverCardStyle}
            footer={prPreviewLoading ? null : (
              <>
                {prPreview.length > 0 ? (
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <BlueGlassMetricPill label="Review" value={primaryPreview?.reviewDecision || 'pending'} color="#1d4ed8" />
                    <BlueGlassMetricPill label="Files" value={String(primaryPreview?.changedFiles ?? 0)} color="var(--t-text)" />
                    <BlueGlassMetricPill label="Risk" value={mergeRisk.label} color={mergeRisk.color} />
                  </div>
                ) : null}
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                  {primaryPreview && onReviewPR ? (
                    <BlueGlassActionButton
                      icon={<GitPullRequest size={12} strokeWidth={2} />}
                      label="Review"
                      onClick={() => onReviewPR(primaryPreview.number, model.githubSlug ?? undefined)}
                    />
                  ) : null}
                  {primaryPreview && onSelectPR ? (
                    <BlueGlassActionButton
                      icon={<ArrowRight size={12} strokeWidth={2} />}
                      label="Open full PR"
                      onClick={() => onSelectPR(primaryPreview.number, model.githubSlug ?? undefined)}
                    />
                  ) : null}
                  {primaryPreview?.url ? (
                    <BlueGlassActionButton
                      icon={<ExternalLink size={12} strokeWidth={2} />}
                      label="Open on GitHub"
                      onClick={() => window.open(primaryPreview.url, '_blank', 'noopener,noreferrer')}
                    />
                  ) : null}
                </div>
              </>
            )}
          >
            {!prPreviewLoading ? (
              <>
                {headerMetaBadges.length > 0 ? (
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    {headerMetaBadges.map((badge, index) => (
                      <span key={index}>{badge}</span>
                    ))}
                  </div>
                ) : null}
                {repo.readiness?.summary ? (
                  <div style={{ fontSize: 12, lineHeight: 1.55, color: 'var(--t-text-secondary)' }}>
                    {repo.readiness.summary}
                  </div>
                ) : null}
                {prPreview.length > 0 ? (
                  <>
                    <BlueGlassSparklineLane
                      segments={[
                        { label: 'Pass', value: previewCheckCounts.passed, color: '#22c55e' },
                        { label: 'Fail', value: previewCheckCounts.failed, color: '#ef4444' },
                        { label: 'Pending', value: previewCheckCounts.pending, color: '#f59e0b' },
                      ]}
                    />
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 8,
                        fontSize: 11,
                        color: 'var(--t-text-muted)',
                      }}
                    >
                      <span style={{ fontFamily: '"SF Mono", ui-monospace, monospace' }}>{primaryPreview?.headRefName}</span>
                      <span>{primaryPreview ? formatRelativeTime(primaryPreview.createdAt) : null}</span>
                    </div>
                    <div style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--t-text-secondary)' }}>
                      {primaryPreview?.title}
                    </div>
                    {previewFailingChecks.length > 0 ? (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                        <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#dc2626' }}>
                          Top failing checks
                        </div>
                        {previewFailingChecks.map((check) => (
                          <div
                            key={check}
                            style={{
                              fontSize: 11,
                              lineHeight: 1.45,
                              color: 'var(--t-text-secondary)',
                              padding: '6px 8px',
                              borderRadius: 10,
                              background: 'var(--t-panel-hover)',
                            }}
                          >
                            {check}
                          </div>
                        ))}
                      </div>
                    ) : null}
                    {prPreviewDetail?.files?.length ? (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                        <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#1d4ed8' }}>
                          Changed files
                        </div>
                        {prPreviewDetail.files.slice(0, 3).map((file) => (
                          <div
                            key={file.path}
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: 8,
                              padding: '6px 8px',
                              borderRadius: 10,
                              background: 'var(--t-panel-hover)',
                              fontSize: 11,
                            }}
                          >
                            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--t-text)' }}>
                              {file.path}
                            </span>
                            <span style={{ color: 'var(--t-text-secondary)', fontWeight: 700, fontFamily: '"SF Mono", ui-monospace, monospace' }}>+{file.additions}</span>
                            <span style={{ color: 'var(--t-text-secondary)', fontWeight: 700, fontFamily: '"SF Mono", ui-monospace, monospace' }}>-{file.deletions}</span>
                          </div>
                        ))}
                      </div>
                    ) : null}
                    {prPreview.length > 1 ? (
                      <div style={{ fontSize: 11, color: 'var(--t-text-muted)' }}>
                        {prPreview.length - 1} more open PR{prPreview.length - 1 === 1 ? '' : 's'} on this repo.
                      </div>
                    ) : null}
                  </>
                ) : null}
              </>
            ) : null}
          </BlueGlassHoverCard>
        ) : null}

        {confirmingRemove ? (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 8,
              padding: '6px 14px',
              background: 'rgba(239, 68, 68, 0.04)',
              borderBottom: '1px solid rgba(239, 68, 68, 0.1)',
            }}
          >
            <span style={{ fontSize: 11, color: 'var(--t-text-secondary)', fontWeight: 500 }}>
              Remove {repo.name}?
            </span>
            <div style={{ display: 'flex', gap: 6 }}>
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  setConfirmingRemove(false);
                }}
                style={{
                  border: 'none',
                  background: 'transparent',
                  color: 'var(--t-text-muted)',
                  fontSize: 11,
                  fontWeight: 500,
                  cursor: 'pointer',
                  padding: '2px 6px',
                  fontFamily: '-apple-system, system-ui, sans-serif',
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  onRemove(repo);
                  setConfirmingRemove(false);
                }}
                style={{
                  border: 'none',
                  background: 'rgba(239, 68, 68, 0.1)',
                  color: '#ef4444',
                  fontSize: 11,
                  fontWeight: 600,
                  cursor: 'pointer',
                  padding: '2px 8px',
                  borderRadius: 6,
                  fontFamily: '-apple-system, system-ui, sans-serif',
                }}
              >
                Remove
              </button>
            </div>
          </div>
        ) : null}
    </>
  );
}

export const RepoCardHeader = memo(RepoCardHeaderBase);
