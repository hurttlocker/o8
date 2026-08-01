import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parse } from 'smol-toml';
import { beforeEach, describe, expect, it } from 'vitest';

const dataDir = mkdtempSync(join(tmpdir(), 'o8-settings-toml-'));
process.env.CORTEX_IDE_DATA_DIR = dataDir;

const {
  OPERATOR_DEFAULTS_FALLBACK,
  applyOperatorDefaultsToml,
  getOperatorDefaults,
  getOperatorDefaultsTomlPath,
  resolveOrchestratorBackendSync,
} = await import('@/lib/operator/defaults');
const {
  OPERATOR_DEFAULTS_TOML_MAPPING,
  parseOperatorDefaultsToml,
} = await import('./toml');
const { POST } = await import('@/app/api/panel/operator-defaults/route');

const tomlPath = getOperatorDefaultsTomlPath();
const jsonPath = join(dataDir, 'operator-defaults.json');

beforeEach(() => {
  rmSync(tomlPath, { force: true });
  rmSync(jsonPath, { force: true });
});

function postDefaults(body: unknown): Request {
  return new Request('http://127.0.0.1/api/panel/operator-defaults', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('settings.toml operator defaults', () => {
  it('maps every OperatorDefaults key to settings.toml (exhaustive-key-coverage)', () => {
    expect(Object.keys(OPERATOR_DEFAULTS_TOML_MAPPING).sort()).toEqual(
      Object.keys(OPERATOR_DEFAULTS_FALLBACK).sort(),
    );
  });

  it('applies a valid TOML edit through the consumer read path', async () => {
    const response = await POST(postDefaults({ settingsToml: `
[orchestrator]
backend = "codex"
` }));

    expect(response.status).toBe(200);
    expect(resolveOrchestratorBackendSync()).toBe('codex');
    expect((await getOperatorDefaults()).values.orchestratorBackend).toBe('codex');
  });

  it('rejects an invalid value with its key and leaves settings unchanged', async () => {
    await applyOperatorDefaultsToml(`
[models]
thinking_effort = "high"
`);
    const beforeToml = readFileSync(tomlPath, 'utf8');
    const beforeValues = (await getOperatorDefaults()).values;

    const response = await POST(postDefaults({ settingsToml: `
[models]
thinking_effort = "many"
` }));
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error).toBe('models.thinking_effort expected a valid thinking effort.');
    expect(readFileSync(tomlPath, 'utf8')).toBe(beforeToml);
    expect((await getOperatorDefaults()).values).toEqual(beforeValues);
  });

  it('round-trips a GUI change without dropping mapped or unknown keys', async () => {
    await applyOperatorDefaultsToml(`
# This direct-editor comment remains until a GUI rewrite.
[operator]
parallel_cap = 4
future_toggle = "keep-me"

[agent_extension]
mode = "custom"
`);

    const response = await POST(postDefaults({
      thinkingEffort: 'xhigh',
      branchPrefix: 'agent',
      requireApproval: 'always',
    }));
    const updated = await response.json();
    expect(response.status).toBe(200);
    const raw = readFileSync(tomlPath, 'utf8');
    const reparsed = parseOperatorDefaultsToml(raw);
    const rawDocument = parse(raw) as Record<string, Record<string, unknown>>;

    expect(Object.keys(reparsed).sort()).toEqual(Object.keys(OPERATOR_DEFAULTS_FALLBACK).sort());
    for (const key of Object.keys(OPERATOR_DEFAULTS_FALLBACK) as Array<keyof typeof OPERATOR_DEFAULTS_FALLBACK>) {
      expect(reparsed[key], `TOML key for ${key} evaporated`).toEqual(updated.values[key]);
    }
    expect(rawDocument.operator.future_toggle).toBe('keep-me');
    expect(rawDocument.agent_extension.mode).toBe('custom');
  });

  it('uses last-good defaults when settings.toml is unparseable', async () => {
    await applyOperatorDefaultsToml(`
[orchestrator]
backend = "claude"
`);
    writeFileSync(tomlPath, '[orchestrator\nbackend = "codex"\n');

    expect((await getOperatorDefaults()).values.orchestratorBackend).toBe('claude');
    expect(resolveOrchestratorBackendSync()).toBe('claude');
    expect(readFileSync(tomlPath, 'utf8')).toBe('[orchestrator\nbackend = "codex"\n');
  });
});
