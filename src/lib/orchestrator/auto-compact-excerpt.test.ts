import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const testRoot = mkdtempSync(join(os.tmpdir(), 'o8-auto-compact-excerpt-'));
const dataDir = join(testRoot, 'data');
const repoPath = join(testRoot, 'repo');
const fakeCodex = join(testRoot, 'fake-codex.mjs');
const promptCapture = join(testRoot, 'summarizer-prompt.txt');

process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_CODEX_BIN = fakeCodex;
mkdirSync(join(dataDir, 'chat-history'), { recursive: true });
mkdirSync(repoPath, { recursive: true });
// The summarizer gets its prompt as the last argv entry on POSIX.
writeFileSync(fakeCodex, [
  '#!/usr/bin/env node',
  "import { writeFileSync } from 'node:fs';",
  `writeFileSync(${JSON.stringify(promptCapture)}, process.argv[process.argv.length - 1]);`,
  "console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Decisions made\\n- None.\\nFiles touched\\n- None.\\nOpen questions\\n- None.\\nCurrent mission state\\n- Continue.' } }));",
].join('\n'));
chmodSync(fakeCodex, 0o755);

function writeThread(threadId: string, texts: string[]) {
  writeFileSync(join(dataDir, 'chat-history', `${threadId}.json`), JSON.stringify({
    repoPath,
    messages: texts.map((content, index) => ({
      id: `${threadId}-${index}`,
      role: index % 2 === 0 ? 'user' : 'assistant',
      content,
      timestamp: index + 1,
    })),
  }));
}

/** An orchestrator reply: progress first, the result in its last paragraph. */
function longReply(opening: string, conclusion: string) {
  const progress = Array.from({ length: 60 }, (_, index) => `Progress line ${index}: still checking.`).join('\n');
  return `${opening}\n${progress}\n\n${conclusion}`;
}

const { autoCompactOrchestratorThread } = await import('./auto-compact');

afterAll(() => {
  delete process.env.O8_CODEX_BIN;
  rmSync(testRoot, { recursive: true, force: true });
});

describe('auto compaction excerpt', () => {
  it('keeps the final paragraph of long turns in the resume prelude and the summarizer input (#2958)', async () => {
    const threadId = 'thoughts-excerpt-tail';
    writeThread(threadId, [
      'Migrate the ledger.',
      longReply('Starting the migration.', 'Compacted conclusion: the ledger migration passed.'),
      'Now check CI.',
      longReply('Starting the CI check.', 'Retained conclusion: CI passed on all three runners.'),
    ]);

    const result = await autoCompactOrchestratorThread({
      repoPath, threadId, keepTailCount: 2, trigger: 'manual', force: true,
    });

    expect(result.applied).toBe(true);
    expect(result.resumePrelude).toContain('Starting the CI check.');
    expect(result.resumePrelude).toContain('Retained conclusion: CI passed on all three runners.');
    const summarizerInput = readFileSync(promptCapture, 'utf8');
    expect(summarizerInput).toContain('Starting the migration.');
    expect(summarizerInput).toContain('Compacted conclusion: the ledger migration passed.');
  });

  it('drops the oldest retained turns first when the prelude is over budget (#2958)', async () => {
    const threadId = 'thoughts-excerpt-budget';
    const marker = (index: number) => `turn-marker-${String(index).padStart(3, '0')}`;
    // 120 retained turns of about 1,300 characters each is well past the 80,000-character prelude budget.
    const retained = Array.from({ length: 120 }, (_, index) => `${marker(index)} ${'x'.repeat(1_280)}`);
    writeThread(threadId, ['Compacted opener.', 'Compacted reply.', ...retained]);

    const result = await autoCompactOrchestratorThread({
      repoPath, threadId, keepTailCount: retained.length, trigger: 'manual', force: true,
    });

    expect(result.applied).toBe(true);
    const prelude = result.resumePrelude ?? '';
    const excerpt = prelude.slice(prelude.indexOf('Most recent uncompressed turns:'));
    expect(excerpt).toContain(marker(119));
    expect(excerpt).not.toContain(marker(0));
    const kept = retained.map((_, index) => excerpt.includes(marker(index)));
    const firstKept = kept.indexOf(true);
    // One contiguous run that ends at the newest turn.
    expect(kept.slice(firstKept).every(Boolean)).toBe(true);
    expect(excerpt.length).toBeLessThan(82_000);
  });

  it('keeps an earlier compaction summary and the newest turns in an over-budget summarizer input (#2958)', async () => {
    const threadId = 'thoughts-excerpt-summary';
    const marker = (index: number) => `compacted-marker-${String(index).padStart(3, '0')}`;
    // 120 compacted turns of about 1,300 characters each is well past the 90,000-character summarizer budget.
    const compacted = Array.from({ length: 120 }, (_, index) => ({
      id: `${threadId}-${index}`,
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `${marker(index)} ${'x'.repeat(1_280)}`,
      timestamp: index + 2,
    }));
    writeFileSync(join(dataDir, 'chat-history', `${threadId}.json`), JSON.stringify({
      repoPath,
      messages: [
        {
          id: `${threadId}-earlier-compaction`,
          role: 'system',
          type: 'compaction',
          content: 'Context compaction event',
          timestamp: 1,
          compaction: { summary: '<compacted_context turns="40">\nEarlier summary: the schema moved to v3.\n</compacted_context>' },
        },
        ...compacted,
        { id: `${threadId}-live-user`, role: 'user', content: 'Live question.', timestamp: 200 },
        { id: `${threadId}-live-reply`, role: 'assistant', content: 'Live answer.', timestamp: 201 },
      ],
    }));

    const result = await autoCompactOrchestratorThread({
      repoPath, threadId, keepTailCount: 2, trigger: 'manual', force: true,
    });

    expect(result.applied).toBe(true);
    const summarizerInput = readFileSync(promptCapture, 'utf8');
    expect(summarizerInput).toContain('Earlier summary: the schema moved to v3.');
    expect(summarizerInput).toContain(marker(119));
    expect(summarizerInput).not.toContain(marker(0));
  });
});
