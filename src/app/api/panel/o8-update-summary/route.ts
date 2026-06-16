/**
 * /api/panel/o8-update-summary — slim summarizer for the UpdateCard.
 *
 * Pulls a GitHub release (and its commit list) for o8 itself and runs
 * the body through one of the free OpenRouter models (same pool the
 * scratch chat / GitHub summary route uses). Returns a 1–2 sentence
 * professional paragraph the operator can read in the AgentPanel
 * sidebar without opening the GH release page.
 *
 * Pure GET — no body required, version is a query param so this is safe
 * to cache by version. Stays read-only and never falls outside o8's
 * own public repo, so we can hit the unauthed GitHub API.
 */

import { NextRequest, NextResponse } from 'next/server';
import { resolveOpenRouterRoute } from '@/lib/cortex/qa/llm/inference-route';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const SUMMARY_MODELS = [
  'poolside/laguna-m.1:free',
  'openai/gpt-oss-120b:free',
  'nvidia/nemotron-3-super-120b-a12b:free',
];

const RELEASE_REPO = 'hurttlocker/o8-releases';
const COMMIT_LIMIT = 12;

type GithubRelease = {
  tag_name?: string;
  name?: string;
  body?: string;
  published_at?: string;
  html_url?: string;
};

type GithubCommit = {
  sha?: string;
  commit?: {
    message?: string;
    author?: { name?: string | null } | null;
  };
  html_url?: string;
};

function summaryModels() {
  const raw = process.env.O8_SCRATCH_OPENROUTER_MODELS?.trim()
    || process.env.O8_SCRATCH_OPENROUTER_MODEL?.trim()
    || '';
  if (!raw) return SUMMARY_MODELS;
  const configured = raw.split(',').map((item) => item.trim()).filter(Boolean);
  return configured.length > 0 ? configured : SUMMARY_MODELS;
}

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const response = await fetch(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'o8-update-summary',
      },
      cache: 'no-store',
    });
    if (!response.ok) return null;
    const text = await response.text();
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

async function summarizeWithOpenRouter(prompt: string): Promise<string> {
  const route = await resolveOpenRouterRoute();
  if (!route) {
    throw new Error('No inference route — set an OpenRouter key or apply a plan.');
  }

  const messages = [
    {
      role: 'system',
      content: [
        'You are o8 summarizing a software release for the operator in their sidebar.',
        'Write ONE professional paragraph (3-4 short sentences, max ~60 words).',
        'Lead with the most important user-visible change. Mention bug fixes and design polish briefly.',
        'No bullet points, no headings, no markdown — just prose.',
        'Never invent features that are not in the release notes or commits.',
      ].join('\n'),
    },
    { role: 'user', content: prompt },
  ];

  const failures: string[] = [];
  for (const model of summaryModels()) {
    try {
      const response = await fetch(route.url, {
        method: 'POST',
        headers: route.headers,
        body: JSON.stringify({ model, messages }),
      });
      const text = await response.text();
      if (!response.ok) {
        failures.push(`${model}: HTTP ${response.status} ${text.slice(0, 120)}`);
        continue;
      }
      const parsed = JSON.parse(text) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const summary = parsed.choices?.[0]?.message?.content?.trim();
      if (summary) return summary;
      failures.push(`${model}: empty response`);
    } catch (error) {
      failures.push(`${model}: ${error instanceof Error ? error.message : 'request failed'}`);
    }
  }
  throw new Error(`OpenRouter summary failed. ${failures.join(' | ')}`);
}

export async function GET(request: NextRequest) {
  try {
    const version = request.nextUrl.searchParams.get('version')?.trim();
    if (!version) {
      return NextResponse.json({ error: 'version query param is required.' }, { status: 400 });
    }

    const tag = version.startsWith('v') ? version : `v${version}`;

    const [release, commits] = await Promise.all([
      fetchJson<GithubRelease>(`https://api.github.com/repos/${RELEASE_REPO}/releases/tags/${tag}`),
      fetchJson<GithubCommit[]>(`https://api.github.com/repos/${RELEASE_REPO}/commits?per_page=${COMMIT_LIMIT}`),
    ]);

    if (!release) {
      return NextResponse.json({
        error: `Could not fetch release ${tag} from ${RELEASE_REPO}.`,
      }, { status: 404 });
    }

    const body = release.body?.trim() || '';
    const commitTitles = (commits ?? [])
      .map((commit) => (commit.commit?.message ?? '').split('\n')[0])
      .filter(Boolean)
      .slice(0, COMMIT_LIMIT);

    const prompt = [
      `Release: ${tag}`,
      release.published_at ? `Published: ${release.published_at}` : null,
      release.html_url ? `URL: ${release.html_url}` : null,
      '',
      'Release notes body (from GitHub):',
      body || '(no body)',
      '',
      'Recent commit titles on main (newest first, may include commits beyond this release):',
      commitTitles.length > 0 ? commitTitles.map((title) => `- ${title}`).join('\n') : '(none)',
    ].filter(Boolean).join('\n');

    const summary = await summarizeWithOpenRouter(prompt);
    return NextResponse.json({
      version: tag,
      summary,
      releaseUrl: release.html_url ?? null,
    });
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : 'Unable to summarize update.',
    }, { status: 500 });
  }
}
