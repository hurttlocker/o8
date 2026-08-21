import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildClaudeCodeWorkerSpawnEnv,
  OPENROUTER_CLAUDE_CODE_BASE_URL,
  OPENROUTER_CLAUDE_CODE_DEFAULT_MODEL,
} from './worker-profile';

describe('Claude Code worker profile', () => {
  let dataDir: string;
  let priorDataDir: string | undefined;
  let priorLegacyDataDir: string | undefined;

  beforeEach(() => {
    priorDataDir = process.env.O8_DATA_DIR;
    priorLegacyDataDir = process.env.CORTEX_IDE_DATA_DIR;
    dataDir = mkdtempSync(path.join(os.tmpdir(), 'o8-claude-worker-profile-'));
    process.env.O8_DATA_DIR = dataDir;
    process.env.CORTEX_IDE_DATA_DIR = dataDir;
    vi.resetModules();
  });

  afterEach(() => {
    if (priorDataDir === undefined) delete process.env.O8_DATA_DIR;
    else process.env.O8_DATA_DIR = priorDataDir;
    if (priorLegacyDataDir === undefined) delete process.env.CORTEX_IDE_DATA_DIR;
    else process.env.CORTEX_IDE_DATA_DIR = priorLegacyDataDir;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('atomically persists and reloads the model source without storing credentials', async () => {
    const profile = await import('./worker-profile');
    await profile.writeClaudeCodeWorkerProfile({
      source: 'openrouter',
      model: 'deepseek/deepseek-v4-pro-0813',
      codexModel: 'gpt-5.6-sol',
      repoSkillAllowlist: ['review-only'],
    });

    expect(profile.readClaudeCodeWorkerProfileSync()).toEqual({
      source: 'openrouter',
      model: 'deepseek/deepseek-v4-pro-0813',
      codexModel: 'gpt-5.6-sol',
      repoSkillAllowlist: ['review-only'],
    });
    const raw = readFileSync(path.join(dataDir, 'claude-code-worker.json'), 'utf8');
    expect(raw).toContain('deepseek/deepseek-v4-pro-0813');
    expect(raw).not.toContain('sk-');
  });

  it('fails back to the native account when the stored profile is malformed', async () => {
    writeFileSync(path.join(dataDir, 'claude-code-worker.json'), '{broken');
    const profile = await import('./worker-profile');
    expect(profile.readClaudeCodeWorkerProfileSync()).toEqual({ source: 'native', model: null, codexModel: null, repoSkillAllowlist: [] });
  });

  it('builds a child-only OpenRouter environment for every Claude Code model role', () => {
    const env = buildClaudeCodeWorkerSpawnEnv('openrouter', 'x-ai/grok-4.6', 'sk-or-test');
    expect(env).toMatchObject({
      ANTHROPIC_BASE_URL: OPENROUTER_CLAUDE_CODE_BASE_URL,
      ANTHROPIC_AUTH_TOKEN: 'sk-or-test',
      ANTHROPIC_API_KEY: '',
      ANTHROPIC_MODEL: 'x-ai/grok-4.6',
      ANTHROPIC_DEFAULT_FABLE_MODEL: 'x-ai/grok-4.6',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'x-ai/grok-4.6',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'x-ai/grok-4.6',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'x-ai/grok-4.6',
      CLAUDE_CODE_SUBAGENT_MODEL: 'x-ai/grok-4.6',
      CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1',
    });
    expect(buildClaudeCodeWorkerSpawnEnv('native', OPENROUTER_CLAUDE_CODE_DEFAULT_MODEL, 'sk-or-test')).toEqual({});
  });

  it('builds an isolated Codex subscription environment without Anthropic credentials', () => {
    const env = buildClaudeCodeWorkerSpawnEnv(
      'codex-subscription',
      'gpt-5.6-sol',
      'local-client-token',
      'http://127.0.0.1:8317',
    );
    expect(env).toMatchObject({
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:8317',
      ANTHROPIC_AUTH_TOKEN: 'local-client-token',
      ANTHROPIC_API_KEY: '',
      CLAUDE_CODE_OAUTH_TOKEN: '',
      ANTHROPIC_MODEL: 'gpt-5.6-sol',
      CLAUDE_CODE_SUBAGENT_MODEL: 'gpt-5.6-sol',
      CLAUDE_CODE_ALWAYS_ENABLE_EFFORT: '1',
      ENABLE_TOOL_SEARCH: 'false',
    });
  });
});
