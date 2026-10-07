import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import type { PiApproval } from './tools';

/**
 * Lane rules for a packet worker (#3258). Inside the packet's own lane worktree
 * Pi's writes and commands get no per-call inbox approval, like every other
 * worker; review and merge stay the gate. The host still applies the command
 * policy first, so a blocked command never reaches this. A call is allowed only
 * while the lane is open and still bound to `root`, the session's workspace.
 */
export function createPiLaneApproval(root: string, laneId: string): PiApproval {
  return async (call, signal) => {
    signal.throwIfAborted();
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
