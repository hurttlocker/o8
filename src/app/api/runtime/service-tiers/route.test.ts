import { NextRequest, NextResponse } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ denied: false, native: true, catalogue: vi.fn(async () => ({ models: { supported: [{ id: 'default', label: 'Standard' }, { id: 'ultrafast', label: 'Ultra-fast' }] } })) }));
vi.mock('@/lib/panel/auth', () => ({ requirePanelAuth: () => state.denied ? NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) : null }));
vi.mock('@/lib/codex/service-tier-catalogue', () => ({ getCodexSpeedCatalogue: state.catalogue }));
vi.mock('@/lib/claude-code/worker-profile', () => ({ readClaudeCodeWorkerProfileSync: () => ({ source: state.native ? 'native' : 'openrouter' }) }));
vi.mock('node:fs/promises', () => ({ readFile: async () => '{"fastMode":false}' }));
import { GET } from './route';
import { codexServiceTierOptions, serviceTierForTurn } from '@/lib/orchestrator/service-tier';
describe('service-tier API and routing boundaries', () => {
  beforeEach(() => { state.denied = false; state.native = true; state.catalogue.mockClear(); });
  afterEach(() => vi.unstubAllEnvs());
  const request = (backend: string, model: string) => GET(new NextRequest(`http://localhost/api/runtime/service-tiers?${new URLSearchParams({ backend, model })}`));
  it('denies before probing the CLI', async () => { state.denied = true; expect((await request('codex', 'supported')).status).toBe(401); expect(state.catalogue).not.toHaveBeenCalled(); });
  it('advertises only the selected model account catalogue', async () => {
    expect((await (await request('codex', 'supported')).json()).options.map((option: { id: string }) => option.id)).toEqual(['default', 'ultrafast']);
    expect((await (await request('codex', 'missing')).json()).options).toEqual([{ id: 'default', label: 'Standard' }]);
  });
  it.each(['claude-opus-5-5', 'claude-opus-5', 'claude-opus-4-8'])('shows native Fast for %s with the paid-credit explanation', async (model) => {
    const data = await (await request('claude', model)).json(); expect(data.options[1]).toMatchObject({ id: 'fast', description: expect.stringContaining('paid Claude usage credits') });
  });
  it('hides Fast for other models, API carriers and explicitly disabled installations', async () => {
    expect((await (await request('claude', 'claude-sonnet-5')).json()).options).toHaveLength(1);
    state.native = false; expect((await (await request('claude', 'claude-opus-5-5')).json()).options).toHaveLength(1);
    state.native = true; vi.stubEnv('CLAUDE_CODE_DISABLE_FAST_MODE', '1'); expect((await (await request('claude', 'claude-opus-5-5')).json()).options).toHaveLength(1);
  });
  it('uses older speed metadata when the new list is empty and drops invalid tiers', () => {
    expect(codexServiceTierOptions({ serviceTiers: [], additionalSpeedTiers: ['priority', 'priority', 'unsupported'] }).map((tier) => tier.id)).toEqual(['default', 'priority']);
  });
  it('does not carry a paid choice across a backend or model fallback', () => {
    expect(serviceTierForTurn('ultrafast', 'codex', 'one', 'claude', 'two')).toBe('default');
    expect(serviceTierForTurn('priority', 'codex', 'one', 'codex', 'two')).toBe('default');
    expect(serviceTierForTurn('priority', 'codex', 'one', 'codex', 'one')).toBe('priority');
    expect(serviceTierForTurn(undefined, 'codex', 'one', 'claude', 'two')).toBeUndefined();
  });
});
