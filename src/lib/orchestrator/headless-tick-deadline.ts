export const HEADLESS_TICK_DEADLINE_MS = 30_000;
export const HEADLESS_LAUNCH_DEADLINE_MS = 4 * 60_000;

interface HeadlessTickDeadlineOptions {
  canExtendForLaunch: () => boolean;
  onExtended?: (deadlineMs: number) => void;
}

/**
 * Bound a headless tick without treating expected launch provisioning as a
 * wedge. A launch can legitimately spend up to three minutes in the required
 * base typecheck, so a tick that created a fresh launching lane gets one
 * bounded extension. The work itself is intentionally not cancelled: callers
 * clear their singleton after this promise settles, matching the prior wedge
 * recovery behavior.
 */
export function applyHeadlessTickDeadline<T>(
  innerPromise: Promise<T>,
  options: HeadlessTickDeadlineOptions,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      timer = null;
      callback();
    };

    timer = setTimeout(() => {
      if (options.canExtendForLaunch()) {
        options.onExtended?.(HEADLESS_LAUNCH_DEADLINE_MS);
        timer = setTimeout(() => {
          finish(() => reject(new Error(
            `Headless launch tick exceeded ${HEADLESS_LAUNCH_DEADLINE_MS}ms deadline`,
          )));
        }, HEADLESS_LAUNCH_DEADLINE_MS - HEADLESS_TICK_DEADLINE_MS);
        return;
      }

      finish(() => reject(new Error(
        `Headless tick exceeded ${HEADLESS_TICK_DEADLINE_MS}ms deadline`,
      )));
    }, HEADLESS_TICK_DEADLINE_MS);

    void innerPromise.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}
