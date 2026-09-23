import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { askSymon, handleMessage, parseGroupParticipants, readBridgeConfig, routeFor, weddingContext } from './core.mjs';

const root = mkdtempSync(join(tmpdir(), 'symon-imessage-test-'));
mkdirSync(join(root, 'handoff'), { recursive: true });
mkdirSync(join(root, 'wedding/planning'), { recursive: true });
mkdirSync(join(root, 'sources/conversations'), { recursive: true });
writeFileSync(join(root, 'handoff/CURRENT-STATE.md'), 'The celebration date is tentative.');
writeFileSync(join(root, 'handoff/CONFLICTS.md'), 'An older venue plan was superseded.');
writeFileSync(join(root, 'wedding/planning/budget.md'), 'The civil ceremony budget is separate.');
writeFileSync(join(root, 'sources/conversations/messages.jsonl'), `${JSON.stringify({ role: 'user', timestamp: '2026-09-01T00:00:00Z', text: 'Please keep the civil ceremony budget separate.', delivery_verified: true })}\n`);

const config = {
  directSender: '+12155550101',
  groupSenders: ['+12155550101', '+12155550102'],
  groupConversationIds: ['68'],
  groupMembers: { '68': ['+12155550101', '+12155550102'] },
  knowledgeRepoPath: root,
};

test('routes the owner direct chat and both allowed group senders', () => {
  assert.deepEqual(routeFor({ isGroup: false }, { channelId: 'imessage', senderId: '+12155550101', conversationId: 'direct:1' }, config), {
    sender: '+12155550101', conversationId: 'imessage:direct:direct:1', shared: false,
  });
  assert.equal(routeFor({ isGroup: false }, { channelId: 'imessage', senderId: '+12155550102', conversationId: 'direct:2' }, config), null);
  for (const senderId of config.groupSenders) {
    assert.equal(routeFor({ isGroup: true }, { channelId: 'imessage', senderId, conversationId: 'imessage:group:68' }, config)?.shared, true);
  }
  assert.equal(routeFor({ isGroup: true }, { channelId: 'imessage', senderId: '+12155550103', conversationId: 'imessage:group:68' }, config), null);
  assert.equal(routeFor({ isGroup: true }, { channelId: 'imessage', senderId: '+12155550101', conversationId: 'imessage:group:69' }, config), null);
});

test('full group access applies only when every approved member matches the grant', () => {
  const granted = { ...config, groupFullAccess: { '68': [...config.groupMembers['68']] } };
  const liveGroupMembers = () => [...config.groupMembers['68']];
  assert.equal(routeFor({ isGroup: true }, { channelId: 'imessage', senderId: '+12155550101', conversationId: 'imessage:group:68' }, granted, { liveGroupMembers })?.conversationId,
    'full-imessage:imessage:group:68');
  assert.equal(routeFor({ isGroup: true }, { channelId: 'imessage', senderId: '+12155550102', conversationId: 'imessage:group:68' }, granted, { liveGroupMembers })?.shared, false);
  assert.equal(routeFor({ isGroup: true }, { channelId: 'imessage', senderId: '+12155550101', conversationId: 'imessage:group:68' }, granted, { liveGroupMembers: () => null })?.shared, true);
  assert.equal(routeFor({ isGroup: true }, { channelId: 'imessage', senderId: '+12155550101', conversationId: 'imessage:group:68' }, granted, { liveGroupMembers: () => [...config.groupMembers['68'], '+12155550103'] })?.shared, true);
  const changedMembership = { ...granted, groupMembers: { '68': [...config.groupMembers['68'], '+12155550103'] }, groupSenders: [...config.groupSenders, '+12155550103'] };
  assert.equal(routeFor({ isGroup: true }, { channelId: 'imessage', senderId: '+12155550101', conversationId: 'imessage:group:68' }, changedMembership)?.shared, true);
  assert.equal(routeFor({ isGroup: true }, { channelId: 'imessage', senderId: '+12155550103', conversationId: 'imessage:group:68' }, changedMembership)?.shared, true);
});

test('stale grants are discarded while the limited group route remains available', () => {
  const path = join(root, 'stale-config.json');
  writeFileSync(path, JSON.stringify({
    enabled: true,
    ...config,
    groupFullAccess: { '68': ['+12155550101', '+12155550103'] },
  }));
  const loaded = readBridgeConfig(path);
  assert.ok(loaded);
  assert.equal(routeFor({ isGroup: true }, { channelId: 'imessage', senderId: '+12155550101', conversationId: 'imessage:group:68' }, loaded)?.shared, true);
});

test('accepts only the exact iMessage group identity and phone roster', () => {
  const group = { id: 68, service: 'iMessage', is_group: true, participants: [...config.groupMembers['68']] };
  assert.deepEqual(parseGroupParticipants(JSON.stringify(group), '68'), config.groupMembers['68']);
  assert.equal(parseGroupParticipants(JSON.stringify({ ...group, id: 69 }), '68'), null);
  assert.equal(parseGroupParticipants(JSON.stringify({ ...group, participants: [...group.participants, 'unknown'] }), '68'), null);
});

test('loads bounded source-labeled context from the approved repository', () => {
  const context = weddingContext(root, 'What is the civil ceremony budget?', true);
  assert.match(context, /Source: handoff\/CURRENT-STATE.md/);
  assert.match(context, /Source: wedding\/planning\/budget.md/);
  assert.match(context, /Retained conversation evidence/);
  assert.match(context, /delivery verified/);
  assert.ok(context.length <= 23_000);
});

test('claims a selected group message and forwards one durable turn to Symon', async () => {
  const requests = [];
  const result = await handleMessage(
    { isGroup: true, content: 'What is the date?', messageId: 'message-7' },
    { channelId: 'imessage', senderId: '+12155550102', conversationId: 'imessage:group:68', messageId: 'message-7' },
    config,
    {
      apiBase: 'http://127.0.0.1:12345',
      token: 'local-test-token-with-enough-length',
      fetchImpl: async (_url, init) => {
        requests.push(JSON.parse(init.body));
        return { status: 200, json: async () => ({ ok: true, state: 'done', text: 'The date is tentative.' }) };
      },
    },
  );
  assert.deepEqual(result, { handled: true, text: 'The date is tentative.' });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].eventId, 'imessage:message-7');
  assert.equal(requests[0].conversationId, 'shared-imessage:imessage:group:68');
  assert.match(requests[0].context, /celebration date is tentative/);
  assert.equal(requests[0].context.includes(root), false);
});

test('passes the registered project path only to the owner direct route', async () => {
  const requests = [];
  const result = await handleMessage(
    { isGroup: false, content: 'Where is the agreement?', messageId: 'message-10' },
    { channelId: 'imessage', senderId: '+12155550101', conversationId: 'direct:1', messageId: 'message-10' },
    config,
    {
      apiBase: 'http://127.0.0.1:12345',
      token: 'local-test-token-with-enough-length',
      fetchImpl: async (_url, init) => {
        requests.push(JSON.parse(init.body));
        return { status: 200, json: async () => ({ ok: true, state: 'done', text: 'I can open the registered project.' }) };
      },
    },
  );
  assert.equal(result?.handled, true);
  assert.equal(requests[0].conversationId, 'imessage:direct:direct:1');
  assert.match(requests[0].context, /Registered project repository:/);
  assert.equal(requests[0].context.includes(root), true);
});

test('hands approved full-access chats to the configured native agent without opening a managed session', async () => {
  const nativeConfig = { ...config, executionBackend: 'openclaw', openclawAgentId: 'symon', groupFullAccess: { '68': [...config.groupMembers['68']] } };
  let forwarded = false;
  const options = {
    liveGroupMembers: () => [...config.groupMembers['68']],
    fetchImpl: async () => { forwarded = true; throw new Error('managed route must not run'); },
  };
  const direct = await handleMessage(
    { isGroup: false, content: 'Hello', messageId: 'native-1' },
    { channelId: 'imessage', senderId: config.directSender, conversationId: 'direct:1', sessionKey: 'agent:symon:imessage:direct:1', messageId: 'native-1' },
    nativeConfig,
    options,
  );
  assert.deepEqual(direct, { handled: false });
  const group = await handleMessage(
    { isGroup: true, content: 'Hello', messageId: 'native-2' },
    { channelId: 'imessage', senderId: config.groupSenders[1], conversationId: 'imessage:group:68', sessionKey: 'agent:symon:imessage:group:68', messageId: 'native-2' },
    nativeConfig,
    options,
  );
  assert.deepEqual(group, { handled: false });
  assert.equal(forwarded, false);
});

test('native route fails closed on another agent and retains the limited group route on roster mismatch', async () => {
  const nativeConfig = { ...config, executionBackend: 'openclaw', openclawAgentId: 'symon', groupFullAccess: { '68': [...config.groupMembers['68']] } };
  const wrongAgent = await handleMessage(
    { isGroup: false, content: 'Hello', messageId: 'native-3' },
    { channelId: 'imessage', senderId: config.directSender, conversationId: 'direct:1', sessionKey: 'agent:wedding:imessage:direct:1', messageId: 'native-3' },
    nativeConfig,
  );
  assert.equal(wrongAgent.handled, true);
  assert.match(wrongAgent.text, /unavailable/i);

  const requests = [];
  const limited = await handleMessage(
    { isGroup: true, content: 'Hello', messageId: 'native-4' },
    { channelId: 'imessage', senderId: config.groupSenders[1], conversationId: 'imessage:group:68', sessionKey: 'agent:symon:imessage:group:68', messageId: 'native-4' },
    nativeConfig,
    {
      liveGroupMembers: () => [...config.groupMembers['68'], '+12155550103'],
      apiBase: 'http://127.0.0.1:12345',
      token: 'local-test-token-with-enough-length',
      fetchImpl: async (_url, init) => {
        requests.push(JSON.parse(init.body));
        return { status: 200, json: async () => ({ ok: true, state: 'done', text: 'Limited reply.' }) };
      },
    },
  );
  assert.deepEqual(limited, { handled: true, text: 'Limited reply.' });
  assert.equal(requests[0].conversationId, 'shared-imessage:imessage:group:68');
});

test('never falls back to another agent after a selected route fails', async () => {
  const result = await handleMessage(
    { isGroup: false, content: 'Hello', messageId: 'message-8' },
    { channelId: 'imessage', senderId: '+12155550101', conversationId: 'direct:1', messageId: 'message-8' },
    config,
    { apiBase: 'http://127.0.0.1:12345', token: 'local-test-token-with-enough-length', fetchImpl: async () => { throw new Error('offline'); } },
  );
  assert.equal(result?.handled, true);
  assert.match(result.text, /did not hand this message to another agent/);
});

test('retries a timed-out HTTP wait using the same durable event identity', async () => {
  const bodies = [];
  const payload = { eventId: 'imessage:message-9', messageId: 'message-9' };
  const answer = await askSymon(payload, {
    apiBase: 'http://127.0.0.1:12345',
    token: 'local-test-token-with-enough-length',
    maxWaitMs: 5_000,
    fetchImpl: async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      if (bodies.length === 1) throw new DOMException('request timed out', 'TimeoutError');
      return { status: 200, json: async () => ({ ok: true, state: 'done', text: 'One reply.' }) };
    },
  });
  assert.equal(answer, 'One reply.');
  assert.equal(bodies.length, 2);
  assert.deepEqual(bodies[0], bodies[1]);
});
