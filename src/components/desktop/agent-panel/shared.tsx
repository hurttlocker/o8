'use client';

import type { CSSProperties, ReactNode } from 'react';
import { motion } from 'framer-motion';
import { ChevronDown, type LucideIcon } from '../lucide-shims';
import type { ActivityItem, AgentDetail, EventEntry, PRHoverDetail, WorkspaceGroup } from './types';

export const THEME_ACCENT = 'var(--t-accent, #ef4444)';
export const THEME_ACCENT_SOFT = 'var(--t-accent-soft, rgba(239, 68, 68, 0.08))';
export const THEME_ACCENT_BORDER = 'var(--t-accent-border, rgba(239, 68, 68, 0.22))';
export const THEME_BG_CARD = 'var(--t-bg-card, rgba(148, 163, 184, 0.08))';
export const THEME_PANEL_GLASS = 'var(--t-panel-translucent)';
const EMPTY_STATE_SPRING = { type: 'spring', stiffness: 400, damping: 30 } as const;

export function mergeRiskLabel(detail: PRHoverDetail | null): { label: string; color: string } {
  if (!detail) return { label: 'warming', color: '#64748b' };
  if (!detail.mergeable) return { label: 'conflicts', color: '#dc2626' };
  if (detail.checksStatus === 'failure') return { label: 'ci red', color: '#dc2626' };
  if (detail.checksStatus === 'pending') return { label: 'checks pending', color: '#d97706' };
  if (detail.reviewDecision === 'CHANGES_REQUESTED') return { label: 'changes requested', color: '#dc2626' };
  if (detail.reviewDecision === 'REVIEW_REQUIRED') return { label: 'review pending', color: '#2563eb' };
  return { label: 'merge ready', color: '#16a34a' };
}

export function arraysMatchBy<T>(a: T[], b: T[], key: (item: T) => string | number): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (key(a[i]) !== key(b[i])) return false;
  }
  return true;
}

export function agentFp(agent: AgentDetail): string {
  const statusEvidenceFp = agent.statusEvidence
    ? `${agent.statusEvidence.state}:${agent.statusEvidence.authority}:${agent.statusEvidence.observedAt}:${agent.statusEvidence.summary}:${agent.statusEvidence.fallbackReason ?? ''}:${agent.statusEvidence.evidence.map((item) => `${item.source}=${item.value}`).join(',')}`
    : '';
  return `${agent.id}|${agent.status}|${agent.currentTask}|${agent.lastEventAt}|${agent.alerts}|${agent.branch ?? ''}|${agent.workspaceStatus ?? ''}|${agent.lifecycleState ?? ''}|${agent.runtimeSurface?.reviewContext?.repoSlug ?? ''}|${agent.runtimeSurface?.cwd ?? ''}|${statusEvidenceFp}`;
}

export function eventFp(event: EventEntry): string {
  return `${event.id}|${event.timestamp}`;
}

export const severityColor: Record<string, string> = {
  success: '#22c55e',
  info: '#3b82f6',
  warning: '#f59e0b',
  error: '#ef4444',
  critical: '#ef4444',
};

export function deriveRepo(workspace: string): string {
  const path = workspace.replace(/^~\//, '');

  if (!path || path === 'unknown') return 'workspace';

  if (path.includes('/.cortex-worktrees/')) {
    const repoRoot = path.split('/.cortex-worktrees/')[0] ?? '';
    return repoRoot.split('/').pop() || 'workspace';
  }
  if (path.includes('/.claude/worktrees/')) {
    const repoRoot = path.split('/.claude/worktrees/')[0] ?? '';
    return repoRoot.split('/').pop() || 'workspace';
  }
  if (path.includes('repos/')) {
    const parts = path.split('repos/');
    return parts[1]?.split('/')[0] || path.split('/').pop() || 'workspace';
  }
  if (path.includes('projects/')) {
    const parts = path.split('projects/');
    return parts[1]?.split('/')[0] || path.split('/').pop() || 'workspace';
  }
  if (path === 'clawd') return 'workspace';

  return path.split('/').pop() || 'workspace';
}

export function buildWorkspaceGroups(agents: AgentDetail[]): WorkspaceGroup[] {
  const groupMap = new Map<string, AgentDetail[]>();
  for (const agent of agents) {
    // Default to the user's home so the UI falls back to something real
    // on fresh installs. The old `~/clawd` leaked a personal directory
    // name to every other dev.
    const workspace = agent.workspace || '~';
    const existing = groupMap.get(workspace) ?? [];
    existing.push(agent);
    groupMap.set(workspace, existing);
  }

  const groups: WorkspaceGroup[] = [];
  for (const [workspace, workspaceAgents] of groupMap) {
    const repo = deriveRepo(workspace);
    const repoDisplayNames: Record<string, string> = {
      workspace: 'Workspace',
      'cortex-ide': 'o8',
      cortex: 'Cortex',
      'parasite-network': 'Parasite Network',
      'spear-production': 'Spear',
      mybeautifulwife: 'Eyes Web',
    };
    const displayName = repoDisplayNames[repo] || repo;
    const hasRunning = workspaceAgents.some((agent) => agent.status === 'running' || agent.status === 'watching' || agent.status === 'healthy');
    const bestContextPct = Math.max(0, ...workspaceAgents.map((agent) => agent.context?.usedPercent ?? 0));
    const primary = workspaceAgents[0];
    const totalAlerts = workspaceAgents.reduce((sum, agent) => sum + (agent.alerts ?? 0), 0);

    groups.push({
      workspace,
      displayName,
      repo,
      agents: workspaceAgents,
      hasRunning,
      bestContextPct,
      primaryModel: primary?.primaryModel ?? primary?.model ?? '',
      totalAlerts,
    });
  }

  groups.sort((a, b) => {
    if (a.displayName === 'Main') return -1;
    if (b.displayName === 'Main') return 1;
    if (a.hasRunning && !b.hasRunning) return -1;
    if (!a.hasRunning && b.hasRunning) return 1;
    return a.displayName.localeCompare(b.displayName);
  });

  return groups;
}

export function relativeAge(dateStr: string): string {
  const then = new Date(dateStr).getTime();
  // Invalid/missing dates otherwise cascade to "NaNd ago" in feed rows.
  if (!Number.isFinite(then)) return '';
  const diff = Date.now() - then;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

export function normalizeRepoSlug(value?: string | null) {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return /^[\w.-]+\/[\w.-]+$/.test(trimmed) ? trimmed : null;
}

export function repoSlugFromRemoteUrl(remoteUrl?: string | null) {
  const normalized = remoteUrl
    ?.replace(/\.git$/, '')
    .replace(/^git@github\.com:/, 'https://github.com/');
  const match = normalized?.match(/github\.com\/([^/]+\/[^/]+)$/);
  return match?.[1] ?? null;
}

export function shortRepoLabel(repo?: string | null) {
  if (!repo) return 'Local activity';
  return repo.split('/').pop() ?? repo;
}

export function shortWorkspaceLabel(workspace?: string | null) {
  const trimmed = workspace?.trim();
  if (!trimmed || trimmed === 'unknown') return 'Local activity';

  const parts = trimmed.replace(/\/+$/, '').split('/').filter(Boolean);
  if (parts.length >= 2) return parts.slice(-2).join('/');
  return parts[0] ?? 'Local activity';
}

export function compactActivitySummaryLabel(value?: string | null) {
  const trimmed = value?.trim();
  if (!trimmed) return 'Recent workflow events';
  const segments = trimmed
    .split(/[·•]/)
    .map((segment) => segment.trim())
    .filter(Boolean);
  if (segments.length <= 1) return trimmed;
  const seen = new Set<string>();
  const deduped = segments.filter((segment) => {
    const key = segment.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return deduped.join(' · ');
}

export function agentRepoSlug(agent?: AgentDetail | null) {
  return normalizeRepoSlug(agent?.runtimeSurface?.reviewContext?.repoSlug);
}

export function activityItemKey(item: ActivityItem) {
  if (item.kind === 'commit') return `c-${item.repo ?? 'local'}-${item.hash}`;
  if (item.kind === 'event') return `e-${item.data.id}`;
  if (item.kind === 'issue') return `i-${item.repo}-${item.number}`;
  if (item.kind === 'pr') return `pr-${item.repo}-${item.number}`;
  if (item.kind === 'packet') return `pkt-${item.packet.id}`;
  return `ci-${item.repo}-${item.id}`;
}

export function normalizeActivitySubject(value?: string | null) {
  if (!value) return null;
  return value
    .replace(/^\[[^\]]+\]\s*/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function SidebarSection({
  title,
  icon: Icon,
  count,
  summary,
  accent,
  open,
  onToggle,
  headerAction,
  children,
}: {
  title: string;
  icon?: LucideIcon;
  count?: number | string | null;
  summary?: string | null;
  accent?: string;
  open: boolean;
  onToggle: () => void;
  headerAction?: ReactNode;
  children: ReactNode;
}) {
  const tone = accent ?? '#ef4444';

  return (
    <section style={{ borderTop: 'none' }}>
      <div style={{ display: 'flex', alignItems: 'stretch', gap: 6, paddingRight: 14 }}>
        <button
          type="button"
          onClick={onToggle}
          style={{
            flex: 1,
            minWidth: 0,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '10px 14px 8px',
            border: 'none',
            background: 'transparent',
            color: 'var(--t-text)',
            cursor: 'pointer',
            fontFamily: 'var(--font-sans-system)',
          }}
        >
          {Icon ? (
            <span
              style={{
                width: 18,
                height: 18,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: open ? tone : 'var(--t-text-muted)',
                flexShrink: 0,
              }}
            >
              <Icon size={14} strokeWidth={2} />
            </span>
          ) : null}
          <div style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
              <span style={{ fontSize: 13, fontWeight: 700, letterSpacing: '-0.01em' }}>{title}</span>
              {count !== null && count !== undefined ? (
                <span
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    minWidth: 18,
                    height: 18,
                    paddingLeft: 6,
                    paddingRight: 6,
                    borderRadius: 999,
                    background: 'var(--t-divider-subtle)',
                    color: 'var(--t-text-secondary)',
                    fontSize: 10,
                    fontWeight: 700,
                    fontFamily: '"SF Mono", ui-monospace, monospace',
                    flexShrink: 0,
                  }}
                >
                  {count}
                </span>
              ) : null}
            </div>
            {summary ? (
              <div
                style={{
                  marginTop: 2,
                  fontSize: 10,
                  lineHeight: 1.35,
                  color: 'var(--t-text-faint)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {summary}
              </div>
            ) : null}
          </div>
        </button>
        {headerAction ? (
          <div style={{ display: 'flex', alignItems: 'center', flexShrink: 0 }}>
            {headerAction}
          </div>
        ) : null}
      </div>
      {open ? (
        <div style={{ paddingRight: 0, paddingBottom: 4, paddingLeft: 0, display: 'flex', flexDirection: 'column', gap: 0 }}>
          {children}
        </div>
      ) : null}
    </section>
  );
}

export function ActivityDock({
  title,
  count,
  open,
  onToggle,
  children,
}: {
  title: string;
  count: number | null;
  summary: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <section
      style={{
        flexShrink: 1,
        flexGrow: 1,
        marginTop: 4,
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
      }}
    >
      <button
        type="button"
        onClick={onToggle}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '8px 14px',
          border: 'none',
          borderBottom: open ? '1px solid var(--t-divider-subtle)' : 'none',
          background: 'transparent',
          cursor: 'pointer',
          color: 'var(--t-text)',
          fontFamily: 'var(--font-sans-system)',
        }}
      >
        <ChevronDown
          size={12}
          strokeWidth={2.2}
          color="var(--t-text-muted)"
          style={{
            flexShrink: 0,
            transform: open ? 'rotate(0deg)' : 'rotate(-90deg)',
            transition: 'transform 180ms cubic-bezier(0.22, 1, 0.36, 1)',
          }}
        />
        <span style={{ fontSize: 12, fontWeight: 600, letterSpacing: '-0.01em', color: 'var(--t-text-secondary)' }}>{title}</span>
        {count !== null ? (
          <span
            style={{
              fontSize: 10,
              fontWeight: 600,
              color: 'var(--t-text-faint)',
              fontFamily: '"SF Mono", ui-monospace, monospace',
            }}
          >
            {count}
          </span>
        ) : null}
      </button>

      {open ? (
        <div
          style={{
            padding: '0 14px 10px',
            flex: 1,
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <div
            style={{
              flex: 1,
              minHeight: 0,
              overflowY: 'auto',
              scrollbarWidth: 'none',
              maskImage: 'linear-gradient(to bottom, black 0px, black calc(100% - 8px), transparent 100%)',
              WebkitMaskImage: 'linear-gradient(to bottom, black 0px, black calc(100% - 8px), transparent 100%)',
            } as CSSProperties}
            className="hide-scrollbar"
          >
            {children}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function GhostPulseBar({
  width,
  height = 8,
  opacity = 1,
}: {
  width: string | number;
  height?: number;
  opacity?: number;
}) {
  return (
    <div
      style={{
        width,
        height,
        borderRadius: 999,
        background: 'linear-gradient(90deg, rgba(148, 163, 184, 0.2) 0%, rgba(148, 163, 184, 0.34) 50%, rgba(148, 163, 184, 0.18) 100%)',
        opacity,
      }}
    />
  );
}

export function AgentPanelEmptyState() {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
      style={{
        padding: '10px 14px',
        fontSize: 12,
        color: 'var(--t-text-faint)',
        letterSpacing: '-0.01em',
        fontFamily: 'var(--font-sans-system)',
      }}
    >
      No active agents
    </motion.div>
  );
}

export function ActivityFeedEmptyState({
  missingGitHubScope,
  repoLabel,
}: {
  missingGitHubScope: boolean;
  repoLabel: string;
}) {
  const helperText = missingGitHubScope
    ? 'Add a repo with the control above to give this feed a live lane.'
    : `Start one from the chat and ${repoLabel} activity will flow here naturally.`;

  return (
    <motion.div
      initial={{ opacity: 0, y: 10, scale: 0.99 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -8, scale: 0.985 }}
      transition={EMPTY_STATE_SPRING}
      style={{
        paddingTop: 10,
        paddingRight: 2,
        paddingBottom: 12,
        paddingLeft: 2,
      }}
    >
      <div
        style={{
          borderRadius: 14,
          border: '1px solid var(--t-panel-border)',
          background: `linear-gradient(180deg, ${THEME_PANEL_GLASS} 0%, ${THEME_BG_CARD} 100%)`,
          boxShadow: '0 12px 28px rgba(4, 8, 14, 0.08), inset 0 1px 0 rgba(255, 255, 255, 0.3)',
          padding: 14,
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            <div
              style={{
                fontSize: 13,
                fontWeight: 700,
                lineHeight: 1.45,
                color: 'var(--t-text)',
                letterSpacing: '-0.02em',
                fontFamily: 'var(--font-sans-system)',
              }}
            >
              Commits, PRs, and CI runs stream here once agents are active.
            </div>
            <div
              style={{
                fontSize: 12,
                lineHeight: 1.55,
                color: 'var(--t-text-muted)',
                letterSpacing: '-0.01em',
                fontFamily: 'var(--font-sans-system)',
              }}
            >
              {helperText}
            </div>
          </div>

          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
              padding: 12,
              borderRadius: 14,
              border: '1px solid rgba(148, 163, 184, 0.14)',
              background: 'rgba(255, 255, 255, 0.32)',
            }}
          >
            {[0, 1, 2].map((index) => (
              <div key={index} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div
                  style={{
                    position: 'relative',
                    width: 18,
                    height: 26,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0,
                  }}
                >
                  <div
                    style={{
                      position: 'absolute',
                      top: 0,
                      bottom: 0,
                      left: '50%',
                      width: 1,
                      transform: 'translateX(-50%)',
                      background: 'linear-gradient(180deg, rgba(148, 163, 184, 0.12) 0%, rgba(148, 163, 184, 0.26) 50%, rgba(148, 163, 184, 0.12) 100%)',
                    }}
                  />
                  <div
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: 999,
                      background: index === 0 ? 'rgba(37, 99, 235, 0.24)' : 'rgba(148, 163, 184, 0.22)',
                      border: '1px solid rgba(148, 163, 184, 0.18)',
                      position: 'relative',
                    }}
                  />
                </div>
                <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 7 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <GhostPulseBar width={index === 0 ? '52%' : index === 1 ? '48%' : '44%'} height={9} />
                    <GhostPulseBar width={46} height={16} opacity={0.72} />
                  </div>
                  <GhostPulseBar width={index === 0 ? '78%' : index === 1 ? '66%' : '58%'} />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </motion.div>
  );
}
