import { findTaskDraft } from '../../src/lib/mcp/task-draft-store';
import { readTaskExecution, reserveTaskExecution, withTaskExecutionLock } from '../../src/lib/mcp/task-execution-store';
import { holdAccountRefresh, withAccountStateLease } from '../../src/lib/auth/account-state';
import Database from 'better-sqlite3';
import { join } from 'node:path';
import { getDataDir } from '../../src/lib/data-dir-migration';

async function main() {
  const draft = findTaskDraft(process.argv[3]!, process.argv[4]!);
  if (process.argv[2] === 'database-write-lock') {
    const db = new Database(join(getDataDir(), 'account-state.sqlite'));
    db.pragma('busy_timeout = 5000');
    db.exec('BEGIN IMMEDIATE');
    process.stdout.write('database-locked');
    setTimeout(() => { db.exec('ROLLBACK'); db.close(); }, 6500);
    return;
  }
  if (process.argv[2] === 'account-write') {
    try { await withAccountStateLease(holdAccountRefresh); process.stdout.write('{"acquired":true}'); }
    catch { process.stdout.write('{"blocked":true}'); }
    return;
  }
  if (process.argv[2] === 'lock') {
    await withTaskExecutionLock(draft.taskId, () => new Promise<void>(() => {
      process.stdout.write('locked'); setInterval(() => {}, 1000);
    }));
    return;
  }
  const result = process.argv[2] === 'reserve' ? await reserveTaskExecution(draft) : readTaskExecution(draft);
  process.stdout.write(JSON.stringify(result));
}
void main().catch(() => { process.exitCode = 1; });
