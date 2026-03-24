import 'server-only';

import { githubInstallationFetch } from './auth';

async function parseGithubJson<T>(response: Response) {
  const text = await response.text();
  if (!response.ok) {
    throw new Error(text || `GitHub request failed (${response.status})`);
  }
  return JSON.parse(text) as T;
}

export async function fetchGitHubIssueDetail(repoFullName: string, issueNumber: number) {
  const { response } = await githubInstallationFetch(repoFullName, `/repos/${repoFullName}/issues/${issueNumber}`);
  const issue = await parseGithubJson<{
    number: number;
    title: string;
    body?: string | null;
    state: string;
    labels?: Array<{ name?: string | null; color?: string | null }>;
    user?: { login?: string | null } | null;
    assignees?: Array<{ login?: string | null }>;
    created_at?: string;
    comments?: number;
    html_url?: string;
  }>(response);

  return {
    number: issue.number,
    title: issue.title ?? '',
    body: issue.body ?? '',
    state: issue.state ?? 'open',
    labels: (issue.labels ?? [])
      .map((label) => label.name ? { name: label.name, color: label.color ?? '000000' } : null)
      .filter((label): label is { name: string; color: string } => Boolean(label)),
    author: issue.user?.login ?? 'unknown',
    assignees: (issue.assignees ?? [])
      .map((assignee) => assignee.login ?? '')
      .filter(Boolean),
    createdAt: issue.created_at ?? '',
    comments: issue.comments ?? 0,
    url: issue.html_url ?? '',
  };
}

export async function fetchGitHubPullRequestDetail(repoFullName: string, prNumber: number) {
  const { response } = await githubInstallationFetch(repoFullName, `/repos/${repoFullName}/pulls/${prNumber}`);
  const pr = await parseGithubJson<{
    number: number;
    title: string;
    body?: string | null;
    state: string;
    html_url: string;
    created_at: string;
    updated_at: string;
    closed_at?: string | null;
    merged_at?: string | null;
    user?: { login?: string | null } | null;
    head?: { ref?: string | null; sha?: string | null } | null;
    base?: { ref?: string | null } | null;
    additions?: number;
    deletions?: number;
    changed_files?: number;
    mergeable?: boolean | null;
  }>(response);

  const filesResponse = await githubInstallationFetch(repoFullName, `/repos/${repoFullName}/pulls/${prNumber}/files?per_page=100`);
  const files = await parseGithubJson<Array<{
    filename: string;
    additions?: number;
    deletions?: number;
    status?: string;
  }>>(filesResponse.response);

  let statusCheckRollup: Array<{ name: string; status?: string | null; conclusion?: string | null }> = [];
  if (pr.head?.sha) {
    try {
      const checksResponse = await githubInstallationFetch(repoFullName, `/repos/${repoFullName}/commits/${pr.head.sha}/check-runs?per_page=100`);
      const checksPayload = await parseGithubJson<{
        check_runs?: Array<{ name?: string | null; status?: string | null; conclusion?: string | null }>;
      }>(checksResponse.response);
      statusCheckRollup = (checksPayload.check_runs ?? [])
        .filter((check): check is { name: string; status?: string | null; conclusion?: string | null } => Boolean(check.name))
        .map((check) => ({ name: check.name, status: check.status ?? null, conclusion: check.conclusion ?? null }));
    } catch {
      statusCheckRollup = [];
    }
  }

  let reviewDecision: string | null = null;
  try {
    const reviewsResponse = await githubInstallationFetch(repoFullName, `/repos/${repoFullName}/pulls/${prNumber}/reviews?per_page=100`);
    const reviews = await parseGithubJson<Array<{ state?: string | null }>>(reviewsResponse.response);
    const latestDecision = [...reviews].reverse().find((review) => review.state && review.state !== 'COMMENTED');
    reviewDecision = latestDecision?.state ?? null;
  } catch {
    reviewDecision = null;
  }

  return {
    number: pr.number,
    title: pr.title ?? '',
    body: pr.body ?? '',
    state: pr.state ?? 'open',
    author: pr.user?.login ?? 'unknown',
    headRefName: pr.head?.ref ?? '',
    baseRefName: pr.base?.ref ?? '',
    additions: pr.additions ?? 0,
    deletions: pr.deletions ?? 0,
    changedFiles: pr.changed_files ?? 0,
    createdAt: pr.created_at,
    updatedAt: pr.updated_at,
    closedAt: pr.closed_at ?? null,
    mergedAt: pr.merged_at ?? null,
    mergeable: Boolean(pr.mergeable),
    reviewDecision,
    statusCheckRollup,
    url: pr.html_url,
    files: files.map((file) => ({
      path: file.filename,
      status: file.status ?? 'modified',
      additions: file.additions ?? 0,
      deletions: file.deletions ?? 0,
    })),
  };
}

export async function fetchGitHubPullRequestComments(repoFullName: string, prNumber: number) {
  const [reviewCommentsResponse, reviewsResponse, issueCommentsResponse] = await Promise.all([
    githubInstallationFetch(repoFullName, `/repos/${repoFullName}/pulls/${prNumber}/comments?per_page=100`),
    githubInstallationFetch(repoFullName, `/repos/${repoFullName}/pulls/${prNumber}/reviews?per_page=100`),
    githubInstallationFetch(repoFullName, `/repos/${repoFullName}/issues/${prNumber}/comments?per_page=100`),
  ]);

  const [reviewComments, reviews, issueComments] = await Promise.all([
    parseGithubJson<Array<{
      id: number;
      body?: string | null;
      path?: string | null;
      line?: number | null;
      side?: string | null;
      created_at?: string | null;
      diff_hunk?: string | null;
      in_reply_to_id?: number | null;
      user?: { login?: string | null } | null;
    }>>(reviewCommentsResponse.response),
    parseGithubJson<Array<{
      id: number;
      body?: string | null;
      state?: string | null;
      submitted_at?: string | null;
      user?: { login?: string | null } | null;
    }>>(reviewsResponse.response),
    parseGithubJson<Array<{
      id: number;
      body?: string | null;
      created_at?: string | null;
      user?: { login?: string | null } | null;
    }>>(issueCommentsResponse.response),
  ]);

  return {
    comments: reviewComments.map((comment) => ({
      id: comment.id,
      author: comment.user?.login ?? 'unknown',
      body: comment.body ?? '',
      path: comment.path ?? '',
      line: comment.line ?? null,
      side: comment.side ?? '',
      createdAt: comment.created_at ?? '',
      state: '',
      diffHunk: comment.diff_hunk ?? '',
      inReplyTo: comment.in_reply_to_id ?? null,
    })),
    reviews: reviews.map((review) => ({
      id: review.id,
      author: review.user?.login ?? 'unknown',
      body: review.body ?? '',
      state: review.state ?? '',
      submittedAt: review.submitted_at ?? '',
    })),
    issueComments: issueComments.map((comment) => ({
      id: comment.id,
      body: comment.body ?? '',
      user: comment.user?.login ?? 'unknown',
      created_at: comment.created_at ?? '',
    })),
  };
}
