import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, beforeEach, expect, it, vi } from 'vitest';
const root = mkdtempSync(join(tmpdir(), 'o8-composer-route-'));
process.env.CORTEX_IDE_DATA_DIR = join(root, 'data');
process.env.O8_DATA_DIR = join(root, 'data');
process.env.O8_HYBRID_SCORER = '1';
process.env.GEMINI_API_KEY = 'fixture-decoy-key';
process.env.OPENAI_API_KEY = 'fixture-decoy-key';
vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Unexpected external transport'); }));
const h = vi.hoisted(() => ({ binary: '', ready: true, nativeClaude: true, managed: vi.fn(async () => 'managed answer') }));
h.binary = join(root, 'fixture-cli');
process.env.CODEX_HOME = join(root, 'codex-home');
mkdirSync(process.env.CODEX_HOME);
writeFileSync(join(process.env.CODEX_HOME, 'config.toml'), '[mcp_servers.mutating]\ncommand="fixture-never-run"\n[profiles.inactive.mcp_servers.profile_only]\ncommand="fixture-never-run"\n');
const argsFile = join(root, 'args');
const script = `#!/bin/sh
printf '%s\\n' "$@" > '${argsFile}'
output=''
previous=''
for arg in "$@"; do
  if test "$previous" = '--output-last-message'; then output="$arg"; fi
  previous="$arg"
done
cat >/dev/null
if test -f '${join(root, 'fail')}'; then exit 1; fi
if test -n "$output"; then printf 'connected answer' > "$output"; else printf '{"type":"result","subtype":"success","result":"connected answer","is_error":false}\\n'; fi
`;
writeFileSync(h.binary, script); chmodSync(h.binary, 0o700);
vi.mock('server-only', () => ({}));
vi.mock('@/lib/runtimes/shared/auth-detect', () => ({ detectRuntimeAuthStatus: vi.fn(async (runtime: string) => ({ runtime, installed: h.ready, ready: h.ready, authenticated: h.ready && (runtime !== 'claude-code' || h.nativeClaude), binaryPath: h.binary })) }));
vi.mock('@/lib/entitlement/store', async original => ({ ...await original<object>(), getEntitlementSync: () => ({ flags: { 'proxy.inference': true } }) }));
vi.mock('@/lib/repos/projects', async original => ({ ...await original<object>(), getActiveProjectScopeForRepo: vi.fn(async () => ({ projectId: null })) }));
vi.mock('@/lib/cortex/qa/llm/haiku-adapter', () => ({ prewarmHaiku: vi.fn(), callHaiku: vi.fn() }));
vi.mock('@/lib/cortex/qa/llm/sonnet-adapter', () => ({ prewarmSonnetCli: vi.fn(), callSonnet: vi.fn() }));
vi.mock('@/lib/cortex/qa/llm/openrouter-adapter', () => ({ callOpenRouter: h.managed, OPENROUTER_PRIMARY_MODEL: 'fixture-managed' }));
vi.mock('@/lib/cortex/qa/llm/brain-spend', () => ({ withBrainRetrievalUsage: (_q: unknown, _c: unknown, run: () => unknown) => run() }));
vi.mock('@/lib/cortex/qa/contradictions', () => ({ detectContradictions: vi.fn(async () => []) }));
const { updateOperatorDefaults } = await import('@/lib/operator/defaults');
const { POST } = await import('@/app/api/cortex/ask/route');
const { listRoleRoutingReceipts } = await import('@/lib/operator/role-routing-ledger');
const { invalidateAnswerCache } = await import('@/lib/cortex/qa/ask');
const { MODEL_IDS } = await import('@/lib/models');
async function ask(preferredRuntime: string) {
  return (await POST(new NextRequest('http://localhost/api/cortex/ask', { method: 'POST', body: JSON.stringify({ question: 'Explain the current plan.', conversation: true, preferredRuntime, bypassCache: true }) }))).text();
}
beforeEach(async () => {
  h.ready = true; h.nativeClaude = true; h.managed.mockClear(); vi.mocked(fetch).mockClear(); invalidateAnswerCache(); rmSync(join(root, 'fail'), { force: true });
  await updateOperatorDefaults({ subscriptionProfile: 'both', brainRoutingMode: 'auto', brainUseClaudeCli: true, brainCodexModel: MODEL_IDS.codexWorkerDefault });
});
afterAll(() => { vi.unstubAllGlobals(); rmSync(root, { recursive: true, force: true }); });
it('answers through the actual selected Codex binary and persists its model route instead of managed inference', async () => {
  expect(await ask('codex')).toContain('connected answer');
  const args = readFileSync(argsFile, 'utf8'); expect(args).toContain(MODEL_IDS.codexWorkerDefault); expect(args).toContain('--sandbox\nread-only'); expect(args).toContain('--ignore-user-config'); expect(args).toContain('--disable\napps'); expect(args).toContain('--disable\nplugins'); expect(args).toContain('tools.image_generation=false');
  expect(h.managed).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  expect(listRoleRoutingReceipts({ role: 'brain' }).some(r => r.contextType === 'brain-conversation' && r.effective?.model === MODEL_IDS.codexWorkerDefault)).toBe(true);
});
it('uses Sonnet through the actual Claude REPL with tools disabled', async () => {
  const stream = await ask('claude'); expect(stream).toContain('connected answer'); expect(stream).toContain('"runtime":"claude-code"');
  const args = readFileSync(argsFile, 'utf8'); expect(args).toContain(MODEL_IDS.claudeQaDefault); expect(args).toContain('--tools\n\n--strict-mcp-config'); expect(args).not.toContain('--print'); expect(args).toContain('--setting-sources\n\n--disable-slash-commands'); expect(h.managed).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
});
it('uses managed inference only when a connected answer runtime is unavailable', async () => {
  h.ready = false; expect(await ask('codex')).toContain('managed answer'); expect(h.managed).toHaveBeenCalled();
});
it('does not silently change payer after a connected runtime failure', async () => {
  writeFileSync(join(root, 'fail'), '1'); const stream = await ask('codex'); expect(stream).toContain('event: error'); expect(h.managed).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
});

it('skips gateway-only Claude readiness when native Claude is not signed in', async () => {
  h.nativeClaude = false; const stream = await ask('claude'); expect(stream).toContain('"runtime":"codex"'); expect(stream).toContain('connected answer');
});
it('keeps concurrent native request routes isolated', async () => {
  const [codex, claude] = await Promise.all([ask('codex'), ask('claude')]);
  expect(codex).toContain('"runtime":"codex"'); expect(codex).not.toContain('"runtime":"claude-code"');
  expect(claude).toContain('"runtime":"claude-code"'); expect(claude).not.toContain('"runtime":"codex"');
  expect(codex).toContain('connected answer'); expect(claude).toContain('connected answer');
  expect(h.managed).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
});
it('preserves a persisted explicit Brain model for Codex', async () => {
  await updateOperatorDefaults({ brainCodexModel: MODEL_IDS.codexCliDefault });
  const stream = await ask('codex'); expect(stream).toContain(MODEL_IDS.codexCliDefault);
  expect(readFileSync(argsFile, 'utf8')).toContain(MODEL_IDS.codexCliDefault);
});
