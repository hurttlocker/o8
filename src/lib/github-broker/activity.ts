import 'server-only';

import { githubInstallationFetch } from './auth';

async function parseGithubJson<T>(response: Response) {
  const text = await response.text();
  if (!response.ok) {
    throw new Error(text || `GitHub request failed (${response.status})`);
  }
  return JSON.parse(text) as T;
}

export async function fetchGitHubCommits(repoFullName: string, limit = 15) {
  const { response } = await githubInstallationFetch(
    repoFullName,
    `/repos/${repoFullName}/commits?per_page=${Math.min(limit, 30)}`,
  );
  const commits = await parseGithubJson<Array<{
    sha?: string;
    commit?: { message?: string; committer?: { date?: string | null } | null };
  }>>(response);

  return commits.map((commit) => ({
    hash: (commit.sha ?? '').slice(0, 7),
    message: (commit.commit?.message ?? '').split('\n')[0],
    date: commit.commit?.committer?.date ?? '',
  }));
}

export async function fetchGitHubWorkflowRuns(repoFullName: string, limit = 15) {
  const { response } = await githubInstallationFetch(
    repoFullName,
    `/repos/${repoFullName}/actions/runs?per_page=${Math.min(limit, 30)}`,
  );
  const payload = await parseGithubJson<{
    workflow_runs?: Array<{
      id: number;
      display_title?: string | null;
      event?: string | null;
      head_branch?: string | null;
      status?: string | null;
      conclusion?: string | null;
      created_at?: string | null;
      updated_at?: string | null;
      name?: string | null;
      html_url?: string | null;
    }>;
  }>(response);

  return (payload.workflow_runs ?? []).map((run) => ({
    databaseId: run.id,
    displayTitle: run.display_title ?? '',
    event: run.event ?? '',
    headBranch: run.head_branch ?? '',
    status: run.status ?? '',
    conclusion: run.conclusion ?? '',
    createdAt: run.created_at ?? '',
    updatedAt: run.updated_at ?? '',
    workflowName: run.name ?? '',
    url: run.html_url ?? '',
  }));
}

export async function fetchGitHubWorkflowRunDetail(repoFullName: string, runId: number) {
  const [runResponse, jobsResponse] = await Promise.all([
    githubInstallationFetch(repoFullName, `/repos/${repoFullName}/actions/runs/${runId}`),
    githubInstallationFetch(repoFullName, `/repos/${repoFullName}/actions/runs/${runId}/jobs?per_page=100`),
  ]);

  const run = await parseGithubJson<{
    id: number;
    display_title?: string | null;
    event?: string | null;
    head_branch?: string | null;
    status?: string | null;
    conclusion?: string | null;
    created_at?: string | null;
    updated_at?: string | null;
    name?: string | null;
    html_url?: string | null;
    run_attempt?: number | null;
  }>(runResponse.response);

  const jobsPayload = await parseGithubJson<{
    jobs?: Array<{
      id: number;
      name?: string | null;
      status?: string | null;
      conclusion?: string | null;
      started_at?: string | null;
      completed_at?: string | null;
      html_url?: string | null;
      steps?: Array<{
        name?: string | null;
        status?: string | null;
        conclusion?: string | null;
        number?: number | null;
      }>;
    }>;
  }>(jobsResponse.response);

  return {
    run: {
      databaseId: run.id,
      displayTitle: run.display_title ?? '',
      event: run.event ?? '',
      headBranch: run.head_branch ?? '',
      status: run.status ?? '',
      conclusion: run.conclusion ?? '',
      createdAt: run.created_at ?? '',
      updatedAt: run.updated_at ?? '',
      workflowName: run.name ?? '',
      url: run.html_url ?? '',
      jobs: jobsPayload.jobs ?? [],
    },
    logs: '',
  };
}
