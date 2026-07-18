/**
 * `o8 packet commit -m "<message>"` — stage + commit the current packet
 * worktree with an explicit pathspec. Agents should use this instead of raw
 * `git add -A && git commit` so a stray index entry from a concurrent process
 * can't ride along (the shared-index race).
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CliError, EXIT } from '../../api.js';
import { printHumanKv, printJson, type OutputMode } from '../../output.js';
import { detectWorktree } from './worktree-resolve.js';
import { parsePacketArguments } from './target.js';

const execFileAsync = promisify(execFile);

export function parsePacketCommitMessage(rest: string[]): string | null {
  const args = parsePacketArguments(rest, {
    command: 'commit',
    valueFlags: ['message'],
    aliases: { '-m': '--message' },
    allowTarget: false,
  });
  return args.values.message?.trim() || null;
}

export async function runPacketCommit(mode: OutputMode, rest: string[]): Promise<number> {
  const message = parsePacketCommitMessage(rest);
  if (!message) {
    throw new CliError(
      'invalid_args',
      'o8 packet commit needs a message: -m "<message>".',
      EXIT.INVALID_ARGS,
      'Example: o8 packet commit -m "feat: add the thing"',
    );
  }

  const match = detectWorktree(process.cwd());
  if (!match) {
    throw new CliError(
      'not_in_packet_worktree',
      'Current directory is not inside an o8 packet worktree.',
      EXIT.NOT_FOUND,
      'Run from inside `.cortex-worktrees/packet-<id>`.',
    );
  }
  const cwd = match.worktreePath;

  try {
    // Stage everything under the worktree root, then commit with an explicit
    // `-- .` pathspec so only worktree-root paths are committed.
    await execFileAsync('git', ['add', '--', '.'], { cwd });
    const { stdout: status } = await execFileAsync('git', ['status', '--porcelain'], { cwd });
    if (!status.trim()) {
      if (mode.human) printHumanKv([['committed', 'no'], ['note', 'worktree clean — nothing to commit']]);
      else printJson({ schema: 'o8/cli/packet.commit/v1', committed: false, note: 'Nothing to commit (worktree clean).' });
      return 0;
    }

    await execFileAsync('git', ['commit', '-m', message, '--', '.'], { cwd });
    const { stdout: shaOut } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd });
    const sha = shaOut.trim();

    if (mode.human) printHumanKv([['committed', 'yes'], ['sha', sha.slice(0, 12)], ['message', message]]);
    else printJson({ schema: 'o8/cli/packet.commit/v1', committed: true, sha, message });
    return 0;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new CliError('commit_failed', `git commit failed: ${msg}`, EXIT.CONFLICT);
  }
}
