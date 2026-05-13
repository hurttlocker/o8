import type { OutputMode } from '../../output.js';

export interface RuntimeDriftFields {
  laneId?: string | null;
  runtime?: string | null;
  actualRuntime?: string | null;
  worktreePath?: string | null;
}

export function warnRuntimeDriftIfNeeded(fields: RuntimeDriftFields, mode: OutputMode): void {
  const runtime = fields.runtime?.trim();
  const actualRuntime = fields.actualRuntime?.trim();
  if (!runtime || !actualRuntime || runtime === actualRuntime) return;

  const lane = fields.laneId ? ` lane ${fields.laneId}` : '';
  const worktree = fields.worktreePath ? ` in ${fields.worktreePath}` : '';
  const message = `runtime drift detected${lane}: declared ${runtime}, actual process is ${actualRuntime}${worktree}.`;

  if (mode.human) {
    process.stderr.write(`\nWARNING: ${message}\n`);
  } else {
    process.stderr.write(`warning: ${message}\n`);
  }
}
