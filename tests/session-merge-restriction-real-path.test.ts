import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NextRequest } from 'next/server';
import { afterAll, describe, expect, it, vi } from 'vitest';

const fixture = realpathSync(mkdtempSync(join(tmpdir(), 'o8-correction-rule-')));
vi.stubEnv('O8_DATA_DIR', fixture);
vi.stubEnv('CORTEX_IDE_DATA_DIR', fixture);
vi.stubEnv('CORTEX_IDE_DB_PATH', join(fixture, 'test.db'));
mkdirSync(join(fixture, 'chat-history'));
writeFileSync(join(fixture, 'chat-history', 'thoughts-owner.json'), JSON.stringify({ repoPath: fixture, messages: [] }));
const { getOrCreateWsToken } = await import('@/lib/ws-auth');
const { closeDb } = await import('@/lib/db');
const { POST, DELETE } = await import('@/app/api/orchestrator/session-rules/route');
const { listSessionRules } = await import('@/lib/db/session-rules-store');
function request(method: string, body?: unknown, suffix = '') {
  return new NextRequest(`http://localhost/api/orchestrator/session-rules${suffix}`, {
    method, headers: { host: 'localhost', authorization: `Bearer ${getOrCreateWsToken()}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
afterAll(() => { closeDb(); vi.unstubAllEnvs(); rmSync(fixture, { recursive: true, force: true }); });

describe('typed operator restriction through the session-rule route', () => {
  it('persists an explicit no-merge rule through reopen, without interpreting arbitrary text', async () => {
    const response = await POST(request('POST', { threadId: 'thoughts-owner', text: 'Keep this work for review.', constraint: 'no_merge' }));
    expect(response.status).toBe(200);
    const { result } = await response.json();
    expect(result.rule.constraint).toBe('no_merge');
    closeDb();
    expect(listSessionRules('thoughts-owner')[0].constraint).toBe('no_merge');
    const ordinary = await POST(request('POST', { threadId: 'thoughts-owner', text: 'Discuss the phrase do not merge.' }));
    expect((await ordinary.json()).result.rule.constraint).toBeNull();
    expect((await DELETE(request('DELETE', undefined, `?id=${result.rule.id}`))).status).toBe(200);
    expect(listSessionRules('thoughts-owner').some(rule => rule.constraint === 'no_merge')).toBe(false);
  });
});
