import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/runtimes/shared/auth-detect', () => ({
  getRuntimeAuthSnapshot: vi.fn(async () => ({ statuses: {}, suggestedSubscriptionProfile: {} })),
  getDispatchableRuntimeAvailability: vi.fn(async () => []),
}));

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'o8-commentary-settings-'));
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_DATA_DIR = dataDir;

const settingsRoute = await import('@/app/api/panel/operator-defaults/route');
const { getSqlite } = await import('@/lib/db');
const { appendBroadcastEvent } = await import('@/lib/broadcast/post');
const { getOperatorDefaultsSync } = await import('@/lib/operator/defaults');
const { parseOperatorDefaultsToml } = await import('@/lib/settings/toml');
const { runBroadcastDirectorOnce, resolveBroadcastDirectorSettings } = await import('@/lib/broadcast/director');

async function save(update: Record<string, unknown>) {
  const response = await settingsRoute.POST(new Request('http://localhost/api/panel/operator-defaults', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(update),
  }));
  expect(response.status).toBe(200);
  return response.json();
}

describe('automatic commentary preference real path', () => {
  it('persists the Settings payload and disables model calls without changing voice or feed history', async () => {
    const on = await save({
      broadcastCommentary: 'interval', broadcastVoice: 'on', broadcastCommentaryMinNewEvents: 1,
    });
    const event = appendBroadcastEvent({ kind: 'conversation', actor: 'operator', text: 'Existing work stays in the feed.' });
    const off = await save({ broadcastCommentary: 'off' });
    expect(off.values).toEqual({ ...on.values, broadcastCommentary: 'off' });
    expect(parseOperatorDefaultsToml(readFileSync(path.join(dataDir, 'settings.toml'), 'utf8')))
      .toMatchObject({ broadcastCommentary: 'off', broadcastVoice: 'on' });
    expect(getOperatorDefaultsSync().values.broadcastCommentary).toBe('off');
    expect(resolveBroadcastDirectorSettings().broadcastCommentary).toBe('off');
    const runner = vi.fn(async () => 'This must not run while commentary is off.');
    await expect(runBroadcastDirectorOnce({ runner, model: 'gpt-test' }))
      .resolves.toMatchObject({ status: 'skipped', reason: 'off' });
    expect(runner).not.toHaveBeenCalled();
    expect(getSqlite().prepare('SELECT text FROM broadcast_events WHERE id = ?').get(event.id))
      .toEqual({ text: 'Existing work stays in the feed.' });

    const onAgain = await save({ broadcastCommentary: 'interval' });
    expect(onAgain.values).toEqual(on.values);
    await expect(runBroadcastDirectorOnce({ runner, model: 'gpt-test' }))
      .resolves.toMatchObject({ status: 'posted' });
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('does not publish an in-flight summary after the operator switches commentary off', async () => {
    const now = new Date(Date.now() + 10 * 60_000);
    await save({ broadcastCommentary: 'interval', broadcastCommentaryMinNewEvents: 1 });
    appendBroadcastEvent({ kind: 'conversation', actor: 'operator', text: 'New work for the next interval.' }, { now });
    const runner = vi.fn(async () => {
      await save({ broadcastCommentary: 'off' });
      return 'Discard this in-flight summary.';
    });
    await expect(runBroadcastDirectorOnce({ runner, model: 'gpt-test', now }))
      .resolves.toMatchObject({ status: 'skipped', reason: 'off' });
    expect(runner).toHaveBeenCalledTimes(1);
    expect(getSqlite().prepare('SELECT id FROM broadcast_events WHERE text = ?').get('Discard this in-flight summary.'))
      .toBeUndefined();
    expect(resolveBroadcastDirectorSettings().broadcastCommentary).toBe('off');
  });
});
