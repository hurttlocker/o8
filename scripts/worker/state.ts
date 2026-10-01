import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

interface WorkerState { workerId: string; cursor: number; }

const STATE_FILE = 'worker-state.json';

function validState(value: unknown): value is WorkerState {
  return Boolean(value)
    && typeof value === 'object'
    && typeof (value as WorkerState).workerId === 'string'
    && Number.isInteger((value as WorkerState).cursor)
    && (value as WorkerState).cursor >= 0;
}

export class PersistentWorkerState {
  private constructor(private readonly filePath: string, private state: WorkerState) {}

  static async load(workspaceDir: string, requestedWorkerId?: string): Promise<PersistentWorkerState> {
    const filePath = path.join(workspaceDir, STATE_FILE);
    await mkdir(workspaceDir, { recursive: true, mode: 0o700 });
    let loaded: WorkerState | null = null;
    try {
      const parsed = JSON.parse(await readFile(filePath, 'utf-8')) as unknown;
      if (validState(parsed)) loaded = parsed;
    } catch { /* First start and corrupt state both create a new local state. */ }
    const state = { workerId: requestedWorkerId ?? loaded?.workerId ?? randomUUID(), cursor: loaded?.cursor ?? 0 };
    const persistent = new PersistentWorkerState(filePath, state);
    await persistent.save();
    return persistent;
  }

  get workerId() { return this.state.workerId; }
  get cursor() { return this.state.cursor; }

  async advanceCursor(cursor: number): Promise<void> {
    if (!Number.isInteger(cursor) || cursor < this.state.cursor) return;
    this.state = { ...this.state, cursor };
    await this.save();
  }

  private async save(): Promise<void> {
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(this.state)}\n`, { encoding: 'utf-8', mode: 0o600 });
    await rename(temporary, this.filePath);
  }
}
