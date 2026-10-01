import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const testRoot = mkdtempSync(join(tmpdir(), 'o8-compact-thread-isolation-'));
const dataDir = join(testRoot, 'data');
const historyDir = join(dataDir, 'chat-history');
const archiveDir = join(dataDir, 'orchestrator-archives');
const repoPath = join(testRoot, 'repo');
const fakeCodex = join(testRoot, 'fake-codex.mjs');

process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_CODEX_BIN = fakeCodex;
mkdirSync(historyDir, { recursive: true });
mkdirSync(repoPath, { recursive: true });
writeFileSync(fakeCodex, [
  '#!/usr/bin/env node',
  "const prompt = process.argv.join(' ');",
  "const marker = prompt.includes('ALPHA_ONLY') ? 'ALPHA_ONLY' : prompt.includes('BETA_ONLY') ? 'BETA_ONLY' : prompt.includes('FRESH_ONLY') ? 'FRESH_ONLY' : 'UNKNOWN';",
  "console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 20 } }));",
  "console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: `Decisions made\\n- ${marker}\\nFiles touched\\n- None.\\nOpen questions\\n- None.\\nCurrent mission state\\n- Continue.` } }));",
].join('\n'));
chmodSync(fakeCodex, 0o755);

vi.mock('@/lib/panel/auth', () => ({ requirePanelAuth: () => null }));
vi.mock('@/lib/repos/repo-path-registry', () => ({
  resolveRepoPathFromRegistry: vi.fn(async () => ({ ok: true as const, repoRoot: repoPath })),
}));
vi.mock('@/lib/operator/defaults', () => ({
  resolveInAppOrchestratorEnabledSync: () => true,
}));

const { POST } = await import('./route');

function entries(prefix: string) {
  return Array.from({ length: 6 }, (_, index) => ({
    id: `${prefix}-${index}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `${prefix.toUpperCase()}_ONLY message ${index}`,
    timestamp: index + 1,
  }));
}

function persist(threadId: string, prefix: string) {
  writeFileSync(join(historyDir, `${threadId}.json`), JSON.stringify({
    repoPath,
    messages: entries(prefix),
  }));
}

function request(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/orchestrator/compact', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function compact(threadId: string, messages?: ReturnType<typeof entries>) {
  const response = await POST(request({
    repoPath,
    threadId,
    runningTotal: 151_000,
    keepTailCount: 2,
    trigger: 'manual',
    ...(messages ? { messages } : {}),
  }));
  return { response, payload: await response.json() as Record<string, unknown> };
}

beforeEach(() => {
  rmSync(archiveDir, { recursive: true, force: true });
  persist('thoughts-old', 'old');
  persist('thoughts-fresh', 'fresh');
  persist('thoughts-alpha', 'alpha');
  persist('thoughts-beta', 'beta');
});

afterAll(() => {
  delete process.env.O8_CODEX_BIN;
  rmSync(testRoot, { recursive: true, force: true });
});

describe('orchestrator compaction thread isolation through the HTTP boundary', () => {
  it('compacts the requested fresh thread without importing the newer same-repo thread', async () => {
    const oldBefore = readFileSync(join(historyDir, 'thoughts-old.json'), 'utf8');

    const { response, payload } = await compact('thoughts-fresh', entries('old'));

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({ ok: true, applied: true });
    expect(String(payload.resumePrelude)).toContain('FRESH_ONLY');
    expect(String(payload.resumePrelude)).not.toContain('OLD_ONLY');
    expect(readFileSync(join(historyDir, 'thoughts-old.json'), 'utf8')).toBe(oldBefore);

    const archiveRef = String(payload.archiveRef);
    expect(archiveRef).toMatch(/^thoughts-fresh-orch-compaction-\d+\.json$/);
    const archive = JSON.parse(readFileSync(join(archiveDir, archiveRef), 'utf8')) as {
      tabId: string;
      turns: Array<{ id: string }>;
    };
    expect(archive.tabId).toBe('thoughts-fresh');
    expect(archive.turns.every((turn) => turn.id.startsWith('fresh-'))).toBe(true);
  });

  it('keeps concurrent same-repo compactions and their model prompts disjoint', async () => {
    const [alpha, beta] = await Promise.all([
      compact('thoughts-alpha'),
      compact('thoughts-beta'),
    ]);

    expect(alpha.response.status).toBe(200);
    expect(beta.response.status).toBe(200);
    expect(String(alpha.payload.resumePrelude)).toContain('ALPHA_ONLY');
    expect(String(alpha.payload.resumePrelude)).not.toContain('BETA_ONLY');
    expect(String(beta.payload.resumePrelude)).toContain('BETA_ONLY');
    expect(String(beta.payload.resumePrelude)).not.toContain('ALPHA_ONLY');

    for (const [threadId, payload] of [
      ['thoughts-alpha', alpha.payload],
      ['thoughts-beta', beta.payload],
    ] as const) {
      const archive = JSON.parse(readFileSync(join(archiveDir, String(payload.archiveRef)), 'utf8')) as {
        tabId: string;
        turns: Array<{ id: string }>;
      };
      expect(archive.tabId).toBe(threadId);
      expect(archive.turns.every((turn) => turn.id.startsWith(threadId.replace('thoughts-', '')))).toBe(true);
    }
  });

  it('refuses a compaction request with no durable thread identity', async () => {
    const response = await POST(request({ repoPath, runningTotal: 151_000 }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ ok: false, error: 'threadId is required' });
  });
});
