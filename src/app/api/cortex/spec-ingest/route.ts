/**
 * POST /api/cortex/spec-ingest  (#1114)
 *
 * Manually trigger spec ingestion for one or all registered repos. Useful
 * after upgrading the ingestor to backfill all existing repos, and for
 * dogfooding cortex_ask immediately without waiting for the next addRepo.
 *
 * Body:
 *   { repoPath?: string }   — ingest one specific repo (absolute path)
 *   { all: true }           — ingest every registered repo (sequential)
 *
 * Returns per-repo SpecIngestResult.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';

import { ingestRepoSpecs, type SpecIngestResult } from '@/lib/cortex/spec-ingest';
import { listRepos } from '@/lib/repos/registry';

interface IngestBody {
  repoPath?: unknown;
  all?: unknown;
}

interface PerRepoResult extends SpecIngestResult {
  repoPath: string;
  repoSlug: string;
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as IngestBody | null;
  const singleRepoPath = typeof body?.repoPath === 'string' ? body.repoPath.trim() : '';
  const wantAll = body?.all === true;

  if (!singleRepoPath && !wantAll) {
    return NextResponse.json(
      { ok: false, error: 'Provide either { repoPath } or { all: true }.' },
      { status: 400 },
    );
  }

  try {
    const registry = await listRepos();

    if (singleRepoPath) {
      const entry = registry.find((r) => r.localPath === singleRepoPath);
      const slug = entry?.name;
      const result = await ingestRepoSpecs(singleRepoPath, slug);
      return NextResponse.json({
        ok: true,
        repos: [{ repoPath: singleRepoPath, repoSlug: slug ?? singleRepoPath, ...result }] satisfies PerRepoResult[],
      });
    }

    // all = true: walk every registered repo. Sequential so disk + classifier
    // pressure stays bounded.
    const repos: PerRepoResult[] = [];
    for (const entry of registry) {
      try {
        const result = await ingestRepoSpecs(entry.localPath, entry.name);
        repos.push({ repoPath: entry.localPath, repoSlug: entry.name, ...result });
      } catch (err) {
        repos.push({
          repoPath: entry.localPath,
          repoSlug: entry.name,
          scannedFiles: 0,
          writtenDirectives: 0,
          deletedStaleDirectives: 0,
          files: [],
          // Surface per-repo failures inline so a single bad checkout doesn't blank the whole response.
          ...({ error: err instanceof Error ? err.message : String(err) } as Record<string, string>),
        });
      }
    }

    return NextResponse.json({ ok: true, repos });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
