/**
 * GET /api/cortex/directives
 *
 * Lists directive markdown files from the data dir's `directives/` folder.
 * Each file has YAML-like front matter: id, title, scope, repoName, priority,
 * created, updated, projects. The body below the second `---` is the
 * directive text.
 *
 * Query params:
 *   ?repoPath=<absolute-repo-path>  — optional. When supplied, the response is
 *     filtered to directives that apply to that repo using the same tier rules
 *     as the dispatch context builder (`lib/cortex/directives/filter.ts`):
 *       - global  → always included
 *       - project → included when the directive's `projects:` slug list
 *                   intersects the repo's Project memberships
 *       - repo    → included when `repoName` / `scope: <repoName>` matches
 *
 * Without the param the route returns every directive — preserves the original
 * read-only behavior for callers that want the full list.
 *
 * Response:
 *   { directives: Array<{ id, title, scope, repoName?, priority?, body, recentMerges, projects? }> }
 *
 * Surface — Recall Card (#742) and Packet Review Card (#729) consume this.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';
import { readAllDirectiveTrailers } from '@/lib/cortex/directive-merges';
import { withTimingSync } from '@/lib/cortex/diagnostics';
import { parseDirectiveFile, type ParsedDirective } from '@/lib/cortex/directives/parse';
import {
  directiveAppliesToRepo,
  resolveRepoProjectSlugs,
} from '@/lib/cortex/directives/filter';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface DirectiveSummary {
  id: string;
  title: string;
  scope: string;
  repoName: string | null;
  priority: number | null;
  body: string;
  /** #899 — project slug membership; empty when not project-scoped. */
  projects: string[];
  /** #769 — last 3 trailer lines newest-first; empty until a merge appends one. */
  recentMerges: string[];
}

function toSummary(parsed: ParsedDirective): DirectiveSummary {
  return {
    id: parsed.id,
    title: parsed.title,
    scope: parsed.scope,
    repoName: parsed.repoName,
    priority: parsed.priority,
    body: parsed.body,
    projects: parsed.projects,
    recentMerges: [],
  };
}

export async function GET(req: NextRequest) {
  try {
    const dataDir = getDataDir();
    const directivesDir = join(dataDir, 'directives');

    if (!existsSync(directivesDir)) {
      return NextResponse.json({ directives: [] }, {
        headers: { 'Cache-Control': 'no-store, max-age=0' },
      });
    }

    const repoPath = req.nextUrl.searchParams.get('repoPath')?.trim() || null;

    const parsedAll: ParsedDirective[] = withTimingSync('recall.directives', () => {
      const entries = readdirSync(directivesDir).filter((name) => name.endsWith('.md'));
      const out: ParsedDirective[] = [];
      for (const name of entries) {
        try {
          const raw = readFileSync(join(directivesDir, name), 'utf-8');
          const fallbackId = name.replace(/\.md$/, '');
          const parsed = parseDirectiveFile(raw, fallbackId);
          if (parsed) out.push(parsed);
        } catch (error) {
          console.warn(`[cortex-directives] Failed to read ${name}:`, error);
        }
      }
      return out;
    });

    // #899 — when a repoPath is supplied, apply the same scope-tier filter
    // that dispatch context uses. Resolves project memberships once.
    let parsed: ParsedDirective[] = parsedAll;
    if (repoPath) {
      const projectSlugsForRepo = await resolveRepoProjectSlugs(repoPath);
      parsed = parsedAll.filter((d) => directiveAppliesToRepo(d, repoPath, projectSlugsForRepo));
    }

    const directives = parsed.map(toSummary);

    // #769 — Hydrate recent-merge trailers from the same markdown files.
    // The helper re-reads the dir, but the cost is trivial (≤dozens of small
    // files) and keeps the trailer logic colocated with the writer.
    const trailerMap = readAllDirectiveTrailers(3);
    for (const directive of directives) {
      directive.recentMerges = trailerMap[directive.id] ?? [];
    }

    // Sort by priority desc (higher = more important), then title.
    directives.sort((a, b) => {
      const ap = a.priority ?? 0;
      const bp = b.priority ?? 0;
      if (ap !== bp) return bp - ap;
      return a.title.localeCompare(b.title);
    });

    return NextResponse.json({ directives }, {
      headers: { 'Cache-Control': 'no-store, max-age=0' },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to load directives.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
