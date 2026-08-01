import { basename, join } from 'node:path';
import { rowDisplayTitle } from '@/lib/cortex/qa/composer';
import { recallRows } from '@/lib/cortex/qa/recall';
import type { TypedRow } from '@/lib/cortex/qa/types';
import { getSqlite } from '@/lib/db';
import { listRepos } from '@/lib/repos/registry';
import { getActiveProjectScopeForRepo } from '@/lib/repos/projects';
import type { SearchResult, SearchTarget } from '@/lib/search/types';

interface OutcomeTargetRow {
  packet_id: string | null;
  lane_id: string | null;
  session_key: string | null;
}

function stringField(row: TypedRow, key: string): string | null {
  const value = row.fields[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function cleanExcerpt(value: string | undefined): string {
  return (value ?? '').replace(/[«»]/g, '').replace(/\s+/g, ' ').trim().slice(0, 150);
}

function outcomeTarget(row: TypedRow): SearchTarget | null {
  let packetId = stringField(row, 'packetId');
  let laneId = stringField(row, 'laneId');
  let sessionKey = stringField(row, 'sessionKey');
  if (!packetId && !laneId && !sessionKey) {
    try {
      const record = getSqlite().prepare(`
        SELECT packet_id, lane_id, session_key
        FROM session_outcomes
        WHERE id = ?
      `).get(row.citation.rowId) as OutcomeTargetRow | undefined;
      packetId = record?.packet_id ?? null;
      laneId = record?.lane_id ?? null;
      sessionKey = record?.session_key ?? null;
    } catch {
      return null;
    }
  }
  if (!packetId && !laneId && !sessionKey) return null;
  return {
    ...(packetId ? { packetId } : {}),
    ...(laneId ? { laneId } : {}),
    ...(sessionKey ? { sessionKey } : {}),
  };
}

function targetForRow(
  row: TypedRow,
  repoPath: string,
  repoPathsByName: Map<string, string>,
): SearchTarget | null {
  if (row.citation.kind === 'directive') {
    return { directiveId: row.citation.rowId };
  }
  if (row.citation.kind === 'outcome') return outcomeTarget(row);
  if (row.citation.kind === 'doc') {
    const relativePath = stringField(row, 'relPath') ?? row.citation.sourcePath;
    if (!relativePath) return null;
    const repoName = stringField(row, 'repoName')?.toLowerCase();
    const sourceRepoPath = repoName
      ? repoPathsByName.get(repoName) ?? (basename(repoPath).toLowerCase() === repoName ? repoPath : null)
      : repoPath;
    return sourceRepoPath ? { filePath: join(sourceRepoPath, relativePath) } : null;
  }
  return null;
}

function detailForRow(row: TypedRow): string {
  if (row.citation.kind === 'doc') return stringField(row, 'relPath') ?? cleanExcerpt(row.citation.excerpt);
  if (row.citation.kind === 'outcome') {
    const repoPath = stringField(row, 'repoPath');
    const excerpt = cleanExcerpt(row.citation.excerpt) || stringField(row, 'summary') || '';
    return [repoPath ? basename(repoPath) : null, excerpt].filter(Boolean).join(' · ').slice(0, 150);
  }
  return cleanExcerpt(row.citation.excerpt) || stringField(row, 'body')?.slice(0, 150) || '';
}

export async function searchRecall(query: string, repoPath: string): Promise<{
  results: SearchResult[];
  cacheHit: boolean;
  classifyMs: number;
  retrievalMs: number;
  semanticMs: number;
}> {
  const projectId = (await getActiveProjectScopeForRepo(repoPath)).projectId;
  const recalled = await recallRows(query, repoPath, projectId);
  if (recalled.rows.length === 0) return { ...recalled, results: [] };

  const repos = await listRepos().catch(() => []);
  const repoPathsByName = new Map(repos.map((repo) => [repo.name.toLowerCase(), repo.localPath]));
  const results = recalled.rows.flatMap<SearchResult>((row, index) => {
    const target = targetForRow(row, repoPath, repoPathsByName);
    if (!target) return [];
    return [{
      kind: 'recall',
      id: `recall:${row.citation.kind}:${row.citation.rowId}`,
      title: rowDisplayTitle(row),
      detail: detailForRow(row),
      target,
      score: 70 - index,
    }];
  });
  return { ...recalled, results };
}
