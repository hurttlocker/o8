import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  invalidateDeepSeekHarnessLaunchCache,
  resolveDeepSeekHarnessLaunch,
} from './runtime-resolution';

const roots: string[] = [];

function isolatedDataDir(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'o8-deepseek-acp-config-'));
  roots.push(root);
  vi.stubEnv('CORTEX_IDE_DATA_DIR', root);
  vi.stubEnv('O8_DEEPSEEK_HARNESS_BIN', path.join(root, 'dsh-acp-demo'));
  vi.stubEnv('O8_DEEPSEEK_HARNESS_ARGS', '');
  vi.stubEnv('O8_DEEPSEEK_HARNESS_CONFIG', '');
  return root;
}

afterEach(() => {
  invalidateDeepSeekHarnessLaunchCache();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('DeepSeek Harness official ACP resolution', () => {
  it('writes a private OpenRouter composition around the official ACP package', async () => {
    const root = isolatedDataDir();
    vi.stubEnv('O8_DEEPSEEK_HARNESS_PROVIDER', 'openrouter');
    vi.stubEnv('OPENROUTER_API_KEY', 'fixture-key');

    const launch = await resolveDeepSeekHarnessLaunch({ fresh: true, model: 'deepseek-v4-pro' });

    expect(launch).toMatchObject({
      provider: 'openrouter',
      model: 'deepseek/deepseek-v4-pro',
      version: '0.1.0-rc.6',
    });
    expect(launch.configPath).toBe(path.join(
      root,
      'runtime-config',
      'deepseek-harness-openrouter-deepseek-deepseek-v4-pro.cordis.yml',
    ));
    expect(launch.args).toEqual(['--config', launch.configPath]);
    const config = readFileSync(launch.configPath!, 'utf8');
    expect(config).toContain("name: '@deepseek-ai/dsh-acp-demo'");
    expect(config).toContain("name: '@deepseek-ai/dsh-llm-pi-ai'");
    expect(config).toContain("name: '@deepseek-ai/dsh-sandbox-local'");
    expect(config).toContain('model: deepseek/deepseek-v4-pro');
    expect(config).not.toContain('fixture-key');
    expect(statSync(launch.configPath!).mode & 0o777).toBe(0o600);
  });

  it('keeps the direct provider behind the same ACP boundary', async () => {
    isolatedDataDir();
    vi.stubEnv('O8_DEEPSEEK_HARNESS_PROVIDER', 'deepseek-official');
    vi.stubEnv('DEEPSEEK_API_KEY', 'fixture-key');

    const launch = await resolveDeepSeekHarnessLaunch({ fresh: true, model: 'deepseek/deepseek-v4-pro' });
    const config = readFileSync(launch.configPath!, 'utf8');

    expect(launch).toMatchObject({ provider: 'deepseek-official', model: 'deepseek-v4-pro' });
    expect(config).toContain("name: '@deepseek-ai/dsh-llm-deepseek'");
    expect(config).toContain('model: deepseek-v4-pro');
  });

  it('prefers the already configured OpenRouter route when both credentials exist', async () => {
    isolatedDataDir();
    vi.stubEnv('OPENROUTER_API_KEY', 'fixture-openrouter-key');
    vi.stubEnv('DEEPSEEK_API_KEY', 'fixture-direct-key');

    await expect(resolveDeepSeekHarnessLaunch({ fresh: true })).resolves.toMatchObject({
      provider: 'openrouter',
      model: 'deepseek/deepseek-v4-pro',
    });
  });

  it('rejects unknown provider routes instead of guessing', async () => {
    isolatedDataDir();
    vi.stubEnv('O8_DEEPSEEK_HARNESS_PROVIDER', 'mystery-provider');

    await expect(resolveDeepSeekHarnessLaunch({ fresh: true })).rejects.toThrow(
      'must be "deepseek-official" or "openrouter"',
    );
  });
});
