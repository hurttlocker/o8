import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, describe, expect, it, vi } from 'vitest';

const testRoot = mkdtempSync(join(tmpdir(), 'o8-handoff-compaction-'));
const dataDir = join(testRoot, 'data');
const repoPath = join(testRoot, 'repo');
const fakeCodex = join(testRoot, 'fake-codex.mjs');
const threadId = 'thoughts-handoff-compaction-real-path';

process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_CODEX_BIN = fakeCodex;
mkdirSync(join(dataDir, 'chat-history'), { recursive: true });
mkdirSync(repoPath, { recursive: true });
writeFileSync(fakeCodex, [
  '#!/usr/bin/env node',
  'console.log(JSON.stringify({',
  "  type: 'item.completed',",
  "  item: { type: 'agent_message', text: 'Decisions made\\n- Preserve the governed packet.\\nFiles touched\\n- src/example.ts\\nOpen questions\\n- None.\\nCurrent mission state\\n- Continue verification.' },",
  '}));',
].join('\n'));
chmodSync(fakeCodex, 0o755);

vi.mock('@/lib/panel/auth', () => ({ requirePanelAuth: () => null }));
vi.mock('@/lib/repos/repo-path-registry', () => ({
  resolveRepoPathFromRegistry: vi.fn(async () => ({ ok: true as const, repoRoot: repoPath })),
}));

const { autoCompactOrchestratorThread, ORCHESTRATOR_COMPACTION_PROVENANCE } = await import('./auto-compact');
const archiveRoute = await import('@/app/api/orchestrator/archive/route');

const messages = Array.from({ length: 8 }, (_, index) => ({
  id: `turn-${index}`,
  role: index % 2 === 0 ? 'user' : 'assistant',
  content: index % 2 === 0 ? `Operator objective ${index}` : `Verified result ${index}`,
  timestamp: 100 + index,
  ...(index % 2 === 1 ? { backend: 'codex', model: 'gpt-test' } : {}),
}));

writeFileSync(join(dataDir, 'chat-history', `${threadId}.json`), JSON.stringify({
  repoPath,
  messages,
}));

afterAll(() => {
  delete process.env.O8_CODEX_BIN;
});

describe('handoff compaction real path', () => {
  it('records who compacted and leaves the full narrative addressable', async () => {
    const result = await autoCompactOrchestratorThread({
      repoPath,
      threadId,
      keepTailCount: 2,
      trigger: 'handoff',
      force: true,
    });

    expect(result).toMatchObject({
      applied: true,
      compactedBy: ORCHESTRATOR_COMPACTION_PROVENANCE,
    });
    expect(result.archiveRef).toMatch(new RegExp(`^${threadId}-orch-compaction-\\d+\\.json$`));
    expect(result.transcript[0]).toMatchObject({
      type: 'compaction',
      compaction: {
        compactedBy: ORCHESTRATOR_COMPACTION_PROVENANCE,
        archiveRef: result.archiveRef,
      },
    });

    const archivePath = join(dataDir, 'orchestrator-archives', result.archiveRef!);
    const archive = JSON.parse(readFileSync(archivePath, 'utf8')) as Record<string, unknown>;
    expect(archive).toMatchObject({
      repoPath,
      tabId: threadId,
      compactedCount: 6,
      compactedBy: ORCHESTRATOR_COMPACTION_PROVENANCE,
    });
    expect(archive.turns).toHaveLength(6);

    const response = await archiveRoute.GET(new NextRequest(
      `http://localhost/api/orchestrator/archive?repoPath=${encodeURIComponent(repoPath)}&ref=${encodeURIComponent(result.archiveRef!)}`,
    ));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      archive: {
        ref: result.archiveRef,
        compactedBy: ORCHESTRATOR_COMPACTION_PROVENANCE,
      },
    });
  });
});
