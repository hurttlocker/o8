'use client';

import {
  AlertCircle,
  ArrowUp,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  FileDiff,
  Folder,
  GitBranch,
  Image as ImageIcon,
  Loader2,
  MessageSquare,
  MoreHorizontal,
  X,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { mobileFontFamily } from '@/app/mobile/mobile-approvals-shared';
import type { MobileInboxSnapshot, MobileOrchestratorThread } from '@/lib/mobile/types';
import { useTheme } from './ThemeContext';
import { relativeLabel, runtimeLabel } from './orchestrator/parts';

type AttentionRowKind = 'thread' | 'pr' | 'item' | 'running';

interface AttentionRow {
  id: string;
  kind: AttentionRowKind;
  repoName: string;
  title: string;
  meta: string;
  branch?: string;
  model?: string;
  additions?: number;
  deletions?: number;
  issue?: number;
  detail?: string;
  href?: string;
  actionLabel?: string;
  icon: 'check' | 'branch' | 'alert' | 'loader';
  muted?: boolean;
  onClick?: () => void;
}

interface OrchestratorLandingProps {
  threads: MobileOrchestratorThread[];
  snapshot?: MobileInboxSnapshot | null;
  threadsLoading: boolean;
  canStartConversation: boolean;
  defaultRepoLabel?: string | null;
  defaultBranchLabel?: string | null;
  orchestratorModelLabel?: string | null;
  connectionLabel: string;
  connectionColor: string;
  onOpenThread: (id: string) => void;
  onStartConversation: (prompt: string) => void;
}

function shortRepoLabel(value?: string | null): string {
  if (!value) return 'Current project';
  const normalized = value.replace(/\/$/, '');
  const parts = normalized.split('/').filter(Boolean);
  return parts[parts.length - 1] || value;
}

function parseDiffStat(value?: string | null): { additions?: number; deletions?: number } {
  if (!value) return {};
  const additions = value.match(/\+(\d+)/);
  const deletions = value.match(/-(\d+)/);
  return {
    additions: additions ? Number(additions[1]) : undefined,
    deletions: deletions ? Number(deletions[1]) : undefined,
  };
}

function modelShortLabel(label?: string | null): string {
  if (!label) return 'claude-4-sonnet';
  return label
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/^claude-/, 'claude-');
}

function renderAttentionIcon(icon: AttentionRow['icon'], color: string) {
  const commonProps = {
    size: 22,
    color,
    strokeWidth: icon === 'loader' ? 2.8 : 2.4,
  };

  switch (icon) {
    case 'check':
      return <CheckCircle2 {...commonProps} />;
    case 'branch':
      return <GitBranch {...commonProps} />;
    case 'alert':
      return <AlertCircle {...commonProps} />;
    case 'loader':
      return <Loader2 {...commonProps} style={{ animation: 'mobile-orchestrator-spin 1s linear infinite' }} />;
    default:
      return null;
  }
}

function makeThreadRows(threads: MobileOrchestratorThread[], onOpenThread: (id: string) => void): AttentionRow[] {
  return threads.slice(0, 4).map((thread) => ({
    id: thread.id,
    kind: 'thread',
    repoName: thread.repoName ?? 'Current project',
    title: thread.title || 'Orchestrator chat',
    meta: `${relativeLabel(thread.lastMessageAt)} / ${thread.repoBranch ?? 'main'}`,
    branch: thread.repoBranch ?? 'main',
    model: runtimeLabel(thread.runtime),
    icon: thread.status === 'busy' ? 'loader' : 'branch',
    muted: thread.status === 'idle',
    onClick: () => onOpenThread(thread.id),
  }));
}

function makeSnapshotRows(
  snapshot: MobileInboxSnapshot | null | undefined,
  fallbackRepoName: string,
  onOpenDetail: (row: AttentionRow) => void,
): AttentionRow[] {
  if (!snapshot) return [];
  const sessionsByKey = new Map(snapshot.sessions.map((session) => [session.sessionKey, session]));
  const reviewDiff = parseDiffStat(snapshot.review?.diffStat);
  const rows: AttentionRow[] = [];

  if (snapshot.review) {
    const pr = snapshot.review.pullRequest;
    const issueText = snapshot.review.issues.length
      ? `Issues ${snapshot.review.issues.map((issue) => `#${issue.number}`).join(', ')}. `
      : '';
    const row: AttentionRow = {
      id: `review:${snapshot.review.branch}`,
      kind: 'pr',
      repoName: shortRepoLabel(snapshot.review.repoSlug) || fallbackRepoName,
      title: pr?.title ?? `Review surface: ${snapshot.review.branch}`,
      meta: `${snapshot.review.changedFiles.length} files / ${snapshot.review.branch}`,
      branch: pr?.headRefName ?? snapshot.review.branch,
      additions: reviewDiff.additions,
      deletions: reviewDiff.deletions,
      issue: pr?.number,
      detail: `${issueText}${snapshot.review.changedFiles.length} changed file${snapshot.review.changedFiles.length === 1 ? '' : 's'} on ${snapshot.review.branch}.`,
      href: pr?.url ?? snapshot.review.desktopHref,
      actionLabel: pr ? 'Open PR' : 'Open review',
      icon: snapshot.review.issues.length > 0 ? 'alert' : 'check',
    };
    row.onClick = () => onOpenDetail(row);
    rows.push(row);
  }

  for (const item of snapshot.items) {
    if (rows.length >= 5) break;
    if (item.kind === 'run_watch') continue;
    if (item.kind === 'review' && snapshot.review) continue;
    const session = item.sessionKey ? sessionsByKey.get(item.sessionKey) : null;
    const action = item.actions.find((candidate) => candidate.available && candidate.href);
    const row: AttentionRow = {
      id: item.id,
      kind: item.kind === 'review' ? 'pr' : 'item',
      repoName: shortRepoLabel(item.metadata?.repoSlug) || shortRepoLabel(session?.workspace) || fallbackRepoName,
      title: item.title,
      meta: `${item.timestampLabel ?? 'now'} / ${session?.branch ?? item.metadata?.branch ?? 'main'}`,
      detail: item.detail,
      href: action?.href,
      actionLabel: action?.label,
      icon: item.kind === 'approval' || item.severity !== 'info' ? 'alert' : 'branch',
    };
    row.onClick = () => onOpenDetail(row);
    rows.push(row);
  }

  return rows;
}

function makeRunningRows(snapshot: MobileInboxSnapshot | null | undefined, fallbackRepoName: string): AttentionRow[] {
  if (!snapshot) return [];
  return snapshot.sessions
    .filter((session) => ['running', 'reviewing', 'waiting', 'blocked', 'failed'].includes(session.status))
    .slice(0, 4)
    .map((session) => ({
      id: `session:${session.sessionKey}`,
      kind: 'running',
      repoName: shortRepoLabel(session.workspace) || fallbackRepoName,
      title: session.name || session.surfaceLabel || 'Background Agent',
      meta: `${session.lastEventAt} / ${session.branch || 'main'}`,
      icon: session.status === 'blocked' || session.status === 'failed' ? 'alert' : 'loader',
      muted: session.status === 'waiting',
    }));
}

function groupRowsByRepo(rows: AttentionRow[], fallbackRepoName: string) {
  const groups: Array<{ repoName: string; rows: AttentionRow[] }> = [];
  const groupIndex = new Map<string, number>();

  for (const row of rows) {
    const repoName = row.repoName || fallbackRepoName;
    const existing = groupIndex.get(repoName);
    if (existing === undefined) {
      groupIndex.set(repoName, groups.length);
      groups.push({ repoName, rows: [row] });
      continue;
    }
    groups[existing].rows.push(row);
  }

  return groups;
}

function OrchestratorDetailSheet({
  row,
  onClose,
  modelLabel,
}: {
  row: AttentionRow | null;
  onClose: () => void;
  modelLabel: string;
}) {
  const { colors } = useTheme();
  if (!row) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="PR detail"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 90,
        background: 'rgba(0, 0, 0, 0.44)',
        display: 'flex',
        alignItems: 'flex-end',
        justifyContent: 'center',
        padding: '0 12px max(env(safe-area-inset-bottom, 0px), 8px)',
      }}
      onClick={onClose}
    >
      <div
        style={{
          width: '100%',
          maxWidth: 430,
          maxHeight: '86vh',
          overflow: 'hidden',
          borderTopLeftRadius: 22,
          borderTopRightRadius: 22,
          borderBottomLeftRadius: 18,
          borderBottomRightRadius: 18,
          borderWidth: 1,
          borderStyle: 'solid',
          borderColor: colors.surfaceBorder,
          background: 'rgba(23, 24, 31, 0.97)',
          color: colors.text,
          boxShadow: '0 -24px 60px rgba(0, 0, 0, 0.48)',
          fontFamily: mobileFontFamily(),
        }}
        onClick={(event) => event.stopPropagation()}
      >
        <div
          style={{
            padding: '10px 28px 22px',
            borderBottomWidth: 1,
            borderBottomStyle: 'solid',
            borderBottomColor: colors.surfaceBorder,
            overflowY: 'auto',
            maxHeight: 'calc(86vh - 112px)',
          }}
        >
          <div
            style={{
              width: 42,
              height: 5,
              borderRadius: 999,
              background: colors.textTertiary,
              margin: '2px auto 28px',
            }}
          />
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 }}>
            <h2
              style={{
                margin: 0,
                fontSize: 29,
                lineHeight: 1.08,
                fontWeight: 760,
                letterSpacing: 0,
                color: colors.text,
              }}
            >
              {row.title}
            </h2>
            <button
              type="button"
              aria-label="Close detail"
              onClick={onClose}
              style={{
                width: 34,
                height: 34,
                borderRadius: 999,
                borderWidth: 0,
                background: 'rgba(255, 255, 255, 0.08)',
                color: colors.textSecondary,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
                flexShrink: 0,
              }}
            >
              <X size={18} />
            </button>
          </div>
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              alignItems: 'center',
              gap: 8,
              marginTop: 18,
              color: colors.textSecondary,
              fontSize: 14,
              fontWeight: 650,
            }}
          >
            <GitBranch size={16} />
            {row.branch ? <span style={{ color: colors.textSecondary }}>{row.branch}</span> : null}
            {typeof row.additions === 'number' ? <span style={{ color: colors.success }}>+{row.additions}</span> : null}
            {typeof row.deletions === 'number' ? <span style={{ color: '#FF5C57' }}>-{row.deletions}</span> : null}
            {typeof row.issue === 'number' ? <span style={{ color: colors.accent }}>#{row.issue}</span> : null}
            <span
              style={{
                padding: '4px 7px',
                borderRadius: 6,
                background: 'rgba(255, 255, 255, 0.07)',
                color: colors.textSecondary,
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              }}
            >
              {row.repoName}
            </span>
            <span>by</span>
            <span
              style={{
                padding: '4px 7px',
                borderRadius: 6,
                background: 'rgba(82, 110, 168, 0.18)',
                color: colors.textSecondary,
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              }}
            >
              {modelLabel}
            </span>
          </div>
          {row.href ? (
            <button
              type="button"
              onClick={() => { window.location.href = row.href!; }}
              style={{
                width: '100%',
                minHeight: 50,
                marginTop: 26,
                borderRadius: 10,
                borderWidth: 1,
                borderStyle: 'solid',
                borderColor: colors.surfaceBorder,
                background: 'rgba(126, 157, 184, 0.75)',
                color: '#162233',
                fontSize: 16,
                fontWeight: 750,
                letterSpacing: 0,
                fontFamily: mobileFontFamily(),
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 10,
                cursor: 'pointer',
              }}
            >
              <FileDiff size={18} />
              {row.actionLabel ?? 'Open detail'}
            </button>
          ) : null}
          <div
            style={{
              marginTop: 28,
              color: colors.textSecondary,
              fontSize: 16,
              lineHeight: 1.42,
              fontWeight: 560,
            }}
          >
            <p style={{ margin: 0 }}>{row.detail || row.meta}</p>
          </div>
        </div>
        <div
          style={{
            padding: '16px 28px 18px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 12,
            background: 'rgba(16, 18, 25, 0.98)',
          }}
        >
          <button
            type="button"
            style={{
              borderRadius: 10,
              borderWidth: 0,
              background: 'rgba(255, 255, 255, 0.10)',
              color: colors.text,
              padding: '10px 14px',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              fontSize: 16,
              fontWeight: 760,
              cursor: 'pointer',
            }}
          >
            <FileDiff size={18} />
            Diff
          </button>
          <button
            type="button"
            style={{
              borderRadius: 10,
              borderWidth: 0,
              background: 'transparent',
              color: colors.textSecondary,
              padding: '10px 14px',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              fontSize: 16,
              fontWeight: 720,
              cursor: 'pointer',
            }}
          >
            <MessageSquare size={18} />
            Chat
          </button>
        </div>
      </div>
    </div>
  );
}

function AttentionListRow({ row }: { row: AttentionRow }) {
  const { colors } = useTheme();
  const active = row.kind === 'pr';
  const iconColor =
    row.icon === 'alert' ? '#FF9F0A'
      : row.icon === 'loader' ? colors.accent
        : row.icon === 'check' ? colors.success
          : colors.textTertiary;

  return (
    <button
      type="button"
      onClick={row.onClick}
      disabled={!row.onClick}
      style={{
        width: '100%',
        minHeight: active ? 78 : 68,
        borderRadius: active ? 18 : 0,
        borderWidth: 0,
        background: active ? 'rgba(35, 68, 105, 0.86)' : 'transparent',
        color: row.muted ? colors.textSecondary : colors.text,
        display: 'grid',
        gridTemplateColumns: '30px minmax(0, 1fr) 18px',
        alignItems: 'center',
        gap: 10,
        padding: active ? '12px 16px' : '10px 2px',
        textAlign: 'left',
        cursor: row.onClick ? 'pointer' : 'default',
        fontFamily: mobileFontFamily(),
        WebkitTapHighlightColor: 'transparent',
      }}
    >
      <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
        {renderAttentionIcon(row.icon, iconColor)}
      </span>
      <span style={{ minWidth: 0, display: 'grid', gap: 5 }}>
        <span
          style={{
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontSize: 20,
            lineHeight: 1.16,
            fontWeight: active ? 760 : 690,
            letterSpacing: 0,
          }}
        >
          {row.title}
        </span>
        <span
          style={{
            display: 'flex',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: 8,
            color: colors.textTertiary,
            fontSize: 13,
            lineHeight: 1.15,
            fontWeight: 650,
          }}
        >
          {typeof row.additions === 'number' ? (
            <span style={{ color: colors.success }}>+{row.additions}</span>
          ) : null}
          {typeof row.deletions === 'number' ? (
            <span style={{ color: '#FF5C57' }}>-{row.deletions}</span>
          ) : null}
          {typeof row.issue === 'number' ? (
            <span style={{ color: colors.accent }}>#{row.issue}</span>
          ) : null}
          <span
            style={{
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              maxWidth: '100%',
            }}
          >
            {row.meta}
          </span>
        </span>
      </span>
      <ChevronRight size={18} color={colors.textTertiary} style={{ opacity: row.onClick ? 0.65 : 0 }} />
    </button>
  );
}

function RepoGroupBlock({ repoName, rows }: { repoName: string; rows: AttentionRow[] }) {
  const { colors } = useTheme();
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 11,
          color: colors.textSecondary,
          minHeight: 30,
          paddingLeft: 2,
        }}
      >
        <ChevronDown size={18} color={colors.textTertiary} />
        <span
          style={{
            flex: 1,
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontSize: 20,
            fontWeight: 720,
            letterSpacing: 0,
          }}
        >
          {repoName}
        </span>
        <span
          style={{
            color: colors.textTertiary,
            fontSize: 13,
            fontWeight: 760,
          }}
        >
          {rows.length}
        </span>
      </div>
      <div style={{ display: 'grid', gap: 8 }}>
        {rows.map((row) => (
          <AttentionListRow key={row.id} row={row} />
        ))}
      </div>
    </div>
  );
}

function EmptyState({ label }: { label: string }) {
  const { colors } = useTheme();
  return (
    <div
      style={{
        minHeight: 56,
        borderRadius: 14,
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: colors.surfaceBorder,
        background: 'rgba(255, 255, 255, 0.03)',
        color: colors.textTertiary,
        display: 'flex',
        alignItems: 'center',
        padding: '0 16px',
        fontSize: 14,
        fontWeight: 650,
      }}
    >
      {label}
    </div>
  );
}

export function OrchestratorLanding({
  threads,
  snapshot,
  threadsLoading,
  canStartConversation,
  defaultRepoLabel,
  defaultBranchLabel,
  orchestratorModelLabel,
  connectionLabel,
  connectionColor,
  onOpenThread,
  onStartConversation,
}: OrchestratorLandingProps) {
  const { colors } = useTheme();
  const [draft, setDraft] = useState('');
  const [detailRow, setDetailRow] = useState<AttentionRow | null>(null);
  const modelLabel = modelShortLabel(orchestratorModelLabel);
  const repoLabel = defaultRepoLabel || threads[0]?.repoName || 'o8';
  const branchLabel = defaultBranchLabel || threads[0]?.repoBranch || 'main';
  const trimmedDraft = draft.trim();

  const attentionRows = useMemo<AttentionRow[]>(() => {
    const snapshotRows = makeSnapshotRows(snapshot, repoLabel, setDetailRow);
    const rows = makeThreadRows(threads, onOpenThread);
    return [...snapshotRows, ...rows].slice(0, 8);
  }, [onOpenThread, repoLabel, snapshot, threads]);

  const attentionGroups = useMemo(
    () => groupRowsByRepo(attentionRows, repoLabel),
    [attentionRows, repoLabel],
  );

  const inProgressRows = useMemo<AttentionRow[]>(() => {
    return makeRunningRows(snapshot, repoLabel);
  }, [repoLabel, snapshot]);
  const inProgressGroups = useMemo(
    () => groupRowsByRepo(inProgressRows, repoLabel),
    [inProgressRows, repoLabel],
  );

  const submitDraft = () => {
    if (!canStartConversation || !trimmedDraft) return;
    onStartConversation(trimmedDraft);
    setDraft('');
  };

  return (
    <div
      style={{
        minHeight: '100%',
        height: '100%',
        overflowY: 'auto',
        background: colors.bg,
        color: colors.text,
        fontFamily: mobileFontFamily(),
        padding: '24px 22px calc(env(safe-area-inset-bottom, 0px) + 28px)',
      }}
    >
      <section
        aria-label="Start orchestrator chat"
        style={{
          display: 'grid',
          gap: 14,
        }}
      >
        <div
          style={{
            minHeight: 146,
            borderRadius: 18,
            borderWidth: 1,
            borderStyle: 'solid',
            borderColor: colors.surfaceBorder,
            background: 'rgba(34, 36, 43, 0.72)',
            boxShadow: 'inset 0 1px 0 rgba(255, 255, 255, 0.04)',
            padding: 18,
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                submitDraft();
              }
            }}
            placeholder={canStartConversation ? 'Ask o8 to build, fix bugs, explore' : 'Pick a repo to start orchestrator'}
            rows={2}
            disabled={!canStartConversation}
            style={{
              width: '100%',
              flex: 1,
              minHeight: 62,
              borderWidth: 0,
              outline: 'none',
              resize: 'none',
              background: 'transparent',
              color: colors.text,
              fontFamily: mobileFontFamily(),
              fontSize: 21,
              lineHeight: 1.22,
              fontWeight: 610,
              letterSpacing: 0,
            }}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
            <button
              type="button"
              aria-label="Model"
              style={{
                minWidth: 0,
                borderRadius: 999,
                borderWidth: 0,
                background: 'rgba(255, 255, 255, 0.06)',
                color: colors.textSecondary,
                display: 'inline-flex',
                alignItems: 'center',
                gap: 9,
                padding: '9px 12px',
                fontSize: 17,
                fontWeight: 680,
                fontFamily: mobileFontFamily(),
              }}
            >
              <span
                style={{
                  width: 30,
                  height: 30,
                  borderRadius: 999,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  background: 'rgba(255, 255, 255, 0.05)',
                  color: colors.textTertiary,
                  flexShrink: 0,
                }}
              >
                <MessageSquare size={18} />
              </span>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {orchestratorModelLabel || 'Claude 4 Sonnet'}
              </span>
              <span
                style={{
                  padding: '2px 6px',
                  borderRadius: 6,
                  borderWidth: 1,
                  borderStyle: 'solid',
                  borderColor: colors.surfaceBorder,
                  fontSize: 11,
                  fontWeight: 760,
                }}
              >
                MAX
              </span>
              <ChevronDown size={18} />
            </button>
            <span style={{ flex: 1 }} />
            <button
              type="button"
              aria-label="Attach image"
              style={{
                width: 38,
                height: 38,
                borderRadius: 12,
                borderWidth: 0,
                background: 'transparent',
                color: colors.textSecondary,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
              }}
            >
              <ImageIcon size={22} />
            </button>
            <button
              type="button"
              aria-label="Start orchestrator"
              onClick={submitDraft}
              disabled={!canStartConversation || !trimmedDraft}
              style={{
                width: 42,
                height: 42,
                borderRadius: 999,
                borderWidth: 0,
                background: canStartConversation && trimmedDraft ? colors.text : 'rgba(255, 255, 255, 0.10)',
                color: canStartConversation && trimmedDraft ? colors.bg : colors.textTertiary,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: canStartConversation && trimmedDraft ? 'pointer' : 'default',
              }}
            >
              <ArrowUp size={22} strokeWidth={2.7} />
            </button>
          </div>
        </div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 16,
            color: colors.textTertiary,
            fontSize: 16,
            fontWeight: 650,
            minWidth: 0,
          }}
        >
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
            <Folder size={18} />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{repoLabel}</span>
            <ChevronDown size={16} />
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
            <GitBranch size={18} />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{branchLabel}</span>
            <ChevronDown size={16} />
          </span>
        </div>
      </section>

      <section style={{ marginTop: 64 }}>
        <h2
          style={{
            margin: '0 0 20px',
            fontSize: 17,
            fontWeight: 760,
            color: colors.textTertiary,
            letterSpacing: 0,
          }}
        >
          Needs Attention
        </h2>
        <div style={{ display: 'grid', gap: 8 }}>
          {attentionGroups.map((group) => (
            <RepoGroupBlock key={group.repoName} repoName={group.repoName} rows={group.rows} />
          ))}
          {attentionGroups.length === 0 && !threadsLoading ? (
            <EmptyState label="No attention items" />
          ) : null}
          {threadsLoading ? (
            <div
              style={{
                color: colors.textTertiary,
                fontSize: 15,
                fontWeight: 650,
                padding: '8px 0 2px',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 8,
              }}
            >
              <Loader2 size={16} style={{ animation: 'mobile-orchestrator-spin 1s linear infinite' }} />
              Loading chats
            </div>
          ) : null}
        </div>
      </section>

      <div
        style={{
          height: 1,
          background: colors.surfaceBorder,
          margin: '26px 0 24px',
        }}
      />

      <section>
        <h2
          style={{
            margin: '0 0 20px',
            fontSize: 17,
            fontWeight: 760,
            color: colors.textTertiary,
            letterSpacing: 0,
          }}
        >
          In Progress
        </h2>
        <div style={{ display: 'grid', gap: 8 }}>
          {inProgressGroups.map((group) => (
            <RepoGroupBlock key={group.repoName} repoName={group.repoName} rows={group.rows} />
          ))}
          {inProgressGroups.length === 0 ? (
            <EmptyState label="No runs in progress" />
          ) : null}
        </div>
      </section>

      <div
        style={{
          marginTop: 52,
          padding: '16px 18px',
          borderRadius: 16,
          borderWidth: 1,
          borderStyle: 'solid',
          borderColor: colors.surfaceBorder,
          background: 'rgba(34, 36, 43, 0.62)',
          color: colors.textSecondary,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          fontSize: 16,
          fontWeight: 680,
        }}
      >
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 9 }}>
          <span
            aria-hidden="true"
            style={{
              width: 9,
              height: 9,
              borderRadius: 999,
              background: connectionColor,
              boxShadow: `0 0 0 8px ${connectionColor}22`,
            }}
          />
          {connectionLabel}
        </span>
        <MoreHorizontal size={22} color={colors.textTertiary} />
      </div>

      <OrchestratorDetailSheet row={detailRow} onClose={() => setDetailRow(null)} modelLabel={modelLabel} />

      <style>{`
        @keyframes mobile-orchestrator-spin {
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}
