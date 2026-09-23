import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ deny: false }));
vi.mock('@/lib/panel/auth', () => ({
  requirePanelAuth: () => h.deny ? Response.json({ ok: false, error: 'unauthorized' }, { status: 401 }) : null,
}));

import { GET, POST } from './route';

let root: string;
let configPath: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'o8-imessage-access-'));
  configPath = join(root, 'bridge.json');
  process.env.O8_SYMON_IMESSAGE_TEST_CONFIG = configPath;
  h.deny = false;
  writeFileSync(configPath, JSON.stringify({
    enabled: true,
    directSender: '+15555550101',
    groupSenders: ['+15555550101', '+15555550102'],
    groupConversationIds: ['68'],
    groupMembers: { '68': ['+15555550101', '+15555550102'] },
    groupLabels: { '68': 'Family group' },
    knowledgeRepoPath: '/private/example',
  }), { mode: 0o600 });
});

afterEach(() => {
  delete process.env.O8_SYMON_IMESSAGE_TEST_CONFIG;
  rmSync(root, { recursive: true, force: true });
});

function request(method: 'GET' | 'POST', body?: object): NextRequest {
  return new NextRequest('http://localhost/api/panel/symon/imessage-access', {
    method,
    ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
  });
}

it('grants exactly the verified group members through an authenticated persisted setting', async () => {
  const initial = await GET(request('GET'));
  const initialJson = await initial.json() as { groups: Array<{ memberSuffixes: string[]; fullAccess: boolean; approvalVersion: string }> };
  expect(initialJson.groups[0]).toMatchObject({ memberSuffixes: ['0101', '0102'], fullAccess: false });
  expect(JSON.stringify(initialJson)).not.toContain('+15555550101');

  const withoutConfirmation = await POST(request('POST', { groupId: '68', fullAccess: true }));
  expect(withoutConfirmation.status).toBe(400);
  const granted = await POST(request('POST', { groupId: '68', fullAccess: true, confirm: 'grant-all-approved-members', approvalVersion: initialJson.groups[0].approvalVersion }));
  expect(granted.status).toBe(200);
  expect((await granted.json()).group.fullAccess).toBe(true);
  const saved = JSON.parse(readFileSync(configPath, 'utf8')) as { groupFullAccess: Record<string, string[]> };
  expect(saved.groupFullAccess['68']).toEqual(['+15555550101', '+15555550102']);

  const revoked = await POST(request('POST', { groupId: '68', fullAccess: false }));
  expect(revoked.status).toBe(200);
  expect((await revoked.json()).group.fullAccess).toBe(false);
  const after = JSON.parse(readFileSync(configPath, 'utf8')) as { groupFullAccess: Record<string, string[]> };
  expect(after.groupFullAccess['68']).toBeUndefined();
});

it('rejects unconfigured groups and unauthenticated callers', async () => {
  expect((await POST(request('POST', { groupId: '69', fullAccess: false }))).status).toBe(409);
  h.deny = true;
  expect((await GET(request('GET'))).status).toBe(401);
  expect((await POST(request('POST', { groupId: '68', fullAccess: false }))).status).toBe(401);
});

it('returns the group to limited access when its approved membership changes', async () => {
  const initial = await (await GET(request('GET'))).json() as { groups: Array<{ approvalVersion: string }> };
  await POST(request('POST', { groupId: '68', fullAccess: true, confirm: 'grant-all-approved-members', approvalVersion: initial.groups[0].approvalVersion }));
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
    groupSenders: string[];
    groupMembers: Record<string, string[]>;
  };
  config.groupSenders.push('+15555550103');
  config.groupMembers['68'].push('+15555550103');
  writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });

  const changed = await GET(request('GET'));
  expect((await changed.json()).groups[0]).toMatchObject({
    memberSuffixes: ['0101', '0102', '0103'],
    fullAccess: false,
  });
  const staleConfirmation = await POST(request('POST', {
    groupId: '68', fullAccess: true, confirm: 'grant-all-approved-members',
    approvalVersion: initial.groups[0].approvalVersion,
  }));
  expect(staleConfirmation.status).toBe(409);
  expect((await staleConfirmation.json()).error).toBe('membership_changed');
});
