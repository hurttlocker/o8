/**
 * GET /api/cortex/directives
 *
 * Lists directive markdown files from the data dir's `directives/` folder.
 * Each file has YAML-like front matter: id, title, scope, repoName, priority,
 * created, updated. The body below the second `---` is the directive text.
 *
 * Response:
 *   { directives: Array<{ id, title, scope, repoName?, priority?, body }> }
 *
 * Surface — Packet Review Card (#729) lists directive titles in its SPEC
 * pane. Read-only.
 */

import { NextResponse } from 'next/server';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';
import { readAllDirectiveTrailers } from '@/lib/cortex/directive-merges';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface DirectiveSummary {
  id: string;
  title: string;
  scope: string;
  repoName: string | null;
  priority: number | null;
  body: string;
  /** #769 — last 3 trailer lines newest-first; empty until a merge appends one. */
  recentMerges: string[];
}

const FRONT_MATTER_BOUNDARY = /^---\s*$/m;

function parseDirectiveFile(raw: string, fallbackId: string): DirectiveSummary | null {
  const text = raw.replace(/\r\n/g, '\n').trim();
  if (!text.startsWith('---')) return null;

  // Strip leading ---, find next ---
  const afterFirst = text.slice(3).trimStart();
  const closingIndex = afterFirst.search(FRONT_MATTER_BOUNDARY);
  if (closingIndex < 0) return null;

  const front = afterFirst.slice(0, closingIndex);
  const rawBody = afterFirst.slice(closingIndex).replace(FRONT_MATTER_BOUNDARY, '').trim();
  // #769 — Strip the `## Recent Merges` trailer so the body shown in the UI
  // stays the operator-authored content. Trailer lines are surfaced via the
  // separate `recentMerges` field so the recall card can render them with
  // dedicated chrome.
  const body = rawBody.replace(/\n*##\s+Recent Merges\b[\s\S]*$/, '').trim();

  const meta: Record<string, string> = {};
  for (const line of front.split('\n')) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key) meta[key] = value;
  }

  const priorityRaw = meta.priority;
  const priorityNum = priorityRaw ? Number.parseInt(priorityRaw, 10) : NaN;

  return {
    id: meta.id?.trim() || fallbackId,
    title: meta.title?.trim() || fallbackId,
    scope: meta.scope?.trim() || 'global',
    repoName: meta.repoName?.trim() || null,
    priority: Number.isFinite(priorityNum) ? priorityNum : null,
    body,
    recentMerges: [],
  };
}

export async function GET() {
  try {
    const dataDir = getDataDir();
    const directivesDir = join(dataDir, 'directives');

    if (!existsSync(directivesDir)) {
      return NextResponse.json({ directives: [] }, {
        headers: { 'Cache-Control': 'no-store, max-age=0' },
      });
    }

    const entries = readdirSync(directivesDir).filter((name) => name.endsWith('.md'));
    const directives: DirectiveSummary[] = [];
    for (const name of entries) {
      try {
        const raw = readFileSync(join(directivesDir, name), 'utf-8');
        const fallbackId = name.replace(/\.md$/, '');
        const parsed = parseDirectiveFile(raw, fallbackId);
        if (parsed) directives.push(parsed);
      } catch (error) {
        console.warn(`[cortex-directives] Failed to read ${name}:`, error);
      }
    }

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
