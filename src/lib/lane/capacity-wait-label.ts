export const CAPACITY_WAIT_LABEL = 'waiting_for_limit_reset:';

export function capacityWaitMessage(resetsAt: string): string {
  return `Waiting for limit reset at ${resetsAt}`;
}

export function capacityWaitLabel(status: string | null | undefined, event: string | null | undefined): string | null {
  if (status !== 'paused' || !event?.startsWith(CAPACITY_WAIT_LABEL)) return null;
  const resetsAt = event.slice(CAPACITY_WAIT_LABEL.length);
  return Number.isFinite(Date.parse(resetsAt)) ? capacityWaitMessage(resetsAt) : null;
}
