import { rm } from 'node:fs/promises';
import { waitForTerminalLaneWork } from '../../src/lib/lane/terminal-work';

/** Dispose a smoke repository only after its terminal lifecycle work settles. */
export async function cleanupGovernanceSmokeRepo(root: string): Promise<void> {
  await waitForTerminalLaneWork();
  await rm(root, { recursive: true, force: true });
}
