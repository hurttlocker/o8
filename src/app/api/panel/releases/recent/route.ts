import { NextResponse } from 'next/server';
import { githubInstallationFetch } from '@/lib/github-broker/auth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const RELEASE_REPO = 'hurttlocker/o8-releases';
const NO_STORE = { 'Cache-Control': 'no-store, max-age=0' };

interface GitHubRelease {
  tag_name?: string;
  name?: string;
  body?: string;
  published_at?: string;
  html_url?: string;
  draft?: boolean;
}

async function fetchRecentReleases(): Promise<GitHubRelease[]> {
  const path = `/repos/${RELEASE_REPO}/releases?per_page=5`;
  try {
    const { response } = await githubInstallationFetch(RELEASE_REPO, path);
    const text = await response.text();
    if (!response.ok) throw new Error(text || `GitHub request failed (${response.status}).`);
    return JSON.parse(text) as GitHubRelease[];
  } catch (appError) {
    const response = await fetch(`https://api.github.com${path}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'o8-recent-releases',
      },
      cache: 'no-store',
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(
        text
          || (appError instanceof Error ? appError.message : '')
          || `GitHub request failed (${response.status}).`,
      );
    }
    return JSON.parse(text) as GitHubRelease[];
  }
}

export async function GET(request: Request) {
  try {
    const rawCount = Number.parseInt(new URL(request.url).searchParams.get('count') ?? '2', 10);
    const count = Number.isFinite(rawCount) ? Math.max(1, Math.min(rawCount, 2)) : 2;
    const releases = (await fetchRecentReleases())
      .filter((release) => release.draft !== true && Boolean(release.tag_name || release.name))
      .slice(0, count)
      .map((release) => ({
        version: release.tag_name || release.name || 'Release',
        body: release.body?.trim() || '',
        publishedAt: release.published_at ?? null,
        releaseUrl: release.html_url ?? null,
      }));

    return NextResponse.json({ releases }, { headers: NO_STORE });
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : 'Unable to load recent releases.',
      releases: [],
    }, { status: 502, headers: NO_STORE });
  }
}
