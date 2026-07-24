import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { probeCodexVoiceCapability } from './appserver-probe';

const fixtures: string[] = [];

function makeFixture(
  auth: Record<string, unknown>,
  config = '[features]\nrealtime_conversation = true\n\n[realtime]\ntransport = "websocket"\n',
) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'o8-codex-voice-probe-'));
  fixtures.push(root);
  const codexHome = path.join(root, '.codex');
  const binDir = path.join(root, 'bin');
  const binaryPath = path.join(binDir, 'codex');
  mkdirSync(codexHome, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  writeFileSync(path.join(codexHome, 'auth.json'), JSON.stringify(auth));
  writeFileSync(path.join(codexHome, 'config.toml'), config);
  writeFileSync(binaryPath, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--version') {
  process.stdout.write('codex-cli 0.144.1\\n');
  process.exit(0);
}
if (args[0] === 'features' && args[1] === 'list') {
  const config = fs.readFileSync(process.env.CODEX_HOME + '/config.toml', 'utf8');
  const enabled = /realtime_conversation\\s*=\\s*true/.test(config);
  process.stdout.write('realtime_conversation under development ' + enabled + '\\n');
  process.exit(0);
}
if (args[0] === 'app-server' && args[1] === '--help') {
  process.stdout.write('Supported: stdio:// unix:// ws://\\n');
  process.exit(0);
}
if (args[0] === 'app-server' && args[1] === 'daemon' && args[2] === 'version') {
  process.stderr.write('no daemon\\n');
  process.exit(1);
}
if (args[0] === 'app-server' && args[1] === '--stdio') {
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    for (const line of chunk.trim().split(/\\r?\\n/)) {
      const request = JSON.parse(line);
      if (request.method === 'initialize') {
        process.stdout.write(JSON.stringify({
          id: request.id,
          result: {
            userAgent: 'fixture/0.144.1',
            codexHome: process.env.CODEX_HOME,
            platformFamily: 'unix',
            platformOs: 'macos',
          },
        }) + '\\n');
      }
    }
  });
  return;
}
process.exit(1);
`);
  chmodSync(binaryPath, 0o755);
  return { root, codexHome, binaryPath };
}

afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true });
});

describe('probeCodexVoiceCapability', () => {
  it('reports the missing-binary rung without reading real user state', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'o8-codex-voice-missing-'));
    fixtures.push(root);

    const capability = await probeCodexVoiceCapability({
      binaryPath: null,
      home: root,
      codexHome: path.join(root, '.codex'),
      env: { HOME: root, OPENAI_API_KEY: '', CODEX_API_KEY: '' },
      timeoutMs: 500,
    });

    expect(capability.capable).toBe(false);
    expect(capability.installation).toMatchObject({
      installed: false,
      version: null,
    });
    expect(capability.installation.whyNot).toContain('not installed');
    expect(capability.appServer.reachable).toBe(false);
  });

  it('reports API-key-only auth as voice-impossible while keeping text fallback explicit', async () => {
    const fixture = makeFixture({
      auth_mode: 'apikey',
      OPENAI_API_KEY: 'fixture-key',
    });

    const capability = await probeCodexVoiceCapability({
      binaryPath: fixture.binaryPath,
      home: fixture.root,
      codexHome: fixture.codexHome,
      env: { HOME: fixture.root, OPENAI_API_KEY: '', CODEX_API_KEY: '' },
      timeoutMs: 1_000,
    });

    expect(capability.installation).toMatchObject({
      installed: true,
      version: '0.144.1',
    });
    expect(capability.appServer).toMatchObject({
      reachable: true,
      transports: ['stdio'],
    });
    expect(capability.auth.mode).toBe('api_key');
    expect(capability.auth.whyNot).toContain('text fallback');
    expect(capability.capable).toBe(false);
  });

  it('reports ChatGPT OAuth plus active realtime flags as voice-capable', async () => {
    const fixture = makeFixture({
      auth_mode: 'chatgpt',
      tokens: {
        access_token: 'fixture-access',
        refresh_token: 'fixture-refresh',
      },
    });

    const capability = await probeCodexVoiceCapability({
      binaryPath: fixture.binaryPath,
      home: fixture.root,
      codexHome: fixture.codexHome,
      env: { HOME: fixture.root, OPENAI_API_KEY: '', CODEX_API_KEY: '' },
      timeoutMs: 1_000,
    });

    expect(capability.capable).toBe(true);
    expect(capability.whyNot).toBeNull();
    expect(capability.auth).toMatchObject({
      mode: 'chatgpt_oauth',
      chatgptOAuth: true,
      whyNot: null,
    });
    expect(capability.realtime).toMatchObject({
      enabled: true,
      featureEnabled: true,
      realtimeSectionPresent: true,
      websocketModeEnabled: true,
      whyNot: null,
    });
  });
});
