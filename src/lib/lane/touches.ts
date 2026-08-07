import { execFileSync } from 'node:child_process';

import { getSqlite } from '@/lib/db';
import type { LaneStatus } from './types';

const ACTIVE_LANE_STATUSES = [
  'idle',
  'launching',
  'running',
  'paused',
  'awaiting_input',
  'reviewing',
  'merging',
] as const satisfies readonly LaneStatus[];

export interface LaneTouch {
  packetId: string | null;
  laneId: string;
  status: LaneStatus;
  branch: string;
  lastTouchedAt: number;
  files: string[];
}

export interface FindLanesTouchingOptions {
  repo?: string | null;
  excludeLaneId?: string | null;
  excludePacketId?: string | null;
}

export interface PacketDiffLaneTouches {
  packetId: string;
  laneId: string;
  paths: string[];
  lanes: LaneTouch[];
}

interface LaneTouchRow {
  id: string;
  repo_path: string;
  worktree_path: string | null;
  branch: string;
  base_branch: string;
  packet_id: string | null;
  status: string;
  updated_at: string;
  last_event_at: string | null;
  files_touched: string | null;
}

function normalizeTouchPath(value: string) {
  return value
    .trim()
    .replace(/^\.\/+/, '')
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/');
}

function normalizeTouchPaths(input: string | string[]) {
  const values = Array.isArray(input) ? input : [input];
  return Array.from(new Set(
    values
      .flatMap((value) => value.split(','))
      .map(normalizeTouchPath)
      .filter(Boolean),
  ));
}

function escapeLike(value: string) {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function hasLaneFilesTouchedColumn() {
  const columns = getSqlite().prepare('PRAGMA table_info(lanes)').all() as Array<{ name: string }>;
  return columns.some((column) => column.name === 'files_touched');
}

function parseTouchedFiles(value: string | null): string[] {
  if (!value) return [];

  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed)) {
      return Array.from(new Set(
        parsed
          .filter((entry): entry is string => typeof entry === 'string')
          .map(normalizeTouchPath)
          .filter(Boolean),
      ));
    }
  } catch {
    // Fall through to delimiter parsing for legacy/plain text values.
  }

  return Array.from(new Set(
    value
      .split(/[\n,]/)
      .map(normalizeTouchPath)
      .filter(Boolean),
  ));
}

function timestampMs(...values: Array<string | null | undefined>) {
  for (const value of values) {
    if (!value) continue;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function repoFilterValues(repo: string) {
  const trimmed = repo.trim();
  if (!trimmed) return null;
  const repoName = trimmed.split('/').filter(Boolean).at(-1) ?? trimmed;
  return [trimmed, `%/${trimmed}`, `%/${repoName}`] as const;
}

function addRepoFilter(where: string[], params: unknown[], repo?: string | null) {
  const values = repo ? repoFilterValues(repo) : null;
  if (!values) return;
  where.push('(repo_path = ? OR repo_path LIKE ? OR repo_path LIKE ?)');
  params.push(...values);
}

function addActiveStatusFilter(where: string[], params: unknown[]) {
  const placeholders = ACTIVE_LANE_STATUSES.map(() => '?').join(', ');
  where.push(`status IN (${placeholders})`);
  params.push(...ACTIVE_LANE_STATUSES);
}

function rowToLaneTouch(row: LaneTouchRow, requestedPaths: string[]): LaneTouch {
  const parsedFiles = parseTouchedFiles(row.files_touched);
  const fallbackFiles = requestedPaths.filter((path) => row.files_touched?.includes(path));
  return {
    packetId: row.packet_id,
    laneId: row.id,
    status: row.status as LaneStatus,
    branch: row.branch,
    lastTouchedAt: timestampMs(row.last_event_at, row.updated_at),
    files: parsedFiles.length > 0 ? parsedFiles : fallbackFiles,
  };
}

export function findLanesTouching(
  path: string | string[],
  opts: FindLanesTouchingOptions = {},
): LaneTouch[] {
  const paths = normalizeTouchPaths(path);
  if (paths.length === 0 || !hasLaneFilesTouchedColumn()) {
    return [];
  }

  const where: string[] = [];
  const params: unknown[] = [];
  addActiveStatusFilter(where, params);
  where.push(`(${paths.map(() => "files_touched LIKE ? ESCAPE '\\'").join(' OR ')})`);
  params.push(...paths.map((entry) => `%${escapeLike(entry)}%`));
  addRepoFilter(where, params, opts.repo);
  if (opts.excludeLaneId) {
    where.push('id != ?');
    params.push(opts.excludeLaneId);
  }
  if (opts.excludePacketId) {
    where.push('(packet_id IS NULL OR packet_id != ?)');
    params.push(opts.excludePacketId);
  }

  const rows = getSqlite()
    .prepare(`
      SELECT
        id,
        repo_path,
        worktree_path,
        branch,
        base_branch,
        packet_id,
        status,
        updated_at,
        last_event_at,
        files_touched
      FROM lanes
      WHERE ${where.join(' AND ')}
      ORDER BY COALESCE(last_event_at, updated_at) DESC
    `)
    .all(...params) as LaneTouchRow[];

  return rows.map((row) => rowToLaneTouch(row, paths));
}

function findActiveLaneRowByPacket(packetId: string, repo?: string | null): LaneTouchRow | null {
  const filesTouchedSelect = hasLaneFilesTouchedColumn()
    ? 'files_touched'
    : 'NULL AS files_touched';
  const where: string[] = ['packet_id = ?'];
  const params: unknown[] = [packetId];
  addActiveStatusFilter(where, params);
  addRepoFilter(where, params, repo);

  const row = getSqlite()
    .prepare(`
      SELECT
        id,
        repo_path,
        worktree_path,
        branch,
        base_branch,
        packet_id,
        status,
        updated_at,
        last_event_at,
        ${filesTouchedSelect}
      FROM lanes
      WHERE ${where.join(' AND ')}
      ORDER BY updated_at DESC
      LIMIT 1
    `)
    .get(...params) as LaneTouchRow | undefined;

  return row ?? null;
}

function listDiffFilesForLane(row: LaneTouchRow): string[] {
  const cwd = row.worktree_path ?? row.repo_path;
  if (!cwd) {
    return parseTouchedFiles(row.files_touched);
  }

  try {
    const output = execFileSync('git', ['diff', '--name-only', `${row.base_branch}...HEAD`], {
      windowsHide: true,
      cwd,
      encoding: 'utf-8',
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
    return normalizeTouchPaths(output.split('\n'));
  } catch {
    return parseTouchedFiles(row.files_touched);
  }
}

export function findLanesTouchingPacketDiff(
  packetId: string,
  opts: Pick<FindLanesTouchingOptions, 'repo'> = {},
): PacketDiffLaneTouches | null {
  const packetLane = findActiveLaneRowByPacket(packetId, opts.repo);
  if (!packetLane) {
    return null;
  }

  const paths = listDiffFilesForLane(packetLane);
  return {
    packetId,
    laneId: packetLane.id,
    paths,
    lanes: paths.length > 0
      ? findLanesTouching(paths, {
        repo: opts.repo,
        excludeLaneId: packetLane.id,
        excludePacketId: packetId,
      })
      : [],
  };
}
