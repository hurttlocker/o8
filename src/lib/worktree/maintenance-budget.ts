import { AsyncLocalStorage } from 'node:async_hooks';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';

export const WORKTREE_MAINTENANCE_POLICY = {
  candidates: 20,
  metadataBytes: 16 * 1024 * 1024,
  rootBytes: 256 * 1024,
  rootEntries: 256,
  admissionMilliseconds: 3_000,
} as const;

export interface WorktreeMaintenanceBudget {
  remainingBytes: number;
  readBytes: number;
  rootBytes: number;
  rootEntries: number;
}

const context = new AsyncLocalStorage<WorktreeMaintenanceBudget>();

/** A policy hold is a refusal, never an empty inventory or deletion capability. */
export class WorktreeMaintenanceHeldError extends Error {
  constructor(readonly scope: string, readonly reason: string) {
    super(`Automatic worktree maintenance held ${scope}: ${reason}`);
    this.name = 'WorktreeMaintenanceHeldError';
  }
}

export function withWorktreeMaintenanceBudget<T>(
  budget: WorktreeMaintenanceBudget,
  operation: () => Promise<T>,
): Promise<T> {
  return context.run(budget, operation);
}

export function worktreeMetadataReadLimit(): number | undefined {
  const budget = context.getStore();
  return budget ? Math.min(budget.rootBytes, budget.remainingBytes) : undefined;
}

export function chargeWorktreeMetadataRead(scope: string, bytes: number): void {
  const budget = context.getStore();
  if (!budget) return;
  if (bytes > budget.rootBytes) {
    throw new WorktreeMaintenanceHeldError(scope, `metadata exceeds ${budget.rootBytes} bytes`);
  }
  if (bytes > budget.remainingBytes) {
    throw new WorktreeMaintenanceHeldError(scope, 'pass metadata byte budget exhausted');
  }
  budget.remainingBytes -= bytes;
  budget.readBytes += bytes;
}

export function assertWorktreeMetadataEntryBudget(scope: string, entries: number): void {
  const budget = context.getStore();
  if (budget && entries > budget.rootEntries) {
    throw new WorktreeMaintenanceHeldError(scope, `metadata exceeds ${budget.rootEntries} entries`);
  }
}

/** Read a regular, stable descriptor before parsing; special files cannot block a pass. */
export async function readBoundedMaintenanceFile(scope: string): Promise<{ text: string; revision: string } | null> {
  const limit = worktreeMetadataReadLimit();
  if (limit === undefined) throw new Error('A maintenance read budget is required.');
  let handle;
  try { handle = await open(scope, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > limit) {
      throw new WorktreeMaintenanceHeldError(scope, 'metadata exceeds the bounded regular-file read allowance');
    }
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!read.bytesRead) throw new WorktreeMaintenanceHeldError(scope, 'metadata changed during the read');
      offset += read.bytesRead;
    }
    const after = await handle.stat();
    const named = await lstat(scope);
    if (!named.isFile() || [after, named].some((stat) => stat.dev !== before.dev || stat.ino !== before.ino
      || stat.size !== before.size || stat.mtimeMs !== before.mtimeMs || stat.ctimeMs !== before.ctimeMs)) {
      throw new WorktreeMaintenanceHeldError(scope, 'metadata changed during the read');
    }
    chargeWorktreeMetadataRead(scope, bytes.length);
    return { text: bytes.toString('utf8'), revision: `${before.dev}:${before.ino}:${before.size}:${before.mtimeMs}:${before.ctimeMs}` };
  } finally { await handle.close(); }
}
