import type { AgentSummary, EventSeverity } from '@/lib/fleet/types';
import { getSessionTranscript } from '@/lib/openclaw/chat';
import { getOpenClawFleetSnapshot } from '@/lib/openclaw/fleet';
import { getWorkspaceReviewSnapshot } from '@/lib/review/workspace';
import type { MobileControlAction, MobileInboxItem, MobileInboxSnapshot, MobileReviewFocus } from '@/lib/mobile/types';

function sessionActions(agent: AgentSummary): MobileControlAction[] {
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
      available: true,
    },
    {
      kind: 'stop',
      label: 'Stop run',
      sessionKey: agent.sessionKey,
      destructive: true,
      available: true,
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

function summarizeTranscript(text: string) {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  return normalized.length > 180 ? `${normalized.slice(0, 177)}…` : normalized;
}

export async function getMobileInboxSnapshot(): Promise<MobileInboxSnapshot> {
  const fleet = await getOpenClawFleetSnapshot();
  const sessions = fleet.agents;
  const primarySession = sessions.find((session) => session.sessionKey === fleet.meta.primarySessionKey) ?? sessions[0];

  const [reviewSnapshot, primaryTranscript] = await Promise.all([
    getWorkspaceReviewSnapshot().catch(() => null),
    primarySession ? getSessionTranscript(primarySession.sessionKey, 3).catch(() => []) : Promise.resolve([]),
  ]);

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
  const activeRuns = sessions.filter((agent) => ['running', 'reviewing', 'blocked'].includes(agent.status)).length;

  return {
    generatedAt: new Date().toISOString(),
    mode: fleet.meta.mode,
    sourceLabel: fleet.meta.sourceLabel,
    primarySessionKey: fleet.meta.primarySessionKey,
    note:
      fleet.meta.mode === 'live'
        ? 'Mobile now speaks to a Cortex IDE control snapshot, not a Codex-specific remote. OpenClaw is simply the first live backing adapter.'
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
}
