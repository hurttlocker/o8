export interface AgentPanelChatInjectionPayload {
  reason: string;
  text: string;
  previewImageDataUri?: string;
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

interface ReviewThreadContext {
  prNumber: number;
  repo?: string;
  status: 'active' | 'outdated' | 'resolved';
  path?: string;
  line?: number | null;
  comments: ReviewCommentContext[];
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

interface DeployContext {
  project?: string;
  repo?: string;
  environment?: string;
  state: string;
  url?: string;
  sha?: string;
  createdAt?: string;
  target?: string;
  commitMessage?: string;
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

export function formatReviewCommentInjection(context: ReviewCommentContext): AgentPanelChatInjectionPayload {
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
): AgentPanelChatInjectionPayload {
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

export function formatReviewThreadInjection(context: ReviewThreadContext): AgentPanelChatInjectionPayload {
  const lines = [
    `[PR review thread from ${formatRepoContext(context.prNumber, context.repo)}]`,
    `Status: ${context.status}`,
  ];

  if (context.path) {
    lines.push(`File: ${context.path}${context.line ? `:${context.line}` : ''}`);
  }

  const commentBlocks = context.comments
    .filter((comment) => comment.body.trim())
    .map((comment, index) => {
      const metadata = [
        `${index + 1}. ${comment.author}`,
        comment.createdAt ? `created=${comment.createdAt}` : null,
        comment.path ? `file=${comment.path}${comment.line ? `:${comment.line}` : ''}` : null,
      ].filter(Boolean);
      return `${metadata.join(' • ')}\n${comment.body.trim()}`;
    });

  return {
    reason: `pr-review-thread-${context.prNumber}-${(context.path ?? 'thread').toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    text: [...lines, '', ...commentBlocks].join('\n\n'),
  };
}

export function formatCiCheckInjection(context: CiCheckContext): AgentPanelChatInjectionPayload {
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
): AgentPanelChatInjectionPayload {
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

export function formatDeployContextInjection(context: DeployContext): AgentPanelChatInjectionPayload {
  const subject = context.project
    ? `deployment context from ${context.project}`
    : context.repo
      ? `deployment context from ${context.repo}`
      : 'deployment context';
  const lines = [`[${subject}]`, `State: ${context.state}`];
  if (context.environment) {
    lines.push(`Environment: ${context.environment}`);
  }
  if (context.target) {
    lines.push(`Target: ${context.target}`);
  }
  if (context.sha) {
    lines.push(`SHA: ${context.sha}`);
  }
  if (context.createdAt) {
    lines.push(`Created: ${context.createdAt}`);
  }
  if (context.url) {
    lines.push(`URL: ${context.url}`);
  }
  if (context.commitMessage) {
    lines.push(`Commit: ${context.commitMessage}`);
  }
  return {
    reason: `deploy-${(context.project ?? context.repo ?? 'context').toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${(context.environment ?? context.state ?? 'state').toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    text: lines.join('\n'),
  };
}

export function formatDeployBatchInjection(
  project: string | undefined,
  repo: string | undefined,
  deployments: DeployContext[],
): AgentPanelChatInjectionPayload {
  const subject = project ?? repo ?? 'workspace';
  const header = `[Deployment context from ${subject}]`;
  const lines = deployments.map((deployment, index) => {
    const parts = [
      `${index + 1}. ${deployment.environment ?? deployment.target ?? 'deployment'}`,
      `state=${deployment.state}`,
      deployment.sha ? `sha=${deployment.sha}` : null,
      deployment.url ? `url=${deployment.url}` : null,
      deployment.createdAt ? `created=${deployment.createdAt}` : null,
    ].filter(Boolean);
    return parts.join(' • ');
  });

  return {
    reason: `deploy-batch-${subject.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    text: [header, '', ...lines].join('\n'),
  };
}
