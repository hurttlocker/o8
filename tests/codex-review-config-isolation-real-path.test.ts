/**
 * Real reviewer-entry regression for #3016.
 *
 * The fake CLI is the only process stub. The test drives the production review
 * wrapper, backend registry, Codex session launcher, generated CODEX_HOME, and
 * persisted review-turn receipts. Speculative provider prewarms are disabled so
 * this fixture cannot make a provider request.
 */

import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parse } from 'smol-toml';
import { afterAll, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/cortex/qa/llm/haiku-adapter', () => ({
  prewarmHaiku: vi.fn(async () => {}),
}));
vi.mock('@/lib/cortex/qa/llm/sonnet-adapter', () => ({
  prewarmSonnetCli: vi.fn(async () => {}),
}));

const root = mkdtempSync(join(tmpdir(), 'o8-review-config-isolation-'));
const home = join(root, 'home');
const userCodexHome = join(home, '.codex');
const dataDir = join(root, 'data');
const repoPath = join(root, 'repo');
const fakeCodexBin = join(root, 'codex-fixture');
const generatedHomeReceipt = join(root, 'generated-codex-home.txt');
const priorEnv = new Map<string, string | undefined>();
const envKeys = [
  'HOME',
  'O8_DATA_DIR',
  'CORTEX_IDE_DATA_DIR',
  'O8_CODEX_BIN',
  'O8_CRASH_SURVIVABLE_ORCHESTRATOR',
  'O8_TEST_CODEX_HOME_RECEIPT',
] as const;
for (const key of envKeys) priorEnv.set(key, process.env[key]);

mkdirSync(userCodexHome, { recursive: true });
mkdirSync(dataDir, { recursive: true });
mkdirSync(repoPath, { recursive: true });
writeFileSync(join(userCodexHome, 'config.toml'), [
  'model_provider = "fixture-provider"',
  '',
  '[features]',
  'web_search = false',
  '',
  '[model_providers.fixture-provider]',
  'name = "Fixture provider"',
  'base_url = "http://127.0.0.1:43123/v1"',
  '',
  '[projects."/tmp/review-fixture"]',
  'trust_level = "trusted"',
  '',
  '[mcp_servers."poison-reviewer"]',
  'command = "fixture-must-not-run"',
].join('\n'));
writeFileSync(fakeCodexBin, [
  '#!/bin/sh',
  'if [ "$1" = "--version" ]; then',
  '  printf "codex-cli 0.150.0\\n"',
  '  exit 0',
  'fi',
  'printf "%s" "$CODEX_HOME" > "$O8_TEST_CODEX_HOME_RECEIPT"',
  'if grep -q "poison-reviewer" "$CODEX_HOME/config.toml"; then',
  '  printf "unrelated MCP reached reviewer\\n" >&2',
  '  exit 86',
  'fi',
  'printf "%s\\n" \'{"type":"thread.started","thread_id":"fixture-review-thread"}\'',
  'printf "%s\\n" \'{"type":"item.completed","item":{"type":"agent_message","text":"CODEX_AUTO_REVIEW: {\\"approved\\":true,\\"findings\\":[]}"}}\'',
  'printf "%s\\n" \'{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}\'',
].join('\n'), { mode: 0o700 });
chmodSync(fakeCodexBin, 0o700);

execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoPath });
writeFileSync(join(repoPath, 'README.md'), '# review fixture\n');
execFileSync('git', ['add', 'README.md'], { cwd: repoPath });
execFileSync('git', [
  '-c', 'user.name=o8 test',
  '-c', 'user.email=test@o8.local',
  'commit', '-qm', 'test: review fixture',
], { cwd: repoPath });

process.env.HOME = home;
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_CODEX_BIN = fakeCodexBin;
process.env.O8_CRASH_SURVIVABLE_ORCHESTRATOR = '1';
process.env.O8_TEST_CODEX_HOME_RECEIPT = generatedHomeReceipt;

const { closeDb } = await import('@/lib/db');
const { getLaneEvents, createLane } = await import('@/lib/lane/registry');
const { getOrchestratorBackend } = await import('@/lib/lane/orchestrator-backends/registry');
const { runReviewerTurnWithQuotaFallback } = await import('@/lib/lane/review-quota-fallback');
const { listRoleRoutingReceipts } = await import('@/lib/operator/role-routing-ledger');

afterAll(() => {
  closeDb();
  for (const [key, value] of priorEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

describe('Codex automatic-review config isolation', () => {
  it('launches through the reviewer entry point with only app-emitted MCP servers', async () => {
    const lane = createLane({
      repoPath,
      worktreePath: repoPath,
      branch: 'inline/review-config-isolation',
      baseBranch: 'main',
      runtime: 'codex',
      packetId: 'pkt-review-config-isolation',
    });
    const codex = getOrchestratorBackend('codex');

    const result = await runReviewerTurnWithQuotaFallback({
      laneId: lane.id,
      repoPath,
      threadId: `auto-review-${lane.id}-config-isolation`,
      surface: 'auto-review',
      prompt: 'Review the complete packet.',
      initialBackend: codex,
      backendResolver: () => codex,
    });

    expect(result).toMatchObject({
      ok: true,
      backend: 'codex',
      text: 'CODEX_AUTO_REVIEW: {"approved":true,"findings":[]}',
      errors: [],
    });

    const generatedHome = readFileSync(generatedHomeReceipt, 'utf8');
    const generated = parse(readFileSync(join(generatedHome, 'config.toml'), 'utf8')) as {
      features?: Record<string, unknown>;
      model_providers?: Record<string, unknown>;
      projects?: Record<string, unknown>;
      mcp_servers?: Record<string, unknown>;
    };
    expect(generated.features).toEqual({ web_search: false });
    expect(generated.model_providers).toHaveProperty('fixture-provider');
    expect(generated.projects).toHaveProperty('/tmp/review-fixture');
    expect(generated.mcp_servers).not.toHaveProperty('poison-reviewer');
    expect(generated.mcp_servers).toEqual(expect.objectContaining({
      operator: expect.any(Object),
      cortex: expect.any(Object),
    }));

    expect(getLaneEvents(lane.id).findLast((event) => event.verb === 'review_turn_finished')).toMatchObject({
      payload: { outcome: 'completed' },
    });
    expect(listRoleRoutingReceipts({ role: 'review', repoPath })[0]).toMatchObject({
      contextType: 'auto-review',
      contextId: lane.id,
      status: 'selected',
    });
  });
});
