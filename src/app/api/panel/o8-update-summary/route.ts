/**
 * /api/panel/o8-update-summary — slim summarizer for the UpdateCard.
 *
 * Pulls a GitHub release (and its commit list) for o8 itself and writes
 * a 1–2 sentence professional paragraph the operator can read in the
 * AgentPanel sidebar without opening the GH release page. Model ladder
 * (Q ruling 2026-07-31): the o8-default gateway model first (the ship
 * note deserves the stronger house model), then the free OpenRouter
 * pool, then the non-LLM digest — the note never gates on inference.
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

/// The public repo's CHANGELOG.md is the real "what changed" content —
/// dated sections of sanitized high-signal commit subjects. The RELEASE
/// bodies there are release.mjs boilerplate, and the repo's own commit
/// subjects are all "sync: Update changelog" noise, so this file is the
/// only honest source for summarization. Returns the newest entry lines
/// (shas stripped), capped.
async function fetchChangelogEntries(limit = 24): Promise<string[]> {
  try {
    const response = await fetch(
      `https://raw.githubusercontent.com/${RELEASE_REPO}/main/CHANGELOG.md`,
      { headers: { 'User-Agent': 'o8-update-summary' }, cache: 'no-store' },
    );
    if (!response.ok) return [];
    const text = await response.text();
    const out: string[] = [];
    for (const rawLine of text.split('\n')) {
      const line = rawLine.trim();
      if (line.startsWith('## ')) {
        if (out.length >= limit) break;
        out.push(line.replace(/^##\s*/, '').trim());
        continue;
      }
      if (!line.startsWith('- ')) continue;
      const entry = line.replace(/^-\s*/, '').replace(/`[0-9a-f]{7,40}`\s*/i, '').trim();
      if (entry) out.push(entry);
      if (out.length >= limit) break;
    }
    return out;
  } catch {
    return [];
  }
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

function summaryMessages(prompt: string) {
  return [
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
}

/// o8-default first: plain fetch to the Vercel AI Gateway's OpenAI-compatible
/// endpoint (the ai-SDK carve-out stays scoped to chat/gateway-client.ts).
/// max_tokens stays generous — the V4-Flash gateway build thinks before it
/// writes, and a starved budget returns an empty 200. Null = fall through.
async function summarizeWithGatewayDefault(prompt: string): Promise<string | null> {
  const key = process.env.VERCEL_AI_GATEWAY_API_KEY?.trim();
  if (!key) return null;
  try {
    const response = await fetch('https://ai-gateway.vercel.sh/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek/deepseek-v4-flash',
        messages: summaryMessages(prompt),
        max_tokens: 2048,
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) return null;
    const parsed = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    return parsed.choices?.[0]?.message?.content?.trim() || null;
  } catch {
    return null;
  }
}

async function summarizeWithOpenRouter(prompt: string): Promise<string> {
  const route = await resolveOpenRouterRoute();
  if (!route) {
    throw new Error('No inference route — set an OpenRouter key or apply a plan.');
  }

  const messages = summaryMessages(prompt);

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

/// Non-LLM digest: the release body already IS the sanitized public
/// changelog, so the top lines are honest, human-written content.
function fallbackSummary(tag: string, body: string, commitTitles: string[]): string {
  const lines = body
    .split('\n')
    .map((line) => line.replace(/^[-*#>\s]+/, '').trim())
    // Drop the release.mjs boilerplate ("Auto-update artifacts for o8 vX. See
    // <url> for details.") — the o8-releases COMMITS are the real sanitized
    // changelog, so a boilerplate-only body must fall through to them.
    .filter((line) => line.length > 0
      && !/^\[/.test(line)
      && !/^auto-update artifacts/i.test(line)
      && !/^see https?:\/\//i.test(line));
  const source = lines.length > 0 ? lines : commitTitles;
  const top = source.slice(0, 4).join(' \u00b7 ');
  return top || `${tag} is ready to install.`;
}

export async function GET(request: NextRequest) {
  try {
    const version = request.nextUrl.searchParams.get('version')?.trim();
    if (!version) {
      return NextResponse.json({ error: 'version query param is required.' }, { status: 400 });
    }

    const tag = version.startsWith('v') ? version : `v${version}`;

    const [release, commits, changelogEntries] = await Promise.all([
      fetchJson<GithubRelease>(`https://api.github.com/repos/${RELEASE_REPO}/releases/tags/${tag}`),
      fetchJson<GithubCommit[]>(`https://api.github.com/repos/${RELEASE_REPO}/commits?per_page=${COMMIT_LIMIT}`),
      fetchChangelogEntries(),
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
      'Public changelog (newest first — date headers then entries; summarize the entries closest to this release\'s publish date):',
      changelogEntries.length > 0 ? changelogEntries.map((entry) => `- ${entry}`).join('\n') : '(none)',
      '',
      'Recent commit titles on main (newest first, may include commits beyond this release):',
      commitTitles.length > 0 ? commitTitles.map((title) => `- ${title}`).join('\n') : '(none)',
    ].filter(Boolean).join('\n');

    // The note must NEVER gate on inference (operator ruling 2026-07-10: the
    // update note is product surface — free installs without any LLM route
    // still get real content). LLM polish when a route exists; otherwise a
    // plain digest of the sanitized release notes.
    let summary: string;
    let fallback = false;
    try {
      summary = await summarizeWithGatewayDefault(prompt) ?? await summarizeWithOpenRouter(prompt);
    } catch {
      // Prefer changelog entries over commit titles — the o8-releases repo's
      // own commit subjects are "sync: Update changelog" noise.
      const digestSource = changelogEntries.filter((entry) => !/^\d{4}-\d{2}-\d{2}$/.test(entry));
      summary = fallbackSummary(tag, body, digestSource.length > 0 ? digestSource : commitTitles);
      fallback = true;
    }
    return NextResponse.json({
      version: tag,
      summary,
      fallback,
      releaseUrl: release.html_url ?? null,
    });
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : 'Unable to summarize update.',
    }, { status: 500 });
  }
}
