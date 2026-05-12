'use client';

import {
  AlertCircle,
  CheckCircle2,
  Folder,
  GitBranch,
  Loader2,
  MoreHorizontal,
  Plus,
} from 'lucide-react';
import { useMemo, type CSSProperties } from 'react';
import type { MobileInboxSnapshot } from '@/lib/mobile/types';
import type { MobileRepoOption } from './mobile-chat-repos';
import { mobileFontFamily } from './mobile-approvals-shared';

type WorkspaceStatus = 'attention' | 'running' | 'ready' | 'draft';

interface WorkspaceItem {
  id: string;
  title: string;
  status: WorkspaceStatus;
  meta?: string;
  additions?: number;
  deletions?: number;
  issue?: string;
}

interface WorkspaceGroup {
  id: string;
  label: string;
  items: WorkspaceItem[];
}

const colors = {
  bg: '#1c1c1e',
  line: 'rgba(255, 255, 255, 0.075)',
  text: '#f5f5f7',
  muted: 'rgba(235, 235, 245, 0.6)',
  faint: 'rgba(235, 235, 245, 0.34)',
  blue: '#0a84ff',
  bluePanel: 'rgba(34, 67, 106, 0.72)',
  green: '#30d158',
  red: '#ff453a',
  orange: '#ff9f0a',
};

export function O8MobileMark({ size = 26 }: { size?: number }) {
  const raySize = Math.max(2, Math.round(size * 0.12));
  const rayLength = Math.round(size * 0.45);
  const center = size / 2;

  return (
    <span
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        borderRadius: Math.round(size * 0.3),
        display: 'inline-grid',
        placeItems: 'center',
        background: 'linear-gradient(180deg, rgba(255,255,255,0.11) 0%, rgba(255,255,255,0.035) 100%)',
        border: '1px solid rgba(255,255,255,0.10)',
        boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.09), 0 12px 24px rgba(0,0,0,0.22)',
        position: 'relative',
        overflow: 'hidden',
        flexShrink: 0,
      }}
    >
      {Array.from({ length: 8 }, (_, index) => (
        <span
          key={index}
          style={{
            position: 'absolute',
            left: center,
            top: center,
            width: raySize,
            height: rayLength,
            borderRadius: 999,
            background: '#ff7a2f',
            transformOrigin: `${raySize / 2}px ${rayLength / 2}px`,
            transform: `translate(-${raySize / 2}px, -${rayLength / 2}px) rotate(${index * 45}deg)`,
          }}
        />
      ))}
    </span>
  );
}

function repoBasename(value?: string | null) {
  const normalized = value?.trim().replace(/[\\/]+$/, '');
  if (!normalized) return 'Current project';
  const parts = normalized.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? normalized;
}

function itemStatusFromSession(status: string, approvalStatus?: string): WorkspaceStatus {
  if (approvalStatus === 'pending' || status === 'blocked' || status === 'failed') return 'attention';
  if (status === 'running' || status === 'reviewing' || status === 'waiting') return 'running';
  if (status === 'idle') return 'draft';
  return 'ready';
}

function buildWorkspaceGroups({
  snapshot,
  repoOptions,
  selectedRepoPath,
}: {
  snapshot?: MobileInboxSnapshot | null;
  repoOptions: MobileRepoOption[];
  selectedRepoPath?: string | null;
}): WorkspaceGroup[] {
  const groups = new Map<string, WorkspaceGroup>();

  function ensureGroup(id: string, label: string) {
    const existing = groups.get(id);
    if (existing) return existing;
    const group = { id, label, items: [] as WorkspaceItem[] };
    groups.set(id, group);
    return group;
  }

  for (const repo of repoOptions) {
    if (repo.localPath === selectedRepoPath) {
      ensureGroup(repo.localPath, repo.name || repoBasename(repo.localPath));
    }
  }

  if (snapshot?.review) {
    const repoLabel = repoBasename(snapshot.review.repoSlug);
    ensureGroup(snapshot.review.repoSlug, repoLabel).items.push({
      id: `review:${snapshot.review.branch}`,
      title: snapshot.review.pullRequest?.title ?? `Review ${snapshot.review.branch}`,
      status: snapshot.review.issues.length > 0 ? 'attention' : 'ready',
      meta: `${snapshot.review.changedFiles.length} changed file${snapshot.review.changedFiles.length === 1 ? '' : 's'} / ${snapshot.review.branch}`,
      issue: snapshot.review.pullRequest ? `#${snapshot.review.pullRequest.number}` : undefined,
    });
  }

  for (const session of snapshot?.sessions ?? []) {
    const group = ensureGroup(session.workspace || 'current-project', repoBasename(session.workspace));
    group.items.push({
      id: session.sessionKey,
      title: session.name || session.surfaceLabel || session.currentTask || 'Untitled session',
      status: itemStatusFromSession(session.status, session.approvalStatus),
      meta: `${session.lastEventAt} / ${session.branch || 'main'}`,
    });
  }

  if (groups.size === 0) {
    const selectedRepo = selectedRepoPath
      ? repoOptions.find((repo) => repo.localPath === selectedRepoPath)
      : null;
    ensureGroup(selectedRepo?.localPath ?? 'current-project', selectedRepo?.name ?? 'Current project');
  }

  return Array.from(groups.values()).filter((group, index) => group.items.length > 0 || index === 0);
}

function statusIcon(status: WorkspaceStatus) {
  if (status === 'ready') return <CheckCircle2 size={19} />;
  if (status === 'running') return <Loader2 size={19} style={{ animation: 'mobileWorkspaceSpin 1.1s linear infinite' }} />;
  if (status === 'attention') return <AlertCircle size={19} />;
  return <GitBranch size={18} />;
}

function statusColor(status: WorkspaceStatus) {
  if (status === 'ready') return colors.green;
  if (status === 'running') return colors.blue;
  if (status === 'attention') return colors.orange;
  return colors.faint;
}

function DiffText({ item }: { item: WorkspaceItem }) {
  if (typeof item.additions !== 'number' && typeof item.deletions !== 'number' && !item.issue && !item.meta) return null;
  return (
    <span style={styles.diffInline}>
      {typeof item.additions === 'number' ? <span style={{ color: colors.green }}>+{item.additions}</span> : null}
      {typeof item.deletions === 'number' ? <span style={{ color: colors.red }}>-{item.deletions}</span> : null}
      {item.issue ? <span style={{ color: colors.blue }}>{item.issue}</span> : null}
      {item.meta ? <span>{item.meta}</span> : null}
    </span>
  );
}

function WorkspaceRow({ item, selected }: { item: WorkspaceItem; selected: boolean }) {
  return (
    <button
      type="button"
      style={{
        width: '100%',
        border: '1px solid transparent',
        borderRadius: 12,
        padding: selected ? '13px 13px 13px 11px' : '11px 13px 11px 11px',
        background: selected ? colors.bluePanel : 'transparent',
        color: colors.text,
        display: 'grid',
        gridTemplateColumns: '30px minmax(0, 1fr)',
        gap: 10,
        textAlign: 'left',
        WebkitTapHighlightColor: 'transparent',
      }}
    >
      <span style={{ ...styles.rowIcon, color: statusColor(item.status) }}>{statusIcon(item.status)}</span>
      <span style={{ minWidth: 0, display: 'grid', gap: selected ? 7 : 6 }}>
        <span style={{ ...styles.rowTitle, color: selected ? colors.text : colors.muted, fontWeight: selected ? 510 : 430 }}>{item.title}</span>
        <span style={{ ...styles.rowMeta, opacity: selected ? 1 : 0.78 }}>
          <DiffText item={item} />
        </span>
      </span>
    </button>
  );
}

function EmptyWorkspaceGroup() {
  return (
    <div style={styles.emptyGroup}>
      No active work
    </div>
  );
}

export function MobileWorkspacesHome({
  snapshot,
  repoOptions = [],
  selectedRepoPath = null,
}: {
  snapshot?: MobileInboxSnapshot | null;
  repoOptions?: MobileRepoOption[];
  selectedRepoPath?: string | null;
}) {
  const workspaceGroups = useMemo(
    () => buildWorkspaceGroups({ snapshot, repoOptions, selectedRepoPath }),
    [repoOptions, selectedRepoPath, snapshot],
  );

  return (
    <section style={styles.root}>
      <style>{`
        @keyframes mobileWorkspaceSpin { to { transform: rotate(360deg); } }
        .mobile-workspaces-home::-webkit-scrollbar { width: 0; height: 0; }
      `}</style>
      <div style={styles.groupList}>
        {workspaceGroups.map((group) => (
          <section key={group.id} style={styles.workspaceGroup}>
            <header style={styles.groupHeader}>
              <div style={styles.groupTitleWrap}>
                <span style={styles.chevron}>⌄</span>
                <span style={styles.groupTitle}>{group.label}</span>
              </div>
              <div style={styles.groupActions}>
                <button type="button" aria-label={`New ${group.label} workspace`} style={styles.iconButton}>
                  <Plus size={26} />
                </button>
                <button type="button" aria-label={`${group.label} menu`} style={styles.iconButton}>
                  <MoreHorizontal size={25} />
                </button>
              </div>
            </header>
            <div style={styles.rows}>
              {group.items.length > 0
                ? group.items.map((item, index) => (
                  <WorkspaceRow key={item.id} item={item} selected={index === 0 && group.id === workspaceGroups[0]?.id} />
                ))
                : <EmptyWorkspaceGroup />}
            </div>
          </section>
        ))}
      </div>

      <footer style={styles.footer}>
        <button type="button" style={styles.newWorkspaceButton}>
          <Plus size={19} />
          <span>New workspace</span>
        </button>
        <button type="button" style={styles.addRepoButton}>
          <Folder size={17} />
          <span>Add repository</span>
        </button>
      </footer>
    </section>
  );
}

const styles: Record<string, CSSProperties> = {
  root: {
    height: '100%',
    minHeight: 0,
    overflowY: 'auto',
    WebkitOverflowScrolling: 'touch',
    scrollbarWidth: 'none',
    padding: '10px 0 max(28px, env(safe-area-inset-bottom, 0px))',
    background: colors.bg,
    color: colors.text,
    fontFamily: mobileFontFamily(),
    letterSpacing: 0,
  },
  groupList: {
    display: 'grid',
    gap: 20,
  },
  workspaceGroup: {
    display: 'grid',
    gap: 7,
    paddingBottom: 18,
    borderBottom: `1px solid ${colors.line}`,
  },
  groupHeader: {
    minHeight: 48,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  groupTitleWrap: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 12,
    minWidth: 0,
  },
  chevron: {
    color: colors.muted,
    fontSize: 24,
    lineHeight: 1,
    transform: 'translateY(-2px)',
  },
  groupTitle: {
    minWidth: 0,
    color: colors.muted,
    fontSize: 25,
    fontWeight: 500,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  groupActions: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    color: colors.muted,
  },
  iconButton: {
    width: 42,
    height: 42,
    border: 0,
    borderRadius: 14,
    background: 'transparent',
    color: colors.muted,
    display: 'grid',
    placeItems: 'center',
    WebkitTapHighlightColor: 'transparent',
  },
  rows: {
    display: 'grid',
    gap: 4,
  },
  rowIcon: {
    width: 28,
    height: 28,
    display: 'grid',
    placeItems: 'center',
    alignSelf: 'start',
    marginTop: 1,
  },
  rowTitle: {
    fontSize: 22,
    lineHeight: 1.12,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  rowMeta: {
    minHeight: 20,
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
    color: colors.faint,
    fontSize: 18,
    fontWeight: 500,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  diffInline: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 7,
    minWidth: 0,
    fontWeight: 500,
    whiteSpace: 'nowrap',
  },
  footer: {
    padding: '16px 0 0',
    display: 'grid',
    gap: 12,
  },
  newWorkspaceButton: {
    width: '100%',
    minHeight: 62,
    borderRadius: 18,
    border: '1px solid rgba(255, 255, 255, 0.12)',
    background: 'rgba(255,255,255,0.035)',
    color: colors.text,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 9,
    fontFamily: mobileFontFamily(),
    fontSize: 19,
    fontWeight: 500,
    WebkitTapHighlightColor: 'transparent',
  },
  addRepoButton: {
    width: '100%',
    minHeight: 42,
    border: 0,
    background: 'transparent',
    color: colors.muted,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 9,
    fontFamily: mobileFontFamily(),
    fontSize: 16,
    fontWeight: 460,
    WebkitTapHighlightColor: 'transparent',
  },
};
