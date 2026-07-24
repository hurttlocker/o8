import type { MobileInboxSnapshot } from '@/lib/mobile/types';

function sessionSignature(session: MobileInboxSnapshot['sessions'][number]) {
  return `${session.sessionKey}:${session.status}:${session.currentTask}:${session.approvalStatus}:${session.name}:${session.lastEventAt}:${session.lastActivityAt ?? ''}:${session.workspace}:${session.branch}:${Math.round(session.context?.usedPercent ?? 0)}:${session.alerts}`;
}

function itemSignature(item: MobileInboxSnapshot['items'][number]) {
  return `${item.id}:${item.kind}:${item.severity}:${item.title}:${item.detail}:${item.approvalId ?? ''}:${item.sessionKey ?? ''}:${item.timestampLabel ?? ''}:${item.actions.map((action) => `${action.kind}:${action.label}:${action.available ? 1 : 0}`).join(',')}`;
}

function approvalSignature(approval: MobileInboxSnapshot['approvals'][number]) {
  return `${approval.id}:${approval.approvalId ?? ''}:${approval.sessionKey}:${approval.agent}:${approval.severity}:${approval.title}:${approval.description}:${approval.createdAt}:${approval.repo ?? ''}:${approval.repoPath ?? ''}:${approval.repoSlug ?? ''}:${approval.branch ?? ''}:${(approval.changedFilePaths ?? []).join(',')}:${approval.filesChanged ?? ''}:${approval.additions ?? ''}:${approval.deletions ?? ''}:${approval.previewUrl ?? ''}:${approval.terminalSessionName ?? ''}:${Object.entries(approval.metadata ?? {}).sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => `${key}:${value}`).join('|')}`;
}

function reviewUnitSignature(unit: MobileInboxSnapshot['reviewUnits'][number]) {
  return `${unit.id}:${unit.sessionKey}:${unit.approvalId ?? ''}:${unit.authority}:${unit.status}:${unit.title}:${unit.agent}:${unit.runtime}:${unit.repo}:${unit.repoSlug ?? ''}:${unit.repoPath}:${unit.branch}:${unit.baseBranch ?? ''}:${unit.baseSha ?? ''}:${unit.headSha ?? ''}:${unit.worktreePath ?? ''}:${unit.fileCount}:${unit.additions}:${unit.deletions}:${unit.diffAvailable ? 1 : 0}:${unit.previewUrl ?? ''}:${unit.terminalSessionName ?? ''}:${unit.actions.join(',')}:${unit.staleReason ?? ''}:${unit.changedFiles.map((file) => `${file.path}:${file.status}:${file.additions ?? ''}:${file.deletions ?? ''}`).join('|')}`;
}

function fleetSessionSignature(session: MobileInboxSnapshot['fleetSessions'][number]) {
  return `${session.id}:${session.sessionKey}:${session.runtime}:${session.runtimeLabel}:${session.runtimeAccent}:${session.status}:${session.title}:${session.repo}:${session.repoPath}:${session.branch}:${session.worktreePath ?? ''}:${session.terminalSessionName ?? ''}:${session.terminalAvailable ? 1 : 0}:${session.previewUrl ?? ''}:${session.approvalId ?? ''}:${session.reviewAuthority ?? ''}:${session.actions.join(',')}:${session.lastEventAt ?? ''}:${session.lastActivityAt ?? ''}:${session.huddlePlan ?? ''}`;
}

function reviewSignature(review: MobileInboxSnapshot['review']) {
  if (!review) return 'no-review';
  const pullRequestSig = review.pullRequest
    ? `${review.pullRequest.number}:${review.pullRequest.title}:${review.pullRequest.url}:${review.pullRequest.headRefName}:${review.pullRequest.baseRefName}:${review.pullRequest.state}:${review.pullRequest.reviewDecision ?? ''}:${review.pullRequest.isDraft ? 1 : 0}:${(review.pullRequest.linkedIssueNumbers ?? []).join(',')}`
    : 'no-pr';
  const issuesSig = review.issues.map((issue) => `${issue.number}:${issue.title}:${issue.state}:${issue.url}`).join('|');
  return `${review.repoSlug}:${review.branch}:${review.desktopHref}:${review.diffStat ?? ''}:${pullRequestSig}:${issuesSig}:${review.changedFiles.map((file) => `${file.path}:${file.status}:${file.additions ?? ''}:${file.deletions ?? ''}`).join('|')}`;
}

export function mobileInboxSignature(snapshot: MobileInboxSnapshot) {
  return [
    snapshot.mode,
    snapshot.sourceLabel,
    snapshot.primarySessionKey ?? '',
    snapshot.note ?? '',
    snapshot.sessions.map(sessionSignature).join('|'),
    (snapshot.fleetSessions ?? []).map(fleetSessionSignature).join('|'),
    (snapshot.approvals ?? []).map(approvalSignature).join('|'),
    (snapshot.reviewUnits ?? []).map(reviewUnitSignature).join('|'),
    snapshot.items.map(itemSignature).join('|'),
    `${snapshot.summary.alerts}:${snapshot.summary.activeRuns}:${snapshot.summary.approvals}:${snapshot.summary.reviewItems}:${snapshot.summary.inspectOnlyReviews ?? ''}`,
    reviewSignature(snapshot.review),
  ].join('||');
}

export function sameMobileInboxSnapshot(left: MobileInboxSnapshot, right: MobileInboxSnapshot) {
  return mobileInboxSignature(left) === mobileInboxSignature(right);
}
