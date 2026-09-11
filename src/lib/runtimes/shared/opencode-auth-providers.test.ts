import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const {
  opencodeAuthenticatedProviders,
  opencodeCliProviders,
  setOpencodeAuthListProbeDependenciesForTests,
} = await import('./opencode-readiness');

const CLI_PATH = '/test-bin/opencode2';

/** Shape of `auth list --format json`: provider ids plus how each is connected. */
const CLI_PAYLOAD = JSON.stringify([
  { id: 'openrouter', name: 'OpenRouter', connections: [{ type: 'credential', id: 'cred_test', label: 'default' }] },
  { id: 'xai', name: 'xAI', connections: [{ type: 'env', name: 'XAI_API_KEY' }] },
  { id: 'anthropic', name: 'Anthropic', connections: [] },
]);

let home: string;
let savedDataHome: string | undefined;
let savedAuthContent: string | undefined;

function writeLegacyAuthFile(providers: Record<string, unknown>): void {
  const directory = path.join(home, '.local', 'share', 'opencode');
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, 'auth.json'), JSON.stringify(providers));
}

function stubCli(run: (args: string[]) => Promise<string>): string[][] {
  const calls: string[][] = [];
  setOpencodeAuthListProbeDependenciesForTests({
    run: (args) => {
      calls.push(args);
      return run(args);
    },
  });
  return calls;
}

beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), 'o8-opencode-auth-'));
  savedDataHome = process.env.XDG_DATA_HOME;
  savedAuthContent = process.env.OPENCODE_AUTH_CONTENT;
  delete process.env.XDG_DATA_HOME;
  delete process.env.OPENCODE_AUTH_CONTENT;
});

afterEach(() => {
  setOpencodeAuthListProbeDependenciesForTests(null);
  if (savedDataHome === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = savedDataHome;
  if (savedAuthContent === undefined) delete process.env.OPENCODE_AUTH_CONTENT;
  else process.env.OPENCODE_AUTH_CONTENT = savedAuthContent;
  rmSync(home, { recursive: true, force: true });
});

describe('opencodeAuthenticatedProviders', () => {
  it('reports providers the CLI holds when no credential file exists', async () => {
    const calls = stubCli(async () => CLI_PAYLOAD);

    const providers = await opencodeAuthenticatedProviders(home, CLI_PATH);

    expect([...providers].sort()).toEqual(['openrouter', 'xai']);
    expect(calls).toEqual([['auth', 'list', '--format', 'json']]);
  });

  it('still reports providers from a credential file when the CLI is absent', async () => {
    writeLegacyAuthFile({ openrouter: { type: 'api', key: 'legacy-key' } });

    const providers = await opencodeAuthenticatedProviders(home, null);

    expect([...providers]).toEqual(['openrouter']);
  });

  it('unions the credential file with what the CLI reports', async () => {
    writeLegacyAuthFile({ anthropic: { type: 'api', key: 'legacy-key' } });
    stubCli(async () => CLI_PAYLOAD);

    const providers = await opencodeAuthenticatedProviders(home, CLI_PATH);

    expect([...providers].sort()).toEqual(['anthropic', 'openrouter', 'xai']);
  });

  it('falls back to the credential file when the CLI probe fails', async () => {
    writeLegacyAuthFile({ openrouter: { type: 'api', key: 'legacy-key' } });
    stubCli(async () => {
      throw new Error('probe timed out');
    });

    await expect(opencodeAuthenticatedProviders(home, CLI_PATH)).resolves.toEqual(
      new Set(['openrouter']),
    );
  });

  it('treats an unreadable payload as indeterminate rather than empty', async () => {
    writeLegacyAuthFile({ openrouter: { type: 'api', key: 'legacy-key' } });
    stubCli(async () => JSON.stringify([{ provider: 'openrouter', status: 'stored' }]));

    await expect(opencodeAuthenticatedProviders(home, CLI_PATH)).resolves.toEqual(
      new Set(['openrouter']),
    );
  });
});

describe('opencodeCliProviders', () => {
  it('returns null without a CLI to ask', async () => {
    await expect(opencodeCliProviders(null)).resolves.toBeNull();
  });

  it('returns an empty set when the CLI reports nothing connected', async () => {
    stubCli(async () => '[]');

    await expect(opencodeCliProviders(CLI_PATH)).resolves.toEqual(new Set());
  });

  it('returns null when the CLI emits output that is not JSON', async () => {
    stubCli(async () => 'No authenticated integrations');

    await expect(opencodeCliProviders(CLI_PATH)).resolves.toBeNull();
  });
});
