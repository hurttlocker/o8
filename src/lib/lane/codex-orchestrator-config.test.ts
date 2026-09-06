import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parse } from 'smol-toml';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { OrchestratorEvent } from './orchestrator-stream-events';

const root = mkdtempSync(join(tmpdir(), 'o8-codex-orchestrator-config-'));
const userHome = join(root, 'user');
const userCodexHome = join(userHome, '.codex');
const dataDir = join(root, 'data');
const repoPath = join(root, 'repo');
const originalHome = process.env.HOME;
const originalDataDir = process.env.CORTEX_IDE_DATA_DIR;
const originalCodexBin = process.env.O8_CODEX_BIN;
const originalCrashSurvival = process.env.O8_CRASH_SURVIVABLE_ORCHESTRATOR;
const originalArgsPath = process.env.O8_TEST_CODEX_ARGS_PATH;

mkdirSync(userCodexHome, { recursive: true });
mkdirSync(repoPath, { recursive: true });
process.env.HOME = userHome;
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_CRASH_SURVIVABLE_ORCHESTRATOR = '0';

const { prepareCodexHome } = await import('./codex-orchestrator-config');
const { ensureCodexOrchestratorSession, sendToCodexOrchestrator } = await import('./codex-orchestrator-session');

beforeEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
  writeFileSync(join(userCodexHome, 'config.toml'), [
    'model = "gpt-5.5"',
    '',
    '[features]',
    'web_search = true',
    '',
  ].join('\n'));
});

afterAll(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalDataDir === undefined) delete process.env.CORTEX_IDE_DATA_DIR;
  else process.env.CORTEX_IDE_DATA_DIR = originalDataDir;
  if (originalCodexBin === undefined) delete process.env.O8_CODEX_BIN;
  else process.env.O8_CODEX_BIN = originalCodexBin;
  if (originalCrashSurvival === undefined) delete process.env.O8_CRASH_SURVIVABLE_ORCHESTRATOR;
  else process.env.O8_CRASH_SURVIVABLE_ORCHESTRATOR = originalCrashSurvival;
  if (originalArgsPath === undefined) delete process.env.O8_TEST_CODEX_ARGS_PATH;
  else process.env.O8_TEST_CODEX_ARGS_PATH = originalArgsPath;
  rmSync(root, { recursive: true, force: true });
});

function writeModelsCache(slugs: string[]): void {
  writeFileSync(join(userCodexHome, 'models_cache.json'), JSON.stringify({
    models: slugs.map((slug) => ({ slug })),
  }));
}

function readGeneratedConfig(codexHome: string): {
  raw: string;
  parsed: Record<string, unknown>;
} {
  const raw = readFileSync(join(codexHome, 'config.toml'), 'utf8');
  return { raw, parsed: parse(raw) as Record<string, unknown> };
}

describe('Codex orchestrator home model config', () => {
  it('writes the Astra default through the generated orchestrator config path', () => {
    writeModelsCache(['gpt-6-astra', 'gpt-5.6-sol']);

    const prepared = prepareCodexHome(repoPath);
    const config = readGeneratedConfig(prepared.codexHome);

    expect(prepared).toMatchObject({ model: 'gpt-6-astra', note: null });
    expect(config.parsed.model).toBe('gpt-6-astra');
    expect(config.raw).toContain('[features]');
    expect(config.raw).toContain('[mcp_servers.');
  });

  it('falls back to Sol with a visible note when the persisted models cache lacks Astra', () => {
    writeModelsCache(['gpt-5.6-sol', 'gpt-5.6-terra']);

    const prepared = prepareCodexHome(repoPath);
    const config = readGeneratedConfig(prepared.codexHome);

    expect(prepared.model).toBe('gpt-5.6-sol');
    expect(prepared.note).toContain('Host models cache does not list gpt-6-astra');
    expect(config.parsed.model).toBe('gpt-5.6-sol');
    expect(config.raw).toContain(`# o8: ${prepared.note}`);
    expect(config.raw).not.toContain('model = "gpt-5.5"');
  });

  it('launches the real session path on Sol and streams the cache fallback note', async () => {
    writeModelsCache(['gpt-5.6-sol', 'gpt-5.6-terra']);
    const argsPath = join(root, 'codex-args.txt');
    const codexBin = join(root, 'codex-fixture');
    writeFileSync(codexBin, [
      '#!/bin/sh',
      'if [ "$1" = "--version" ]; then',
      '  echo "codex-cli 0.150.0"',
      '  exit 0',
      'fi',
      'printf "%s\\n" "$@" > "$O8_TEST_CODEX_ARGS_PATH"',
    ].join('\n'), { mode: 0o700 });
    chmodSync(codexBin, 0o700);
    process.env.O8_CODEX_BIN = codexBin;
    process.env.O8_TEST_CODEX_ARGS_PATH = argsPath;
    const events: OrchestratorEvent[] = [];
    const session = ensureCodexOrchestratorSession(process.cwd(), 'thoughts-astra-fallback');

    await sendToCodexOrchestrator(session, 'Exercise the cached fallback.', (event) => {
      events.push(event);
    }, { model: 'gpt-6-astra' });

    expect(events).toContainEqual({
      type: 'thinking',
      text: expect.stringContaining('Host models cache does not list gpt-6-astra'),
    });
    const args = readFileSync(argsPath, 'utf8').split('\n');
    expect(args).toContain('model=gpt-5.6-sol');
    expect(args).not.toContain('model=gpt-6-astra');
  });
});
