import { existsSync, writeFileSync } from 'node:fs';

import { runBoundedWorktreeMaintenance } from '@/lib/lane/bounded-worktree-maintenance';
import { closeDb } from '@/lib/db';
import { readMaintenanceState, readWorktreeMaintenanceStatus } from '@/lib/worktree/maintenance-discovery';

const [mode, repo, entered, release, receipt] = process.argv.slice(2);
if (!repo || !entered || !release || !receipt) throw new Error('Missing maintenance child input.');
async function main() {
try {
  if (mode === 'status' || mode === 'cursor') {
    writeFileSync(receipt!, JSON.stringify(mode === 'status'
      ? readWorktreeMaintenanceStatus() : readMaintenanceState('cursor:terminal')));
    return;
  }
  const result = await runBoundedWorktreeMaintenance(async () => {
    writeFileSync(entered, String(process.pid));
    if (mode === 'wait') {
      const deadline = Date.now() + 15_000;
      while (!existsSync(release)) {
        if (Date.now() > deadline) throw new Error('Maintenance test release did not arrive.');
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
  }, { primaryRepoPath: repo, maxCandidates: 1, admissionMilliseconds: 5_000 });
  writeFileSync(receipt, JSON.stringify({ pid: process.pid, result }));
} finally { closeDb(); }
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
