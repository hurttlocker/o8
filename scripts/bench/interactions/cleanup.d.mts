export interface ProcessEntry {
  pid: number;
  ppid: number;
  pgid: number;
  command: string;
}

export interface OwnedProcessSummary {
  pid: number;
  ppid: number;
  pgid: number;
  label: string;
}

export interface OwnedProcessInventory {
  runTag: string;
  harnessPid: number;
  roots: Map<number, string>;
  processes: Map<number, ProcessEntry & { label: string }>;
  safeProcessGroups: Set<number>;
  captures: number;
  snapshotErrors: string[];
}

export interface ProcessTerminationReceipt {
  runTag: string;
  captures: number;
  roots: Array<{ pid: number; label: string }>;
  inventoriedCount: number;
  inventoriedByLabel: Record<string, number>;
  githubCliCommandShapes: Record<string, number>;
  initial: OwnedProcessSummary[];
  signaledTerm: number[];
  signaledKill: number[];
  survivors: OwnedProcessSummary[];
  snapshotErrors: string[];
}

export interface CleanupReceipt {
  status: 'clean' | 'residue';
  checked: Record<string, unknown>;
  residue: Record<string, unknown> | null;
}

export function parseProcessInventory(output: string): Map<number, ProcessEntry>;
export function snapshotProcessInventory(run?: (
  file: string,
  args: string[],
  options: { encoding: string; maxBuffer: number },
) => string): Map<number, ProcessEntry>;
export function createOwnedProcessInventory(runTag: string, options?: { harnessPid?: number }): OwnedProcessInventory;
export function addOwnedProcessRoot(
  inventory: OwnedProcessInventory,
  pid: number,
  label: string,
  processes?: Map<number, ProcessEntry>,
): void;
export function captureOwnedProcessTree(
  inventory: OwnedProcessInventory,
  processes?: Map<number, ProcessEntry>,
): OwnedProcessInventory;
export function captureOwnedProcessTreeSafe(
  inventory: OwnedProcessInventory,
  processes?: Map<number, ProcessEntry>,
): boolean;
export function survivingOwnedProcesses(
  inventory: OwnedProcessInventory,
  processes?: Map<number, ProcessEntry>,
): OwnedProcessSummary[];
export function terminateAndWaitOwnedProcesses(inventory: OwnedProcessInventory, options?: {
  graceMs?: number;
  termMs?: number;
  killMs?: number;
  snapshot?: () => Map<number, ProcessEntry>;
  sleep?: (ms: number) => Promise<void>;
  kill?: (pid: number, signal: NodeJS.Signals | number) => unknown;
}): Promise<ProcessTerminationReceipt>;
export function portFree(port: number): Promise<boolean>;
export function listTmuxSessions(): string[];
export function listWorktrees(repoDir: string | null): string[];
export function ownedTmuxSessions(dataDir: string | null): string[];
export function killTmuxSessions(sessionNames: string[]): string[];
export function verifyCleanup(input: {
  processTermination?: ProcessTerminationReceipt | { survivors: OwnedProcessSummary[] } | null;
  ownedInventory?: OwnedProcessInventory | null;
  ports?: number[];
  dataDir?: string | null;
  repoDir?: string | null;
  tmuxSessionsBefore?: string[];
  worktreesBefore?: string[];
  worktreesAfter?: string[] | null;
}): Promise<CleanupReceipt>;
