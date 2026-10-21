import { createHash } from 'node:crypto';
import { readFile, readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';
import type { SharedCheckoutTeam } from './shared-checkout-team';

/** Read recorded membership, including finished teams; never claim checkout ownership. */
export async function readSharedTeamsForThread(repoPath: string, threadId: string, dataDir = getDataDir()): Promise<SharedCheckoutTeam[]> {
  const root = await realpath(repoPath);
  const id = createHash('sha256').update(root).digest('hex').slice(0, 24);
  const directory = join(dataDir, 'shared-checkout-teams');
  const archive = join(directory, 'archive');
  const names = await readdir(archive).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const files = [join(directory, `${id}.json`), ...names.filter(name => name.startsWith(`${id}-`) && name.endsWith('.json')).sort().map(name => join(archive, name))];
  const teams: SharedCheckoutTeam[] = [];
  for (const file of files) {
    try {
      const team = JSON.parse(await readFile(file, 'utf8')) as SharedCheckoutTeam;
      if (team.path === root && team.parentThreadId === threadId && Array.isArray(team.members)) teams.push(team);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return teams;
}
