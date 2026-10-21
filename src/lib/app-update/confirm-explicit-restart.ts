'use client';

import { requestConfirm } from '@/components/shared/ConfirmToastHost';
import { describeUpdateBlockers, type UpdateIdleResponse } from './update-card-view';

/** Only an operator's explicit restart may ask to interrupt work. */
export async function confirmExplicitRestart(payload: UpdateIdleResponse | null): Promise<boolean> {
  const idle = payload?.idle;
  // Consent to interrupt a task never overrides installer ownership or another restart.
  if (idle?.active?.cliInstallers?.length || idle?.active?.restartPending
    || idle?.unavailable?.includes('cli-update-ownership')) return false;
  if (idle?.idle === true || idle?.idleExceptParked === true) return true;

  const { live } = describeUpdateBlockers(payload);
  return requestConfirm({
    title: 'Restart o8 while work may be running?',
    message: live.length
      ? `${live.join('\n')}\n\nRestarting may interrupt this work. Waiting tasks keep their saved state.`
      : 'o8 could not verify running work. Restarting may interrupt active work.',
    confirmLabel: 'Restart anyway', cancelLabel: 'Keep waiting', danger: true,
  });
}
