import type { MobileInboxSnapshot } from '@/lib/mobile/types';

function sessionSignature(session: MobileInboxSnapshot['sessions'][number]) {
  return `${session.sessionKey}:${session.status}:${session.currentTask}:${session.approvalStatus}:${session.name}:${session.lastEventAt}:${session.workspace}:${session.branch}:${Math.round(session.context?.usedPercent ?? 0)}:${session.alerts}`;
}

function itemSignature(item: MobileInboxSnapshot['items'][number]) {
  return `${item.id}:${item.kind}:${item.severity}:${item.title}:${item.detail}:${item.sessionKey ?? ''}:${item.timestampLabel ?? ''}:${item.actions.map((action) => `${action.kind}:${action.label}:${action.available ? 1 : 0}`).join(',')}`;
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
    snapshot.items.map(itemSignature).join('|'),
    `${snapshot.summary.alerts}:${snapshot.summary.activeRuns}:${snapshot.summary.approvals}:${snapshot.summary.reviewItems}`,
    reviewSignature(snapshot.review),
  ].join('||');
}

export function sameMobileInboxSnapshot(left: MobileInboxSnapshot, right: MobileInboxSnapshot) {
  return mobileInboxSignature(left) === mobileInboxSignature(right);
}
