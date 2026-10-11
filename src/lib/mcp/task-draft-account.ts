import { accountStateMatches, readAccountState, requireAccountGeneration, withAccountStateAdmission } from '@/lib/auth/account-state';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { PluginPrincipal } from '@/lib/auth/plugin-token';
import { getDataDir } from '@/lib/data-dir-migration';
import { readCachedEntitlement, verifyLicense } from '@/lib/entitlement/license';
import { readActiveIdentity, readSignInEpoch } from '@/lib/github-broker/managed';
import { TaskDraftError } from './task-draft-contract';

export interface TaskDraftAccount { accountId: string; epoch: string }
type AccountAdmission = Pick<PluginPrincipal, 'accountId' | 'expiresAt'>;

function sameIdentity(principal: AccountAdmission, expected?: TaskDraftAccount): TaskDraftAccount {
  const epoch = readSignInEpoch();
  const accountId = principal.accountId;
  // Any persisted sign-out marker holds drafts, including old/unreadable markers.
  if (!accountId || !epoch || readActiveIdentity() !== accountId
    || existsSync(join(getDataDir(), 'auth-signed-out-at')) || principal.expiresAt <= Date.now()
    || (expected && (expected.accountId !== accountId || expected.epoch !== epoch))) {
    throw new TaskDraftError('account_changed_or_unavailable', 403);
  }
  return { accountId, epoch };
}

/** Hold the installation lease through verification and the awaited reserve/spawn operation. */
export async function withTaskDraftAccountAdmission<T>(principal: AccountAdmission, expected: TaskDraftAccount | undefined,
  action: (account: TaskDraftAccount) => Promise<T> | T): Promise<T> {
  try {
    return await withAccountStateAdmission(async () => {
      const state = readAccountState();
      if (!state || !accountStateMatches(state)) throw new TaskDraftError('account_changed_or_unavailable', 403);
      const captured = sameIdentity(principal, expected);
      const token = readCachedEntitlement()?.licenseKey;
      if (!token) throw new TaskDraftError('account_changed_or_unavailable', 403);
      const verified = await verifyLicense(token, { offlineGrace: false });
      sameIdentity(principal, captured);
      requireAccountGeneration(state.generation);
      if (!verified.valid || verified.subject !== captured.accountId || readCachedEntitlement()?.licenseKey !== token) {
        throw new TaskDraftError('account_changed_or_unavailable', 403);
      }
      const result = await action(captured);
      requireAccountGeneration(state.generation);
      return result;
    });
  } catch (error) {
    if (error instanceof TaskDraftError) throw error;
    throw new TaskDraftError('account_changed_or_unavailable', 403);
  }
}

/** No offline grace or decoded client identity can admit a task draft. */
export function requireTaskDraftAccount(principal: AccountAdmission, expected?: TaskDraftAccount): Promise<TaskDraftAccount> {
  return withTaskDraftAccountAdmission(principal, expected, (account) => account);
}
