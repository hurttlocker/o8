import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

process.env.CORTEX_IDE_DATA_DIR = mkdtempSync(join(os.tmpdir(), 'o8-mcp-inline-'));
process.env.O8_DATA_DIR = process.env.CORTEX_IDE_DATA_DIR;

function createTempRepo() {
  const repoPath = mkdtempSync(join(os.tmpdir(), 'o8-mcp-inline-repo-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repoPath, stdio: 'pipe' });
  git('init', '--initial-branch=main');
  git('-c', 'user.email=test@o8.test', '-c', 'user.name=o8-test', 'commit', '--allow-empty', '-m', 'init');
  return repoPath;
}

function textContent(result: { content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> }) {
  return result.content.find((entry) => entry.type === 'text')?.text ?? '';
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('handleCreateMission inline issue numbering', () => {
  it('creates same-ms inline missions with non-colliding issue numbers', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(new Date('2026-07-03T12:00:00.000Z').getTime());
    const repoPath = createTempRepo();
    const createBodies: Array<{ issues?: Array<{ number: number }> }> = [];

    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { issues?: Array<{ number: number }> };
      createBodies.push(body);

      const { createMission } = await import('@/lib/orchestrator/operator-mission-service/mission');
      const result = await createMission(body as Parameters<typeof createMission>[0]);
      return new Response(JSON.stringify({ ok: true, result }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }));

    const { handleCreateMission } = await import('./mission');

    const first = await handleCreateMission({
      issues_inline: [{ title: 'same millisecond task one', body: 'first body' }],
      repoPath,
      runtime: 'codex',
      dispatch: false,
    });
    const second = await handleCreateMission({
      issues_inline: [{ title: 'same millisecond task two', body: 'second body' }],
      repoPath,
      runtime: 'codex',
      dispatch: false,
    });

    expect(first.isError).not.toBe(true);
    expect(second.isError).not.toBe(true);
    expect(textContent(first)).toContain('missionId');
    expect(textContent(second)).toContain('missionId');
    expect(createBodies).toHaveLength(2);

    const numbers = createBodies.map((body) => body.issues?.[0]?.number);
    expect(numbers.every((number): number is number => typeof number === 'number')).toBe(true);
    expect(new Set(numbers).size).toBe(2);
    for (const number of numbers) {
      expect(Number.isSafeInteger(number)).toBe(true);
      expect(number).toBeGreaterThanOrEqual(90001);
    }
  });
});
