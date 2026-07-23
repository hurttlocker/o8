import type Database from 'better-sqlite3';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import type { Lane, LaneEvent, LaneStoreState } from './types';
import { getDataDir } from '@/lib/data-dir-migration';

const LEGACY_STORE_PATH = path.join(getDataDir(), 'lanes.json');

function nowIso() {
  return new Date().toISOString();
}

function loadLegacyLaneStore(): LaneStoreState | null {
  try {
    if (!existsSync(LEGACY_STORE_PATH)) {
      return null;
    }

    const raw = readFileSync(LEGACY_STORE_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<LaneStoreState> | null;
    if (!parsed || parsed.version !== 1) {
      console.warn('[lane-registry] Legacy lanes.json has an unsupported version; skipping migration');
      return null;
    }

    return {
      version: 1,
      lanes: (parsed.lanes ?? {}) as Record<string, Lane>,
      events: (parsed.events ?? []) as LaneEvent[],
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : nowIso(),
    };
  } catch (error) {
    console.error('[lane-registry] Failed to read legacy lanes.json:', error);
    return null;
  }
}

function countRows(sqlite: Database.Database, tableName: string): number {
  const row = sqlite.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get() as { count: number } | undefined;
  return row?.count ?? 0;
}

export function migrateLegacyLaneStoreIfNeeded(
  sqlite: Database.Database,
  options: { lanesTablePreviouslyMissing: boolean },
): void {
  if (!existsSync(LEGACY_STORE_PATH)) {
    return;
  }

  const laneCount = countRows(sqlite, 'lanes');
  const laneEventCount = countRows(sqlite, 'lane_events');
  const shouldImport = options.lanesTablePreviouslyMissing || (laneCount === 0 && laneEventCount === 0);

  if (!shouldImport) {
    console.warn('[lane-registry] Legacy lanes.json still exists, but SQLite lane tables already contain data; leaving the file in place');
    return;
  }

  const legacy = loadLegacyLaneStore();
  if (!legacy) {
    return;
  }

  const laneRecords = Object.values(legacy.lanes ?? {});
  const knownLaneIds = new Set(laneRecords.map((lane) => lane.id));
  const laneEventRecords = (legacy.events ?? []).filter((event) => knownLaneIds.has(event.laneId));

  const insertLane = sqlite.prepare(`
    INSERT INTO lanes (
      id,
      label,
      repo_path,
      worktree_path,
      branch,
      base_branch,
      runtime,
      session_key,
      packet_id,
      status,
      ownership,
      writer_token,
      created_at,
      updated_at,
      last_event_at,
      last_event_label
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertLaneEvent = sqlite.prepare(`
    INSERT INTO lane_events (
      id,
      lane_id,
      verb,
      actor,
      payload_json,
      timestamp
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);

  const transaction = sqlite.transaction(() => {
    for (const lane of laneRecords) {
      insertLane.run(
        lane.id,
        lane.label,
        lane.repoPath,
        lane.worktreePath,
        lane.branch,
        lane.baseBranch,
        lane.runtime,
        lane.sessionKey,
        lane.packetId,
        lane.status,
        lane.ownership,
        lane.writerToken,
        lane.createdAt,
        lane.updatedAt,
        lane.lastEventAt,
        lane.lastEventLabel,
      );
    }

    for (const event of laneEventRecords) {
      insertLaneEvent.run(
        event.id,
        event.laneId,
        event.verb,
        event.actor,
        JSON.stringify(event.payload ?? {}),
        event.timestamp,
      );
    }
  });

  transaction();

  try {
    unlinkSync(LEGACY_STORE_PATH);
  } catch (error) {
    console.error('[lane-registry] Imported legacy lanes.json but failed to delete it:', error);
    return;
  }

  console.log(`[lane-registry] Migrated ${laneRecords.length} lanes and ${laneEventRecords.length} events from legacy lanes.json`);
}
