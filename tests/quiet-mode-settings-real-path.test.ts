/**
 * Real-path coverage for the two settings added by #2147 and #2150.
 *
 * Driven through the ACTUAL operator-defaults route handler against a real
 * settings.toml on disk — not through the validators in isolation. Both new keys
 * have to survive seven declaration surfaces, and a missing one fails silently:
 * the POST returns 200, the UI shows the click, and nothing persists. Asserting
 * the round trip through the entry point every caller uses is the only thing
 * that catches that.
 *
 * The MCP half is split: the tool schema is asserted here, and the handler round
 * trip runs in tests/operator-defaults-mcp-routing.test.ts, which owns the fetch
 * harness the MCP transport needs to reach the route without a live server.
 */

import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/runtimes/shared/auth-detect', () => ({
  getRuntimeAuthSnapshot: vi.fn(async () => ({ statuses: {}, suggestedSubscriptionProfile: {} })),
  getDispatchableRuntimeAvailability: vi.fn(async () => []),
}));

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'o8-quiet-mode-settings-'));
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_DATA_DIR = dataDir;

const settingsRoute = await import('@/app/api/panel/operator-defaults/route');
const { getOperatorDefaultsSync } = await import('@/lib/operator/defaults');
const { parseOperatorDefaultsToml } = await import('@/lib/settings/toml');
const { shouldDeliverReviewNotification } = await import('@/lib/operator/presentation-defaults');

const SETTINGS_TOML = path.join(dataDir, 'settings.toml');

async function post(update: Record<string, unknown>) {
  const response = await settingsRoute.POST(new Request('http://localhost/api/panel/operator-defaults', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(update),
  }));
  const payload = await response.json() as { values?: Record<string, unknown>; error?: string };
  return { status: response.status, payload };
}

describe('quiet mode and review-notification settings real path', () => {
  it('defaults to quiet mode off and review notifications on', async () => {
    const response = await settingsRoute.GET(new Request('http://localhost/api/panel/operator-defaults'));
    const payload = await response.json() as {
      values: Record<string, unknown>;
      sources: Record<string, string>;
    };
    expect(payload.values.presentationQuietMode).toBe(false);
    expect(payload.values.notificationsReviewReady).toBe('on');
    // Existing installs must not lose the banner by upgrading into this change.
    expect(payload.sources.notificationsReviewReady).toBe('default');
    expect(payload.sources.presentationQuietMode).toBe('default');
  });

  it('persists both keys to settings.toml under presentation.* and notifications.*', async () => {
    const on = await post({ presentationQuietMode: true, notificationsReviewReady: 'off' });
    expect(on.status).toBe(200);
    expect(on.payload.values).toMatchObject({
      presentationQuietMode: true,
      notificationsReviewReady: 'off',
    });

    const toml = readFileSync(SETTINGS_TOML, 'utf8');
    expect(toml).toContain('[presentation]');
    expect(toml).toContain('[notifications]');
    expect(parseOperatorDefaultsToml(toml)).toMatchObject({
      presentationQuietMode: true,
      notificationsReviewReady: 'off',
    });

    // The sync reader is what the lane chokepoint consults on every flip.
    const sync = getOperatorDefaultsSync().values;
    expect(sync.presentationQuietMode).toBe(true);
    expect(sync.notificationsReviewReady).toBe('off');

    const off = await post({ presentationQuietMode: false, notificationsReviewReady: 'on' });
    expect(off.payload.values).toMatchObject({
      presentationQuietMode: false,
      notificationsReviewReady: 'on',
    });
    expect(getOperatorDefaultsSync().values.presentationQuietMode).toBe(false);
  });

  it('rejects a malformed value without applying a partial update', async () => {
    await post({ notificationsReviewReady: 'on', presentationQuietMode: false });

    const bad = await post({ notificationsReviewReady: 'sometimes' });
    expect(bad.status).not.toBe(200);
    expect(bad.payload.error).toContain('notificationsReviewReady');
    expect(getOperatorDefaultsSync().values.notificationsReviewReady).toBe('on');

    const badQuiet = await post({ presentationQuietMode: 'yes' });
    expect(badQuiet.status).not.toBe(200);
    expect(getOperatorDefaultsSync().values.presentationQuietMode).toBe(false);
  });

  it('lets quiet mode outrank an explicitly-on review notification setting', async () => {
    await post({ presentationQuietMode: true, notificationsReviewReady: 'on' });
    expect(shouldDeliverReviewNotification(getOperatorDefaultsSync().values)).toBe(false);

    await post({ presentationQuietMode: false });
    expect(shouldDeliverReviewNotification(getOperatorDefaultsSync().values)).toBe(true);

    await post({ notificationsReviewReady: 'off' });
    expect(shouldDeliverReviewNotification(getOperatorDefaultsSync().values)).toBe(false);
  });

  it('advertises both keys on the registered MCP tool schema', async () => {
    // The handler round trip (schema -> handler -> settings.toml) is driven in
    // tests/operator-defaults-mcp-routing.test.ts, which owns the fetch harness
    // the MCP transport needs. What belongs here is the registration itself: a
    // key missing from the tool schema is accepted by the route and rejected by
    // MCP, and the two surfaces drift silently.
    const { STATUS_TOOLS } = await import('@/lib/mcp/operator-handlers/status');
    const tool = STATUS_TOOLS.find((candidate) => candidate.name === 'o8_operator_defaults');
    const properties = tool?.inputSchema.properties as Record<string, unknown> | undefined;
    expect(properties).toMatchObject({
      presentationQuietMode: expect.objectContaining({ type: 'boolean' }),
      notificationsReviewReady: expect.objectContaining({ type: 'string', enum: ['off', 'on'] }),
    });
  });
});
