import type { AgentSummary, EventSeverity } from '@/lib/fleet/types';
import { approvalSeverity, listApprovals, toMobileApprovalCard } from '@/lib/approvals/store';
import type { ApprovalRecord } from '@/lib/approvals/types';
import { loadMobileLlmChatHistory } from '@/lib/llm/mobile-llm-chat';
import { listIdeLlmChatSessions } from '@/lib/runtime/ide-llm-chat-registry';
import { getRuntimeInventorySnapshot } from '@/lib/runtime/inventory';
import { getWorkspaceReviewSnapshot } from '@/lib/review/workspace';
import type { MobileControlAction, MobileInboxItem, MobileInboxSnapshot, MobileReviewFocus } from '@/lib/mobile/types';
import { invalidateMobileBootstrapBroker } from '@/lib/render/bootstrap';
import { getMobileSessionTranscript } from '@/lib/mobile/history';

function sessionActions(agent: AgentSummary): MobileControlAction[] {
  const runtimeSurface = agent.runtimeSurface;
  const canSteer = agent.runtime === 'chat' ? true : Boolean(runtimeSurface?.capabilities.sendInput);
  const canStop = Boolean(runtimeSurface?.capabilities.interrupt);
  const ownershipNote = agent.runtime === 'chat'
    ? 'This workspace LLM chat mirrors the desktop API chat tab. Mobile can read and send in this lane, but stop/interrupt is not wired here.'
    : agent.runtime === 'codex'
      ? runtimeSurface?.ownership === 'owned'
        ? 'This owned Codex surface can resume between runs and interrupt a live run when one is active.'
        : 'This discovered Codex terminal is only actionable while its live local process is still attached.'
      : 'This Claude Code surface is only actionable while the live local process is still present.';

  return [
    {
      kind: 'inspect',
      label: 'Inspect',
      sessionKey: agent.sessionKey,
      available: true,
    },
    {
      kind: 'steer',
      label: 'Steer',
      sessionKey: agent.sessionKey,
      available: canSteer,
      reasonUnavailable: canSteer ? undefined : ownershipNote,
    },
    {
      kind: 'stop',
      label: 'Stop run',
      sessionKey: agent.sessionKey,
      destructive: true,
      available: canStop,
      reasonUnavailable: canStop ? undefined : ownershipNote,
    },
    {
      kind: 'open_desktop',
      label: 'Desktop ↗',
      href: '/',
      available: true,
    },
  ];
}

function approvalActions(approval: ApprovalRecord): MobileControlAction[] {
  return [
    {
      kind: 'approve',
      label: 'Approve',
      sessionKey: approval.sessionKey,
      available: true,
    },
    {
      kind: 'deny',
      label: 'Deny',
      sessionKey: approval.sessionKey,
      available: true,
    },
    {
      kind: 'inspect',
      label: 'Inspect',
      sessionKey: approval.sessionKey,
      available: true,
    },
  ];
}

function alertSeverity(agent: AgentSummary): EventSeverity {
  if (agent.status === 'blocked' || agent.status === 'failed') return 'critical';
  if (agent.alerts > 0 || agent.context.usedPercent >= 70) return 'warning';
  if (agent.isCurrentSession) return 'success';
  return 'info';
}

function buildSessionLine(agent: AgentSummary, transcriptSnippet?: string) {
  const parts = [agent.currentTask];
  if (transcriptSnippet) parts.push(`Latest: ${transcriptSnippet}`);
  return parts.join(' • ');
}

function mobileSessionPriority(agent: AgentSummary) {
  if (agent.runtime === 'chat' && agent.isCurrentSession) return 99;
  if (agent.runtime === 'chat') return 86;
  const isOwnedCodex = agent.runtime === 'codex' && agent.runtimeSurface?.ownership === 'owned';
  if (agent.isCurrentSession) return 100;
  if (isOwnedCodex && agent.status === 'running') return 96;
  if (isOwnedCodex && agent.status === 'failed') return 94;
  if (isOwnedCodex && agent.status === 'waiting') return 92;
  if (isOwnedCodex && agent.status === 'reviewing') return 90;
  if (isOwnedCodex) return 88;
  if (agent.approvalStatus === 'pending') return 82;
  if (agent.status === 'running') return 76;
  if (agent.status === 'blocked') return 72;
  if (agent.status === 'failed') return 70;
  if (agent.status === 'reviewing') return 64;
  if (agent.status === 'waiting') return 56;
  return 40;
}

function shouldExposeMobileSession(agent: AgentSummary) {
  if (agent.runtime === 'chat') {
    return Boolean(agent.isCurrentSession) || Boolean(agent.currentTask.trim());
  }

  return agent.runtime === 'codex' || agent.runtime === 'claude-code';
}

function mobileSessionIdentity(agent: AgentSummary) {
  if (agent.runtime === 'chat') {
    return agent.sessionKey;
  }
  if (agent.runtime === 'codex' && agent.runtimeSurface?.ownership === 'owned') {
    const repoSlug = agent.runtimeSurface.reviewContext?.repoSlug ?? agent.workspace;
    const branch = agent.runtimeSurface.reviewContext?.branch ?? agent.branch;
    return `codex-owned:${repoSlug}:${branch}`;
  }
  return agent.sessionKey;
}

function summarizeTranscript(text: string) {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  return normalized.length > 180 ? `${normalized.slice(0, 177)}…` : normalized;
}

function relativeMobileAge(isoLike: string | null | undefined) {
  if (!isoLike) return 'just now';
  const parsed = new Date(isoLike).getTime();
  if (Number.isNaN(parsed)) return isoLike;
  const delta = Math.max(0, Date.now() - parsed);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (delta < minute) return 'just now';
  if (delta < hour) return `${Math.max(1, Math.round(delta / minute))}m ago`;
  if (delta < day) return `${Math.max(1, Math.round(delta / hour))}h ago`;
  return `${Math.max(1, Math.round(delta / day))}d ago`;
}

let inboxCache: { snapshot: MobileInboxSnapshot; timestamp: number } | null = null;
let inboxInflight: { generation: number; promise: Promise<MobileInboxSnapshot> } | null = null;
let inboxGeneration = 0;
const INBOX_CACHE_TTL = 8000;

function limitMobileInboxSessions(snapshot: MobileInboxSnapshot, limit?: number): MobileInboxSnapshot {
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) {
    return snapshot;
  }
  if (snapshot.sessions.length <= limit) {
    return snapshot;
  }
  return {
    ...snapshot,
    sessions: snapshot.sessions.slice(0, limit),
  };
}

export function invalidateInboxCache() {
  inboxGeneration += 1;
  inboxCache = null;
  inboxInflight = null;
  invalidateMobileBootstrapBroker();
}

export async function getMobileInboxSnapshot(options: { fresh?: boolean; limit?: number } = {}): Promise<MobileInboxSnapshot> {
  const fresh = options.fresh ?? false;
  const generation = inboxGeneration;
  if (!fresh && inboxCache && Date.now() - inboxCache.timestamp < INBOX_CACHE_TTL) {
    return limitMobileInboxSessions(inboxCache.snapshot, options.limit);
  }

  if (!fresh && inboxInflight && inboxInflight.generation === generation) {
    const snapshot = await inboxInflight.promise;
    return limitMobileInboxSessions(snapshot, options.limit);
  }

  const promise = (async () => {
    try {
      const snapshot = await buildMobileInboxSnapshot({ fresh });
      if (generation === inboxGeneration) {
        inboxCache = { snapshot, timestamp: Date.now() };
      }
      return snapshot;
    } finally {
      if (inboxInflight?.generation === generation) {
        inboxInflight = null;
      }
    }
  })();
  inboxInflight = { generation, promise };
  const snapshot = await promise;
  return limitMobileInboxSessions(snapshot, options.limit);
}

async function buildMobileInboxSnapshot(options: { fresh?: boolean } = {}): Promise<MobileInboxSnapshot> {
  const fresh = options.fresh ?? false;
  const fleet = await getRuntimeInventorySnapshot({ fresh });
  const inventorySessions = fleet.agents
    .filter((agent) => agent.runtime === 'codex' || agent.runtime === 'claude-code')
    .map((agent, index) => ({ agent, index }))
    .sort((left, right) => {
      const priorityDiff = mobileSessionPriority(right.agent) - mobileSessionPriority(left.agent);
      return priorityDiff !== 0 ? priorityDiff : left.index - right.index;
    })
    .map(({ agent }) => agent);

  const sessions: AgentSummary[] = [];
  const seenSessionIds = new Set<string>();
  for (const agent of inventorySessions) {
    if (!shouldExposeMobileSession(agent)) continue;
    const identity = mobileSessionIdentity(agent);
    if (seenSessionIds.has(identity)) continue;
    seenSessionIds.add(identity);
    sessions.push(agent);
  }

  const workspaceChats = listIdeLlmChatSessions();
  for (const chat of workspaceChats) {
    const currentTask = chat.lastMessage ? summarizeTranscript(chat.lastMessage) : 'Start a conversation.';
    const parsedLastActivity = new Date(chat.modifiedAt ?? chat.savedAt ?? Date.now()).getTime();
    const session: AgentSummary = {
      id: chat.sessionKey,
      name: chat.label,
      squadId: 'workspace-chat',
      runtime: 'chat',
      model: chat.model || 'Workspace Chat',
      primaryModel: chat.model || 'Workspace Chat',
      status: chat.isCurrentSession ? 'running' : 'idle',
      currentTask,
      workspace: chat.repoPath || '~',
      branch: 'workspace',
      sessionKey: chat.sessionKey,
      approvalStatus: 'none',
      lastEventAt: relativeMobileAge(chat.modifiedAt ?? chat.savedAt),
      lastActivityAt: Number.isNaN(parsedLastActivity) ? Date.now() : parsedLastActivity,
      context: {
        usedPercent: 0,
        trend: 'stable',
      },
      alerts: 0,
      sessionId: chat.tabId,
      surfaceLabel: chat.label,
      isCurrentSession: chat.isCurrentSession,
      runtimeSurface: {
        id: chat.sessionKey,
        runtime: 'chat',
        kind: 'chat-session',
        ownership: 'owned',
        title: chat.label,
        cwd: chat.repoPath,
        branch: 'workspace',
        sourceLabel: 'Workspace LLM chat tab',
        capabilities: {
          attach: false,
          readTail: true,
          sendInput: true,
          interrupt: false,
          resize: false,
          diffContext: true,
          reviewContext: true,
        },
      },
    };
    if (!shouldExposeMobileSession(session)) continue;
    const identity = mobileSessionIdentity(session);
    if (seenSessionIds.has(identity)) continue;
    seenSessionIds.add(identity);
    sessions.push(session);
  }

  const pendingApprovals = listApprovals({ status: 'pending' });
  const approvalsBySession = new Map<string, ApprovalRecord[]>();
  for (const approval of pendingApprovals) {
    const current = approvalsBySession.get(approval.sessionKey) ?? [];
    approvalsBySession.set(approval.sessionKey, [...current, approval]);
  }
  for (let index = 0; index < sessions.length; index += 1) {
    const session = sessions[index];
    if (!approvalsBySession.has(session.sessionKey) || session.approvalStatus === 'pending') continue;
    sessions[index] = {
      ...session,
      approvalStatus: 'pending',
    };
  }

  const orderedSessions = sessions
    .map((session, index) => ({ session, index }))
    .sort((left, right) => {
      const priorityDiff = mobileSessionPriority(right.session) - mobileSessionPriority(left.session);
      return priorityDiff !== 0 ? priorityDiff : left.index - right.index;
    })
    .map(({ session }) => session);

  const primarySession = orderedSessions.find((session) => session.isCurrentSession)
    ?? orderedSessions.find((session) => session.sessionKey === fleet.meta.primarySessionKey)
    ?? orderedSessions.find((session) => session.status === 'running')
    ?? orderedSessions[0];

  const [reviewSnapshot, primaryTranscript] = await Promise.all([
    getWorkspaceReviewSnapshot({ fresh }).catch(() => null),
    primarySession ? getMobileSessionTranscript(primarySession.sessionKey, 3, fresh).catch(() => []) : Promise.resolve([]),
  ]);

  const primarySnippet = primaryTranscript.length
    ? summarizeTranscript(primaryTranscript[primaryTranscript.length - 1]?.text ?? '')
    : '';

  const items: MobileInboxItem[] = [];
  const approvals = pendingApprovals.map(toMobileApprovalCard);

  if (primarySession) {
    items.push({
      id: `run:${primarySession.sessionKey}`,
      kind: 'run_watch',
      severity: alertSeverity(primarySession),
      title: primarySession.isCurrentSession ? 'This chat is mirrored on mobile' : `${primarySession.name} is the primary mirror`,
      detail: buildSessionLine(primarySession, primarySnippet),
      sessionKey: primarySession.sessionKey,
      timestampLabel: primarySession.lastEventAt,
      actions: sessionActions(primarySession),
    });
  }

  for (const approval of pendingApprovals) {
    items.push({
      id: `approval:${approval.id}`,
      approvalId: approval.id,
      kind: 'approval',
      severity: approvalSeverity(approval.risk),
      title: approval.title,
      detail: approval.command
        ? `${approval.description} • $ ${approval.command}`
        : approval.description,
      metadata: approval.metadata,
      sessionKey: approval.sessionKey,
      timestampLabel: relativeMobileAge(new Date(approval.createdAt).toISOString()),
      actions: approvalActions(approval),
    });
  }

  for (const agent of orderedSessions.filter((session) => session.sessionKey !== primarySession?.sessionKey)) {
    if (!['running', 'reviewing', 'blocked', 'failed'].includes(agent.status) && agent.alerts === 0) {
      continue;
    }

    items.push({
      id: `alert:${agent.sessionKey}`,
      kind: 'alert',
      severity: alertSeverity(agent),
      title: `${agent.name} • ${agent.surfaceLabel ?? agent.status}`,
      detail: `${agent.currentTask} • ${agent.lastEventAt}`,
      sessionKey: agent.sessionKey,
      timestampLabel: agent.lastEventAt,
      actions: sessionActions(agent),
    });

    if (items.length >= 5) {
      break;
    }
  }

  let review: MobileReviewFocus | undefined;
  if (reviewSnapshot) {
    const leadPr = reviewSnapshot.pullRequests[0];
    const changedCount = reviewSnapshot.changedFiles.length;
    const issueStackLabel = reviewSnapshot.activeIssues.length
      ? ` • ${reviewSnapshot.activeIssues.map((issue) => `#${issue.number}`).join(' • ')}`
      : '';

    items.push({
      id: `review:${reviewSnapshot.branch}`,
      kind: 'review',
      severity: reviewSnapshot.dirty ? 'warning' : 'info',
      title: leadPr
        ? `Review ready • PR #${leadPr.number}`
        : `Review surface • ${reviewSnapshot.branch}`,
      detail: leadPr
        ? `${leadPr.title} • ${changedCount} changed file${changedCount === 1 ? '' : 's'}${issueStackLabel}`
        : `${reviewSnapshot.branch} • ${changedCount} changed file${changedCount === 1 ? '' : 's'}${issueStackLabel}`,
      timestampLabel: 'desktop review',
      actions: [
        {
          kind: 'open_review',
          label: 'Review stack ↗',
          href: '/#workflow-review-panel',
          available: true,
        },
        {
          kind: 'open_desktop',
          label: leadPr ? 'GitHub PR ↗' : 'Desktop ↗',
          href: leadPr?.url ?? '/',
          available: true,
        },
      ],
    });

    review = {
      repoSlug: reviewSnapshot.repoSlug,
      branch: reviewSnapshot.branch,
      desktopHref: '/#workflow-review-panel',
      pullRequest: leadPr,
      issues: reviewSnapshot.activeIssues,
      changedFiles: reviewSnapshot.changedFiles,
      diffStat: reviewSnapshot.diffStat,
    };
  }

  const alerts = items.filter((item) => item.kind === 'alert' && item.severity !== 'info').length;
  const approvalCount = pendingApprovals.length;
  const reviewItems = items.filter((item) => item.kind === 'review').length;
  const activeRuns = orderedSessions.filter((agent) => ['running', 'reviewing', 'blocked', 'waiting', 'failed'].includes(agent.status)).length;

  return {
    generatedAt: new Date().toISOString(),
    mode: fleet.meta.mode,
    sourceLabel: fleet.meta.sourceLabel,
    primarySessionKey: primarySession?.sessionKey,
    note: fleet.meta.mode === 'live'
      ? 'Mobile now reflects the local Codex and Claude Code runtime inventory, plus IDE chat and review state.'
      : fleet.meta.note,
    sessions: orderedSessions,
    approvals,
    items,
    summary: {
      alerts,
      approvals: approvalCount,
      reviewItems,
      activeRuns,
    },
    review,
  };
}
