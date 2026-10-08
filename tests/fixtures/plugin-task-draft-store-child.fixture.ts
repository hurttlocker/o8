import { readFileSync } from 'node:fs';
import { readTaskDraft, withTaskDraftLock, writeTaskDraft, type TaskDraftRecord } from '../../src/lib/mcp/task-draft-store';

async function main() {
  const [action, key, input] = process.argv.slice(2);
  if (!key || !/^[a-f0-9]{64}$/.test(key)) throw new Error('Invalid fixture key');
  if (action === 'read') {
    process.stdout.write(JSON.stringify({ taskId: readTaskDraft(key)?.taskId }));
    return;
  }
  if (action !== 'bind' || !input) throw new Error('Invalid fixture action');
  const record = JSON.parse(readFileSync(input, 'utf8')) as TaskDraftRecord;
  const receipt = await withTaskDraftLock(key, async () => {
    const previous = readTaskDraft(key);
    if (previous) return { created: false, taskId: previous.taskId };
    await new Promise((resolve) => setTimeout(resolve, 80));
    writeTaskDraft(key, record);
    return { created: true, taskId: record.taskId };
  });
  process.stdout.write(JSON.stringify(receipt));
}
main().catch(() => { process.exitCode = 1; });
