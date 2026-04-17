import { getSqlite } from '@/lib/db';

interface WorkerRunRow {
  id: string;
  remote_branch: string | null;
  status: string;
}

export function fetchWorkerRun(laneId: string): { id: string; remoteBranch: string | null; status: string } | null {
  const row = getSqlite()
    .prepare(`
      SELECT id, remote_branch, status
      FROM worker_runs
      WHERE lane_id = ?
      ORDER BY started_at DESC
      LIMIT 1
    `)
    .get(laneId) as WorkerRunRow | undefined;

  if (!row) {
    return null;
  }

  return {
    id: row.id,
    remoteBranch: row.remote_branch,
    status: row.status,
  };
}
