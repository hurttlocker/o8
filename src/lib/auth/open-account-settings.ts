/**
 * Open Clerk's account settings. SDK failures, synchronous or async, are
 * reported with fixed text so their messages never reach console capture.
 */
export function openAccountSettings(clerk: { openUserProfile: () => unknown }): void {
  const failed = () => console.error('[auth] failed to open account settings');
  try {
    const result = clerk.openUserProfile();
    if (result instanceof Promise) result.catch(failed);
  } catch {
    failed();
  }
}
