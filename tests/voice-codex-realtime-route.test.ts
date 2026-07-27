import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import {
  GET,
  POST,
} from '@/app/api/voice/realtime/codex/route';
import { closeAllCodexRealtimeSessions } from '@/lib/voice/codex-realtime-transport';

const fixtures: string[] = [];

function makeCodexFixture(authMode: 'chatgpt' | 'apikey') {
  const root = mkdtempSync(path.join(os.tmpdir(), 'o8-codex-realtime-route-'));
  fixtures.push(root);
  const codexHome = path.join(root, '.codex');
  const binDir = path.join(root, 'bin');
  const binaryPath = path.join(binDir, 'codex');
  mkdirSync(codexHome, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  writeFileSync(path.join(codexHome, 'auth.json'), JSON.stringify(
    authMode === 'chatgpt'
      ? {
        auth_mode: 'chatgpt',
        tokens: { access_token: 'fixture-access', refresh_token: 'fixture-refresh' },
      }
      : { auth_mode: 'apikey', OPENAI_API_KEY: 'fixture-api-key' },
  ));
  writeFileSync(
    path.join(codexHome, 'config.toml'),
    '[features]\nrealtime_conversation = true\n\n[realtime]\ntransport = "websocket"\n',
  );
  writeFileSync(binaryPath, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--version') {
  process.stdout.write('codex-cli 0.145.0\\n');
  process.exit(0);
}
if (args[0] === 'features' && args[1] === 'list') {
  process.stdout.write('realtime_conversation under development true\\n');
  process.exit(0);
}
if (args[0] === 'app-server' && args[1] === '--help') {
  process.stdout.write('Supported: stdio:// unix:// ws://\\n');
  process.exit(0);
}
if (args[0] === 'app-server' && args[1] === 'daemon' && args[2] === 'version') {
  process.exit(1);
}
if (args[0] !== 'app-server' || args[1] !== '--stdio') process.exit(1);

const realtimeMethods = new Set([
  'thread/realtime/start',
  'thread/realtime/appendAudio',
  'thread/realtime/appendText',
  'thread/realtime/appendSpeech',
  'thread/realtime/stop',
]);
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  for (const line of chunk.trim().split(/\\r?\\n/)) {
    if (!line) continue;
    const request = JSON.parse(line);
    if (request.method === 'initialized') continue;
    if (request.method === 'initialize') {
      send({ id: request.id, result: {
        userAgent: 'fixture/0.145.0',
        codexHome: process.env.CODEX_HOME,
        platformFamily: 'unix',
        platformOs: 'macos',
      } });
      continue;
    }
    if (realtimeMethods.has(request.method) && !request.params?.threadId) {
      send({ id: request.id, error: { code: -32602, message: 'threadId is required' } });
      continue;
    }
    if (request.method === 'thread/start') {
      send({ id: request.id, result: { thread: { id: 'thread-fixture' } } });
      continue;
    }
    if (request.method === 'thread/realtime/start') {
      if (request.params.version !== 'v2') {
        send({ id: request.id, error: { code: -32602, message: 'v2 required' } });
        continue;
      }
      if (
        request.params.transport?.type !== 'webrtc'
        || !request.params.transport?.sdp?.startsWith('v=')
      ) {
        send({ id: request.id, error: { code: -32602, message: 'WebRTC SDP required' } });
        continue;
      }
      send({ id: request.id, result: {} });
      send({ method: 'thread/realtime/started', params: {
        threadId: request.params.threadId,
        realtimeSessionId: 'rtc_fixture',
        version: 'v2',
      } });
      send({ method: 'thread/realtime/sdp', params: {
        threadId: request.params.threadId,
        sdp: 'v=0\\r\\nanswer-fixture',
      } });
      continue;
    }
    if (request.method === 'thread/realtime/appendText') {
      send({ id: request.id, result: {} });
      send({ method: 'thread/realtime/transcript/delta', params: {
        threadId: request.params.threadId,
        role: 'assistant',
        delta: 'voice ',
      } });
      send({ method: 'thread/realtime/transcript/done', params: {
        threadId: request.params.threadId,
        role: 'assistant',
        text: 'voice reply',
      } });
      send({ method: 'thread/realtime/outputAudio/delta', params: {
        threadId: request.params.threadId,
        audio: {
          data: 'ZmFrZQ==',
          sampleRate: 24000,
          numChannels: 1,
          samplesPerChannel: 4,
          itemId: null,
        },
      } });
      continue;
    }
    if (request.method === 'thread/realtime/appendAudio' || request.method === 'thread/realtime/appendSpeech') {
      send({ id: request.id, result: {} });
      continue;
    }
    if (request.method === 'thread/realtime/stop') {
      send({ id: request.id, result: {} });
      send({ method: 'thread/realtime/closed', params: {
        threadId: request.params.threadId,
        reason: 'stopped',
      } });
      continue;
    }
    if (request.method === 'turn/start') {
      send({ id: request.id, result: { turn: { id: 'turn-fixture' } } });
      send({ method: 'item/agentMessage/delta', params: {
        threadId: request.params.threadId,
        turnId: 'turn-fixture',
        itemId: 'item-fixture',
        delta: 'text ',
      } });
      send({ method: 'item/completed', params: {
        threadId: request.params.threadId,
        turnId: 'turn-fixture',
        completedAtMs: Date.now(),
        item: {
          type: 'agentMessage',
          id: 'item-fixture',
          text: 'text reply',
          phase: null,
          memoryCitation: null,
        },
      } });
      send({ method: 'turn/completed', params: {
        threadId: request.params.threadId,
        turn: { id: 'turn-fixture', status: 'completed' },
      } });
      continue;
    }
    send({ id: request.id, error: { code: -32601, message: 'Method not found' } });
  }
});
`);
  chmodSync(binaryPath, 0o755);
  return { root, codexHome, binaryPath };
}

function useFixture(fixture: ReturnType<typeof makeCodexFixture>) {
  vi.stubEnv('HOME', fixture.root);
  vi.stubEnv('CODEX_HOME', fixture.codexHome);
  vi.stubEnv('O8_CODEX_BIN', fixture.binaryPath);
  vi.stubEnv('OPENAI_API_KEY', '');
  vi.stubEnv('CODEX_API_KEY', '');
}

function post(body: Record<string, unknown>) {
  return POST(new NextRequest('http://localhost/api/voice/realtime/codex', {
    method: 'POST',
    headers: { host: 'localhost', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

function get(query = '') {
  return GET(new NextRequest(`http://localhost/api/voice/realtime/codex${query}`, {
    headers: { host: 'localhost' },
  }));
}

async function pollUntilMethods(
  sessionId: string,
  since: number,
  expectedMethods: string[],
) {
  const events: Array<{ method?: string; params?: Record<string, unknown> }> = [];
  let nextSince = since;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const response = await get(
      `?sessionId=${encodeURIComponent(sessionId)}&since=${nextSince}&timeoutMs=1000`,
    );
    const polled = await response.json();
    events.push(...polled.events);
    nextSince = polled.nextSince;
    if (expectedMethods.every((method) => events.some((event) => event.method === method))) {
      break;
    }
  }
  return { events, nextSince };
}

afterEach(async () => {
  await closeAllCodexRealtimeSessions();
  vi.unstubAllEnvs();
  for (const fixture of fixtures.splice(0)) {
    rmSync(fixture, { recursive: true, force: true });
  }
});

describe('Codex realtime route real path', () => {
  it('capability-detects and drives the OAuth v2 WebRTC lifecycle through the route', async () => {
    useFixture(makeCodexFixture('chatgpt'));

    const capabilityResponse = await get();
    const capability = await capabilityResponse.json();
    expect(capabilityResponse.status).toBe(200);
    expect(capability).toMatchObject({
      ok: true,
      mode: 'codex-oauth',
      s2s: true,
      capability: {
        appServer: {
          realtimeMethods: [
            'thread/realtime/start',
            'thread/realtime/appendAudio',
            'thread/realtime/appendText',
            'thread/realtime/appendSpeech',
            'thread/realtime/stop',
          ],
          missingRealtimeMethods: [],
        },
        auth: { mode: 'chatgpt_oauth', chatgptOAuth: true },
        realtime: { enabled: true },
      },
    });

    const startResponse = await post({
      action: 'start',
      sdp: 'v=0\r\noffer-fixture',
      transport: 'webrtc',
      outputModality: 'audio',
    });
    const started = await startResponse.json();
    expect(startResponse.status).toBe(200);
    expect(started).toMatchObject({
      ok: true,
      mode: 'codex-oauth',
      transport: 'webrtc',
      version: 'v2',
      sdp: 'v=0\r\nanswer-fixture',
    });

    const startupPollResponse = await get(
      `?sessionId=${encodeURIComponent(started.sessionId)}&since=0&timeoutMs=10`,
    );
    const startupPoll = await startupPollResponse.json();
    expect(startupPoll.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ method: 'thread/realtime/started' }),
      expect.objectContaining({ method: 'thread/realtime/sdp' }),
    ]));

    const appendResponse = await post({
      action: 'appendText',
      sessionId: started.sessionId,
      text: 'hello voice',
    });
    expect(appendResponse.status).toBe(200);

    const polled = await pollUntilMethods(
      started.sessionId,
      startupPoll.nextSince,
      ['thread/realtime/transcript/done', 'thread/realtime/outputAudio/delta'],
    );
    expect(polled.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        method: 'thread/realtime/transcript/done',
        params: expect.objectContaining({ text: 'voice reply' }),
      }),
      expect.objectContaining({ method: 'thread/realtime/outputAudio/delta' }),
    ]));

    const stopResponse = await post({ action: 'stop', sessionId: started.sessionId });
    expect(stopResponse.status).toBe(200);
  });

  it('automatically opens a real text turn for API-key-only auth', async () => {
    useFixture(makeCodexFixture('apikey'));

    const startResponse = await post({
      action: 'start',
      sdp: 'v=0\r\noffer-fixture',
      transport: 'webrtc',
    });
    const started = await startResponse.json();
    expect(startResponse.status).toBe(200);
    expect(started).toMatchObject({
      ok: true,
      mode: 'text',
      transport: 'text',
      version: null,
      fallbackReason: expect.stringMatching(/API-key auth.*text automatically/i),
    });

    const appendResponse = await post({
      action: 'appendText',
      sessionId: started.sessionId,
      text: 'hello text',
    });
    expect(appendResponse.status).toBe(200);

    const polled = await pollUntilMethods(
      started.sessionId,
      0,
      ['thread/realtime/transcript/done'],
    );
    expect(polled).toMatchObject({
      events: expect.arrayContaining([
        expect.objectContaining({
          method: 'thread/realtime/transcript/done',
          params: expect.objectContaining({ text: 'text reply' }),
        }),
      ]),
    });

    const audioResponse = await post({
      action: 'appendAudio',
      sessionId: started.sessionId,
      audio: {
        data: 'ZmFrZQ==',
        sampleRate: 24_000,
        numChannels: 1,
      },
    });
    expect(audioResponse.status).toBe(409);
    await post({ action: 'stop', sessionId: started.sessionId });
  });
});
