import { execFileSync } from 'node:child_process';
import { NextRequest, NextResponse } from 'next/server';
import { githubInstallationFetch } from '@/lib/github-broker/auth';
import { normalizeRepoSlug } from '@/lib/github-broker/repo';
import { resolveOpenRouterRoute } from '@/lib/cortex/qa/llm/inference-route';
import { resolveRepoPathFromRegistry } from '@/lib/repos/repo-path-registry';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const SUMMARY_MODELS = [
  'poolside/laguna-m.1:free',
  'openai/gpt-oss-120b:free',
  'nvidia/nemotron-3-super-120b-a12b:free',
];

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parseLimit(value: unknown) {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? Math.max(5, Math.min(parsed, 20)) : 12;
}

async function resolveWorkspaceRepoSlug(repoPath: unknown) {
  if (typeof repoPath !== 'string' || !repoPath.trim()) {
    throw new Error('repoPath is required.');
  }
  const resolved = await resolveRepoPathFromRegistry(repoPath);
  if (!resolved.ok) {
    throw new Error(resolved.message);
  }

  const remoteUrl = execFileSync('git', ['remote', 'get-url', 'origin'], {
    windowsHide: true,
    cwd: resolved.repoRoot,
    encoding: 'utf8',
    timeout: 5_000,
  }).trim();
  const repoSlug = normalizeRepoSlug(remoteUrl);
  if (!repoSlug) {
    throw new Error('This workspace does not have a GitHub origin remote.');
  }
  return { repoSlug, remoteUrl };
}

async function fetchGithubJson<T>(repoSlug: string, path: string): Promise<T> {
  try {
    const { response } = await githubInstallationFetch(repoSlug, path);
    const text = await response.text();
    if (!response.ok) throw new Error(text || `GitHub request failed (${response.status})`);
    return JSON.parse(text) as T;
  } catch (appError) {
    const response = await fetch(`https://api.github.com${path}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'o8-scratch-chat',
      },
      cache: 'no-store',
    });
    const text = await response.text();
    if (!response.ok) {
      const detail = appError instanceof Error ? appError.message : 'GitHub App request failed';
      throw new Error(text || detail || `GitHub request failed (${response.status})`);
    }
    return JSON.parse(text) as T;
  }
}

function summaryModels() {
  const raw = process.env.O8_SCRATCH_OPENROUTER_MODELS?.trim()
    || process.env.O8_SCRATCH_OPENROUTER_MODEL?.trim()
    || '';
  if (!raw) return SUMMARY_MODELS;
  const configured = raw.split(',').map((item) => item.trim()).filter(Boolean);
  return configured.length > 0 ? configured : SUMMARY_MODELS;
}

async function summarizeWithOpenRouter(input: string) {
  const route = await resolveOpenRouterRoute();
  if (!route) {
    throw new Error('No inference route — set an OpenRouter key or apply a plan.');
  }

  const messages = [
    {
      role: 'system',
      content: [
        'You are o8 summarizing GitHub activity for an operator.',
        'Use only the provided GitHub commit, issue, and workflow data.',
        'Be concise. Group the work by theme, mention authors/bots when useful, and call out failures or issues.',
        'Do not claim you changed code or inspected local files.',
      ].join('\n'),
    },
    { role: 'user', content: input },
  ];

  const failures: string[] = [];
  for (const model of route.model ? [route.model] : summaryModels()) {
    try {
      const response = await fetch(route.url, {
        method: 'POST',
        headers: route.headers,
        body: JSON.stringify({ model, messages }),
      });
      const text = await response.text();
      if (!response.ok) {
        failures.push(`${model}: HTTP ${response.status} ${text.slice(0, 160)}`);
        continue;
      }
      const parsed = JSON.parse(text) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const summary = parsed.choices?.[0]?.message?.content?.trim();
      if (summary) return { summary, model };
      failures.push(`${model}: empty response`);
    } catch (error) {
      failures.push(`${model}: ${error instanceof Error ? error.message : 'request failed'}`);
    }
  }

  throw new Error(`OpenRouter summary failed. ${failures.join(' | ')}`);
}

export async function POST(request: NextRequest) {
  try {
    const body = asRecord(await request.json().catch(() => null));
    if (!body) {
      return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
    }

    const limit = parseLimit(body.limit);
    const { repoSlug, remoteUrl } = await resolveWorkspaceRepoSlug(body.repoPath);
    const [commits, issues, runs] = await Promise.all([
      fetchGithubJson<Array<{
        sha?: string;
        html_url?: string;
        author?: { login?: string | null; type?: string | null } | null;
        commit?: {
          message?: string;
          author?: { name?: string | null; date?: string | null } | null;
          committer?: { name?: string | null; date?: string | null } | null;
        };
      }>>(repoSlug, `/repos/${repoSlug}/commits?per_page=${limit}`),
      fetchGithubJson<Array<{
        number?: number;
        title?: string;
        html_url?: string;
        updated_at?: string;
        user?: { login?: string | null; type?: string | null } | null;
        pull_request?: unknown;
      }>>(repoSlug, `/repos/${repoSlug}/issues?state=open&sort=updated&direction=desc&per_page=8`),
      fetchGithubJson<{
        workflow_runs?: Array<{
          display_title?: string | null;
          name?: string | null;
          event?: string | null;
          head_branch?: string | null;
          conclusion?: string | null;
          status?: string | null;
          updated_at?: string | null;
          actor?: { login?: string | null; type?: string | null } | null;
        }>;
      }>(repoSlug, `/repos/${repoSlug}/actions/runs?per_page=6`),
    ]);

    const openIssues = issues.filter((issue) => !issue.pull_request);
    const prompt = [
      `Repo: ${repoSlug}`,
      `Remote: ${remoteUrl}`,
      '',
      'Recent commits:',
      JSON.stringify(commits.map((commit) => ({
        sha: commit.sha?.slice(0, 7),
        title: (commit.commit?.message ?? '').split('\n')[0],
        author: commit.author?.login ?? commit.commit?.author?.name ?? commit.commit?.committer?.name ?? 'unknown',
        authorType: commit.author?.type ?? null,
        date: commit.commit?.committer?.date ?? commit.commit?.author?.date ?? null,
        url: commit.html_url ?? null,
      })), null, 2),
      '',
      'Recent open issues:',
      JSON.stringify(openIssues.map((issue) => ({
        number: issue.number,
        title: issue.title,
        author: issue.user?.login ?? 'unknown',
        authorType: issue.user?.type ?? null,
        updatedAt: issue.updated_at ?? null,
        url: issue.html_url ?? null,
      })), null, 2),
      '',
      'Recent workflow runs:',
      JSON.stringify((runs.workflow_runs ?? []).map((run) => ({
        title: run.display_title ?? run.name ?? 'workflow run',
        actor: run.actor?.login ?? 'unknown',
        actorType: run.actor?.type ?? null,
        event: run.event ?? null,
        branch: run.head_branch ?? null,
        status: run.status ?? null,
        conclusion: run.conclusion ?? null,
        updatedAt: run.updated_at ?? null,
      })), null, 2),
    ].join('\n');

    const result = await summarizeWithOpenRouter(prompt);
    return NextResponse.json({
      repo: repoSlug,
      summary: result.summary,
      model: result.model,
      commitCount: commits.length,
      issueCount: openIssues.length,
      workflowRunCount: runs.workflow_runs?.length ?? 0,
    });
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : 'Unable to summarize GitHub activity.',
    }, { status: 500 });
  }
}
