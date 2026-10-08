import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import type { PiApproval, PiAuthority } from './tools';

/**
 * Lane authority for a packet worker (#3258): a write or command is allowed
 * only while the lane is open and still bound to `root`, the session's
 * workspace, and a write path must resolve inside it. The host checks this
 * inside the host-wide lock immediately before every effect, whatever the
 * approval policy said, so a call approved or queued earlier cannot outlive
 * the lane.
 */
export function createPiLaneAuthority(root: string, laneId: string): PiAuthority {
  return async (call) => {
    if (call.name !== 'write_file' && call.name !== 'run_command') return false;
    const [{ getLane }, { isLaneTerminal }] = await Promise.all([
      import('@/lib/lane/registry'),
      import('@/lib/lane/terminal-states'),
    ]);
    const lane = getLane(laneId);
    if (!lane?.worktreePath || isLaneTerminal(lane.status)) return false;
    if (await realpath(lane.worktreePath).catch(() => null) !== root) return false;
    if (call.name === 'write_file') {
      const path = call.args.path;
      if (typeof path !== 'string' || !path || isAbsolute(path)) return false;
      const rel = relative(root, resolve(root, path));
      if (!rel || rel.startsWith('..') || isAbsolute(rel)) return false;
    }
    return true;
  };
}

/**
 * Lane rules for a packet worker. Inside the packet's own lane worktree Pi's
 * writes and commands get no per-call inbox approval, like every other worker;
 * review and merge stay the gate. The host applies the command policy first, so
 * a blocked command never reaches this, and the lane authority is checked again
 * before the effect.
 */
export function createPiLaneApproval(root: string, laneId: string): PiApproval {
  const authorize = createPiLaneAuthority(root, laneId);
  return async (call, signal) => {
    signal.throwIfAborted();
    return authorize(call);
  };
}
