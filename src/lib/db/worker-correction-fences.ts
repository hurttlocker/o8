import { getSqlite } from '@/lib/db';

export function correctionStopVersion(scope: string): number {
  return (getSqlite().prepare('SELECT generation FROM worker_correction_fences WHERE scope = ?').get(scope) as { generation: number } | undefined)?.generation ?? 0;
}
export function advanceCorrectionStop(scope: string): void {
  getSqlite().prepare(`INSERT INTO worker_correction_fences VALUES (?, 1)
    ON CONFLICT(scope) DO UPDATE SET generation = generation + 1`).run(scope);
}
