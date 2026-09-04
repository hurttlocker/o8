export function runSoak(
  page: unknown,
  stack: { wsPort: number },
  browserPid: number | null,
  soakMs: number,
): Promise<Record<string, unknown>>;

export function stableSoakGroups(
  processes: Map<number, { pid: number; ppid: number; command: string }>,
  groups: Record<string, number[]>,
  stack: { nextPid: number; wsPid: number },
): Record<string, number[]>;
