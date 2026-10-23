import 'server-only';
import { readFileSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';
import { getAppUpdateState, recordAppUpdateInstall, recordAutoApply } from './relaunch-state';

/** Timeouts are not proof that an installer stopped. Only its task's Drop receipt is. */
export function recoverStoppedNativeTask(): void {
  const current = getAppUpdateState().autoApply;
  if (!current?.attemptId || !/^[0-9a-f-]{36}$/.test(current.attemptId)
    || !['installing', 'restarting', 'waiting'].includes(current.phase)) return;
  try {
    const path = join(getDataDir(), 'native-update-tasks', `${current.attemptId}.json`);
    const metadata = lstatSync(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) return;
    const receipt = JSON.parse(readFileSync(path, 'utf8'));
    if (receipt.attemptId !== current.attemptId || receipt.status !== 'stopped'
      || !Number.isSafeInteger(receipt.pid) || receipt.pid <= 0) return;
    const error = 'The native update task stopped. Installation can be retried manually.';
    recordAppUpdateInstall({ outcome: 'failed', version: current.version, error });
    recordAutoApply({ ...current, phase: 'failed', error });
  } catch { /* Missing or uncertain ownership stays held. */ }
}
