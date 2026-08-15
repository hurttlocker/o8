import { withPacketLifecycleMutationLock } from './lifecycle-mutation-lock';

const STORAGE_PRESSURE_POLICY_LOCK_ID = 'system:storage-pressure-policy';

/**
 * Keep repository eligibility, the global pressure mode, and the destructive
 * park decision in one cross-process ordering domain.
 */
export function withStoragePressurePolicyLock<T>(operation: () => Promise<T>): Promise<T> {
  return withPacketLifecycleMutationLock(
    STORAGE_PRESSURE_POLICY_LOCK_ID,
    () => operation(),
  );
}
