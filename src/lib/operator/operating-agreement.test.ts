import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { withOperatingAgreement } from './operating-agreement';

const fake = vi.hoisted(() => ({ sendTurn: vi.fn(async () => {}), peekSession: vi.fn(), ensureSession: vi.fn(), stopTurn: vi.fn(), killSession: vi.fn() }));
vi.mock('@/lib/lane/orchestrator-backends/claude', () => ({ claudeBackend: { ...fake, id: 'claude' } }));
vi.mock('@/lib/lane/orchestrator-backends/codex', () => ({ codexBackend: { ...fake, id: 'codex' } }));
vi.mock('@/lib/lane/orchestrator-backends/openclaw', () => ({ openclawBackend: { ...fake, id: 'openclaw' } }));
vi.mock('@/lib/lane/orchestrator-backends/acp', () => ({ acpBackend: { ...fake, id: 'acp' }, hermesBackend: { ...fake, id: 'hermes' }, opencodeBackend: { ...fake, id: 'opencode' } }));
vi.mock('@/lib/lane/orchestrator-backends/moa', () => ({ collideBackend: { ...fake, id: 'collide' } }));
vi.mock('@/lib/lane/orchestrator-backends/fable', () => ({ fableBackend: { ...fake, id: 'fable' } }));
vi.mock('@/lib/lane/orchestrator-backends/o8', () => ({ o8Backend: { ...fake, id: 'o8' } }));
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });
it('is optional and reads the current private file on every turn without duplicating it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'o8-agreement-'));
  vi.stubEnv('O8_DATA_DIR', dir);
  expect(withOperatingAgreement('task')).toBe('task');
  writeFileSync(join(dir, 'OPERATING_AGREEMENT.md'), 'Local preference A');
  const first = withOperatingAgreement('task');
  expect(first).toContain('Local preference A');
  expect(withOperatingAgreement(first)).toBe(first);
  writeFileSync(join(dir, 'OPERATING_AGREEMENT.md'), 'Local preference B');
  expect(withOperatingAgreement('next task')).toContain('Local preference B');
  writeFileSync(join(dir, 'OPERATING_AGREEMENT.md'), 'x'.repeat(32_769));
  expect(() => withOperatingAgreement('task')).toThrow('32 KiB');
});

it('delivers the current owner agreement through every registered orchestrator entry before work', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'o8-agreement-registry-'));
  vi.stubEnv('O8_DATA_DIR', dir);
  writeFileSync(join(dir, 'OPERATING_AGREEMENT.md'), 'Owner preference');
  const { getOrchestratorBackend } = await import('@/lib/lane/orchestrator-backends/registry');
  for (const id of ['codex', 'claude', 'fable', 'opencode', 'openclaw', 'hermes', 'acp', 'collide', 'o8'] as const) {
    await getOrchestratorBackend(id).sendTurn('/fixture', 'task', () => {}, {});
    expect(fake.sendTurn).toHaveBeenLastCalledWith('/fixture', expect.stringContaining('Owner preference'), expect.any(Function), {});
  }
  writeFileSync(join(dir, 'OPERATING_AGREEMENT.md'), 'Edited preference');
  await getOrchestratorBackend('codex').sendTurn('/fixture', 'next', () => {}, { orchestrationMode: 'single' });
  expect(fake.sendTurn).toHaveBeenLastCalledWith('/fixture', expect.stringContaining('Edited preference'), expect.any(Function), expect.objectContaining({ toolProfile: 'solo' }));
});
