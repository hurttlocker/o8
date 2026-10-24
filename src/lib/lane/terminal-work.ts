const pending = new Set<Promise<void>>();

/** Retain terminal side effects so fixture owners can await quiescence. */
export function trackTerminalLaneWork(work: Promise<void>): void {
  pending.add(work);
  void work.then(() => pending.delete(work), () => pending.delete(work));
}

/** Call after stopping event sources; include work queued by an earlier task. */
export async function waitForTerminalLaneWork(): Promise<void> {
  while (pending.size > 0) {
    await Promise.all([...pending]);
  }
}
