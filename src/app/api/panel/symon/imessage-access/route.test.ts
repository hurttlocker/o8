import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
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
  process.env.O8_SYMON_IMESSAGE_TEST_OPENCLAW_CONFIG = join(root, 'openclaw.json');
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
  delete process.env.O8_SYMON_IMESSAGE_TEST_OPENCLAW_CONFIG;
  rmSync(root, { recursive: true, force: true });
});

it('offers the native backend only when the selected agent owns the iMessage binding', async () => {
  const openclawPath = process.env.O8_SYMON_IMESSAGE_TEST_OPENCLAW_CONFIG!;
  expect((await (await GET(request('GET'))).json())).toMatchObject({ executionBackend: 'cli', openclawConfigured: false });
  expect((await POST(request('POST', { executionBackend: 'openclaw' }))).status).toBe(409);
  writeFileSync(openclawPath, JSON.stringify({
    agents: { entries: { symon: { workspace: '/private/symon' } } },
    bindings: [{ agentId: 'symon', match: { channel: 'imessage', accountId: '*' } }],
  }), { mode: 0o600 });
  expect((await (await GET(request('GET'))).json())).toMatchObject({ openclawConfigured: true });
  const selected = await POST(request('POST', { executionBackend: 'openclaw' }));
  expect(selected.status).toBe(200);
  expect((await selected.json()).executionBackend).toBe('openclaw');
  expect((await (await GET(request('GET'))).json())).toMatchObject({ executionBackend: 'openclaw' });
  const persisted = JSON.parse(readFileSync(configPath, 'utf8')) as { executionBackend: string; openclawAgentId: string };
  expect(persisted).toMatchObject({ executionBackend: 'openclaw', openclawAgentId: 'symon' });
  expect((await (await POST(request('POST', { executionBackend: 'cli' }))).json()).executionBackend).toBe('cli');
});

function request(method: 'GET' | 'POST', body?: object): NextRequest {
  return new NextRequest('http://localhost/api/panel/symon/imessage-access', {
    method,
    ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
  });
}

function routedGroup(): { shared: boolean; conversationId: string } {
  const pluginUrl = pathToFileURL(join(process.cwd(), 'integrations/openclaw-symon-imessage/core.mjs')).href;
  const script = `
    const { readBridgeConfig, routeFor } = await import(process.argv[1]);
    const config = readBridgeConfig(process.argv[2]);
    const result = routeFor({ isGroup: true }, {
      channelId: 'imessage', senderId: '+15555550101', conversationId: 'imessage:group:68',
    }, config, { liveGroupMembers: () => config.groupMembers['68'] });
    console.log(JSON.stringify(result));
  `;
  return JSON.parse(execFileSync(process.execPath, [
    '--input-type=module', '-e', script, pluginUrl, configPath,
  ], { encoding: 'utf8', timeout: 5_000 })) as { shared: boolean; conversationId: string };
}

function bridgeLoads(): boolean {
  const pluginUrl = pathToFileURL(join(process.cwd(), 'integrations/openclaw-symon-imessage/core.mjs')).href;
  const script = `
    const { readBridgeConfig } = await import(process.argv[1]);
    console.log(Boolean(readBridgeConfig(process.argv[2])));
  `;
  return execFileSync(process.execPath, [
    '--input-type=module', '-e', script, pluginUrl, configPath,
  ], { encoding: 'utf8', timeout: 5_000 }).trim() === 'true';
}

function disabledHookResult(): { handled: boolean } {
  const pluginUrl = pathToFileURL(join(process.cwd(), 'integrations/openclaw-symon-imessage/core.mjs')).href;
  const script = `
    const { handleMessage, readBridgeConfig } = await import(process.argv[1]);
    const result = await handleMessage({ content: 'hello' }, {
      channelId: 'imessage', senderId: '+15555550101', conversationId: 'direct:1', messageId: 'test-1',
    }, readBridgeConfig(process.argv[2]));
    console.log(JSON.stringify(result ?? { handled: false }));
  `;
  return JSON.parse(execFileSync(process.execPath, [
    '--input-type=module', '-e', script, pluginUrl, configPath,
  ], { encoding: 'utf8', timeout: 5_000 })) as { handled: boolean };
}

it('switches the persisted bridge routing off and on through the authenticated route', async () => {
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as { directSender: string };
  config.directSender = 'imessage:+1 (555) 555-0101';
  writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  expect(bridgeLoads()).toBe(true);
  expect(await (await GET(request('GET'))).json()).toMatchObject({ configured: true, directSenderSuffix: '0101' });
  const off = await POST(request('POST', { enabled: false }));
  expect(off.status).toBe(200);
  expect((await off.json()).enabled).toBe(false);
  expect((await (await GET(request('GET'))).json()).enabled).toBe(false);
  expect(bridgeLoads()).toBe(false);
  expect(disabledHookResult()).toEqual({ handled: false });

  const on = await POST(request('POST', { enabled: true }));
  expect(on.status).toBe(200);
  expect((await on.json()).enabled).toBe(true);
  expect(bridgeLoads()).toBe(true);
  expect(routedGroup()).toMatchObject({ shared: true, conversationId: 'shared-imessage:imessage:group:68' });
});

it('grants exactly the verified group members through an authenticated persisted setting', async () => {
  const initial = await GET(request('GET'));
  const initialJson = await initial.json() as { directSenderSuffix: string; groups: Array<{ memberSuffixes: string[]; fullAccess: boolean; approvalVersion: string }> };
  expect(initialJson.directSenderSuffix).toBe('0101');
  expect(initialJson.groups[0]).toMatchObject({ memberSuffixes: ['0101', '0102'], fullAccess: false });
  expect(JSON.stringify(initialJson)).not.toContain('+15555550101');

  const withoutConfirmation = await POST(request('POST', { groupId: '68', fullAccess: true }));
  expect(withoutConfirmation.status).toBe(400);
  const granted = await POST(request('POST', { groupId: '68', fullAccess: true, confirm: 'grant-all-approved-members', approvalVersion: initialJson.groups[0].approvalVersion }));
  expect(granted.status).toBe(200);
  expect((await granted.json()).group.fullAccess).toBe(true);
  const saved = JSON.parse(readFileSync(configPath, 'utf8')) as { groupFullAccess: Record<string, string[]> };
  expect(saved.groupFullAccess['68']).toEqual(['+15555550101', '+15555550102']);
  expect(routedGroup()).toMatchObject({ shared: false, conversationId: 'full-imessage:imessage:group:68' });

  const revoked = await POST(request('POST', { groupId: '68', fullAccess: false }));
  expect(revoked.status).toBe(200);
  expect((await revoked.json()).group.fullAccess).toBe(false);
  const after = JSON.parse(readFileSync(configPath, 'utf8')) as { groupFullAccess: Record<string, string[]> };
  expect(after.groupFullAccess['68']).toBeUndefined();
  expect(routedGroup()).toMatchObject({ shared: true, conversationId: 'shared-imessage:imessage:group:68' });
});

it('rejects unconfigured groups and unauthenticated callers', async () => {
  expect((await POST(request('POST', { groupId: '69', fullAccess: false }))).status).toBe(409);
  h.deny = true;
  expect((await GET(request('GET'))).status).toBe(401);
  expect((await POST(request('POST', { groupId: '68', fullAccess: false }))).status).toBe(401);
  expect((await POST(request('POST', { enabled: false }))).status).toBe(401);
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
