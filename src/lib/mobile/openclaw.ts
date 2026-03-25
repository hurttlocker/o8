import type { AgentSummary, EventSeverity } from '@/lib/fleet/types';
import { getSessionActivity, getSessionTranscript } from '@/lib/openclaw/chat';
import { getRuntimeInventorySnapshot } from '@/lib/runtime/inventory';
import { getWorkspaceReviewSnapshot } from '@/lib/review/workspace';
import type { MobileControlAction, MobileInboxItem, MobileInboxSnapshot, MobileReviewFocus } from '@/lib/mobile/types';
import { invalidateMobileBootstrapBroker } from '@/lib/render/bootstrap';

function sessionActions(agent: AgentSummary): MobileControlAction[] {
  const runtimeSurface = agent.runtimeSurface;
  const canSteer = Boolean(runtimeSurface?.capabilities.sendInput);
  const canStop = Boolean(runtimeSurface?.capabilities.interrupt);
  const ownershipNote = agent.runtime === 'codex'
    ? runtimeSurface?.ownership === 'owned'
      ? 'This owned Codex surface can resume between runs and interrupt a live run when one is active.'
      : 'This discovered Codex terminal is only actionable while its live local process is still attached.'
    : agent.runtime === 'claude-code'
      ? 'This Claude Code surface is only actionable while the live local process is still present.'
      : 'This action is not wired truthfully on the current runtime surface.';

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
  if (agent.runtime === 'openclaw') {
    return Boolean(agent.isCurrentSession)
      || ['running', 'reviewing', 'blocked', 'waiting'].includes(agent.status);
  }

  if (agent.runtime === 'codex') {
    return true;
  }

  if (agent.runtime === 'claude-code') {
    return true;
  }

  return false;
}

function mobileSessionIdentity(agent: AgentSummary) {
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

let inboxCache: { snapshot: MobileInboxSnapshot; timestamp: number; includeOpenClaw: boolean } | null = null;

/** Invalidate the inbox cache — call after any mutation (steer/stop/launch/resume). */
export function invalidateInboxCache() {
  inboxGeneration += 1;
  inboxCache = null;
  inboxInflight = null;
  invalidateMobileBootstrapBroker();
}
let inboxInflight: { generation: number; includeOpenClaw: boolean; promise: Promise<MobileInboxSnapshot> } | null = null;
let inboxGeneration = 0;
const INBOX_CACHE_TTL = 8000; // 8 seconds — generous idle TTL

export async function getMobileInboxSnapshot(options: { fresh?: boolean; includeOpenClaw?: boolean } = {}): Promise<MobileInboxSnapshot> {
  const fresh = options.fresh ?? false;
  const includeOpenClaw = options.includeOpenClaw ?? true;
  const generation = inboxGeneration;
  if (!fresh && inboxCache && inboxCache.includeOpenClaw === includeOpenClaw && Date.now() - inboxCache.timestamp < INBOX_CACHE_TTL) {
    return inboxCache.snapshot;
  }

  // Deduplicate: if a request is already in-flight, piggyback on it
  if (!fresh && inboxInflight && inboxInflight.generation === generation && inboxInflight.includeOpenClaw === includeOpenClaw) {
    return inboxInflight.promise;
  }

  const promise = (async () => {
    try {
      const snapshot = await _fetchMobileInboxSnapshot({ fresh, includeOpenClaw });
      if (generation === inboxGeneration) {
        inboxCache = { snapshot, timestamp: Date.now(), includeOpenClaw };
      }
      return snapshot;
    } finally {
      if (inboxInflight?.generation === generation && inboxInflight.includeOpenClaw === includeOpenClaw) {
        inboxInflight = null;
      }
    }
  })();
  inboxInflight = { generation, includeOpenClaw, promise };
  return promise;
}

async function _fetchMobileInboxSnapshot(options: { fresh?: boolean; includeOpenClaw?: boolean } = {}): Promise<MobileInboxSnapshot> {
  const fresh = options.fresh ?? false;
  const includeOpenClaw = options.includeOpenClaw ?? true;

  const fleet = await getRuntimeInventorySnapshot({ fresh, includeOpenClaw });
  const orderedSessions = fleet.agents
    .filter((agent) => (
      agent.runtime === 'openclaw'
        || agent.runtime === 'codex'
        || agent.runtime === 'claude-code'
    ))
    .map((agent, index) => ({ agent, index }))
    .sort((left, right) => {
      const priorityDiff = mobileSessionPriority(right.agent) - mobileSessionPriority(left.agent);
      return priorityDiff !== 0 ? priorityDiff : left.index - right.index;
    })
    .map(({ agent }) => agent);
  const sessions: AgentSummary[] = [];
  const seenSessionIds = new Set<string>();
  for (const agent of orderedSessions) {
    if (!shouldExposeMobileSession(agent)) continue;
    const identity = mobileSessionIdentity(agent);
    if (seenSessionIds.has(identity)) continue;
    seenSessionIds.add(identity);
    sessions.push(agent);
  }
  const primarySession = sessions.find((session) => session.sessionKey === fleet.meta.primarySessionKey)
    ?? sessions.find((session) => session.runtime === 'openclaw' && session.isCurrentSession)
    ?? sessions.find((session) => session.runtime === 'openclaw')
    ?? sessions[0];

  // Fetch review, transcript, and activity for all sessions in parallel
  const activityPromises = sessions.map((s) =>
    s.activity
      ? Promise.resolve(s.activity)
      : s.runtime === 'openclaw'
        ? getSessionActivity(s.sessionKey).catch(() => undefined)
        : Promise.resolve(undefined),
  );

  const [reviewSnapshot, primaryTranscript, ...activities] = await Promise.all([
    getWorkspaceReviewSnapshot({ fresh }).catch(() => null),
    primarySession ? getSessionTranscript(primarySession.sessionKey, 3, fresh).catch(() => []) : Promise.resolve([]),
    ...activityPromises,
  ]);

  // Attach activity to each session
  for (let i = 0; i < sessions.length; i++) {
    const activity = activities[i];
    if (activity) {
      sessions[i] = { ...sessions[i], activity };
    }
  }

  const primarySnippet = primaryTranscript.length
    ? summarizeTranscript(primaryTranscript[primaryTranscript.length - 1]?.text ?? '')
    : '';

  const items: MobileInboxItem[] = [];

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

  for (const agent of sessions.filter((session) => session.sessionKey !== primarySession?.sessionKey)) {
    if (!['running', 'reviewing', 'blocked', 'failed'].includes(agent.status) && agent.alerts === 0) {
      continue;
    }

    items.push({
      id: `alert:${agent.sessionKey}`,
      kind: agent.approvalStatus === 'pending' ? 'approval' : 'alert',
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
  const approvals = items.filter((item) => item.kind === 'approval').length;
  const reviewItems = items.filter((item) => item.kind === 'review').length;
  const activeRuns = sessions.filter((agent) => ['running', 'reviewing', 'blocked', 'waiting', 'failed'].includes(agent.status)).length;

  const result: MobileInboxSnapshot = {
    generatedAt: new Date().toISOString(),
    mode: fleet.meta.mode,
    sourceLabel: fleet.meta.sourceLabel,
    primarySessionKey: fleet.meta.primarySessionKey,
    note:
      fleet.meta.mode === 'live'
        ? 'Mobile now speaks to a Cortex IDE control snapshot. OpenClaw remains the first actionable backing adapter, while IDE-owned Codex surfaces now expose lifecycle, review state, exact diff context, between-runs resume, and active-run interrupt on phone when the session is truly owned and running.'
        : fleet.meta.note,
    sessions,
    items,
    summary: {
      alerts,
      approvals,
      reviewItems,
      activeRuns,
    },
    review,
  };

  return result;
}
