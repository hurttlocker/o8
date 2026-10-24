import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, expect, it } from 'vitest';

const data = mkdtempSync(join(tmpdir(), 'o8-thread-summary-'));
process.env.O8_DATA_DIR = data;
process.env.CORTEX_IDE_DATA_DIR = data;
const historyDir = join(data, 'chat-history');
mkdirSync(historyDir);
const { GET } = await import('@/app/api/mobile/orchestrator/threads/route');

afterAll(() => rmSync(data, { recursive: true, force: true }));

async function list(query = 'limit=500') {
  const response = await GET(new NextRequest(`http://localhost/api/mobile/orchestrator/threads?${query}`));
  expect(response.status).toBe(200);
  return response.json();
}

it('preserves discovery, filtering and stat invalidation when summaries exceed both cache limits', async () => {
  for (let index = 0; index < 300; index++) {
    writeFileSync(join(historyDir, `thoughts-summary-${index}.json`), JSON.stringify({
      title: `Summary ${index}`, backend: index % 2 ? 'codex' : 'claude', pinned: index % 2 === 0,
      repoName: `Repository ${index} ` + 'fixture'.repeat(2000),
      savedAt: '2026-10-01T01:00:00.000Z',
      remoteUrl: 'https://github.com/fixture/summary.git',
      messages: [
        { role: 'user', content: `Question ${index}`, timestamp: 1790812800000 },
        { role: 'assistant', content: `Answer ${index}`, timestamp: 1790812810000 },
      ],
    }));
  }
  const first = await list();
  expect(first.threads).toHaveLength(300);
  expect(await list()).toEqual(first);
  const claude = await list('backend=claude&limit=500');
  expect(claude.threads).toHaveLength(150);
  expect(claude.threads.every((thread: { pinned: boolean; status: string; messageCount: number }) => (
    thread.pinned && thread.status === 'ready' && thread.messageCount === 2
  ))).toBe(true);
  expect(first.threads[0]).toMatchObject({ githubOwner: 'fixture', githubRepo: 'summary' });

  const file = join(historyDir, 'thoughts-summary-0.json');
  const record = JSON.parse(readFileSync(file, 'utf8'));
  record.title = 'Updated after eviction';
  record.messages.push({ role: 'user', content: 'Next question', timestamp: 1790812820000 });
  writeFileSync(file, JSON.stringify(record));
  expect((await list()).threads[0]).toMatchObject({ id: 'thoughts-summary-0',
    title: 'Updated after eviction', status: 'busy', messageCount: 3 });
  record.archivedAt = '2026-10-01T02:00:00.000Z';
  writeFileSync(file, JSON.stringify(record));
  expect((await list()).threads).toHaveLength(299);
  expect((await list('archived=1')).archivedIds).toEqual(['thoughts-summary-0']);
  rmSync(join(historyDir, 'thoughts-summary-1.json'));
  expect((await list()).threads).toHaveLength(298);
});
