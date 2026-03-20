export interface DesktopChatInjectionPayload {
  reason: string;
  text: string;
}

interface ReviewCommentContext {
  prNumber: number;
  repo?: string;
  author: string;
  body: string;
  createdAt?: string;
  path?: string;
  line?: number | null;
}

interface CiCheckContext {
  prNumber: number;
  repo?: string;
  name: string;
  status: string;
  conclusion: string;
  detailsUrl?: string;
  startedAt?: string;
  completedAt?: string;
}

function formatRepoContext(prNumber: number, repo?: string) {
  return repo ? `PR #${prNumber} in ${repo}` : `PR #${prNumber}`;
}

function formatDuration(startedAt?: string, completedAt?: string) {
  if (!startedAt || !completedAt) return null;
  const ms = new Date(completedAt).getTime() - new Date(startedAt).getTime();
  if (!Number.isFinite(ms) || ms <= 0) return null;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  return `${Math.round(ms / 60_000)}m`;
}

export function formatReviewCommentInjection(context: ReviewCommentContext): DesktopChatInjectionPayload {
  const lines = [
    `[PR comment from ${formatRepoContext(context.prNumber, context.repo)}]`,
    `Author: ${context.author}`,
  ];
  if (context.path) {
    lines.push(`File: ${context.path}${context.line ? `:${context.line}` : ''}`);
  }
  if (context.createdAt) {
    lines.push(`Created: ${context.createdAt}`);
  }
  lines.push('', context.body.trim());
  return {
    reason: `pr-comment-${context.prNumber}-${context.author.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    text: lines.join('\n'),
  };
}

export function formatReviewCommentBatchInjection(
  prNumber: number,
  repo: string | undefined,
  comments: ReviewCommentContext[],
): DesktopChatInjectionPayload {
  const header = `[PR comment bundle from ${formatRepoContext(prNumber, repo)}]`;
  const blocks = comments
    .filter((comment) => comment.body.trim())
    .map((comment, index) => {
      const intro = `${index + 1}. ${comment.author}${comment.path ? ` on ${comment.path}${comment.line ? `:${comment.line}` : ''}` : ''}`;
      return `${intro}\n${comment.body.trim()}`;
    });

  return {
    reason: `pr-comment-batch-${prNumber}`,
    text: [header, '', ...blocks].join('\n\n'),
  };
}

export function formatCiCheckInjection(context: CiCheckContext): DesktopChatInjectionPayload {
  const duration = formatDuration(context.startedAt, context.completedAt);
  const lines = [
    `[CI check context from ${formatRepoContext(context.prNumber, context.repo)}]`,
    `Check: ${context.name}`,
    `Status: ${context.conclusion || context.status}`,
  ];
  if (duration) {
    lines.push(`Duration: ${duration}`);
  }
  if (context.detailsUrl) {
    lines.push(`Details: ${context.detailsUrl}`);
  }
  return {
    reason: `ci-check-${context.prNumber}-${context.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    text: lines.join('\n'),
  };
}

export function formatCiCheckBatchInjection(
  prNumber: number,
  repo: string | undefined,
  checks: CiCheckContext[],
): DesktopChatInjectionPayload {
  const header = `[Failing CI checks from ${formatRepoContext(prNumber, repo)}]`;
  const lines = checks.map((check, index) => {
    const duration = formatDuration(check.startedAt, check.completedAt);
    const bits = [
      `${index + 1}. ${check.name}`,
      `status=${check.conclusion || check.status}`,
      duration ? `duration=${duration}` : null,
      check.detailsUrl ? `details=${check.detailsUrl}` : null,
    ].filter(Boolean);
    return bits.join(' • ');
  });

  return {
    reason: `ci-check-batch-${prNumber}`,
    text: [header, '', ...lines].join('\n'),
  };
}
