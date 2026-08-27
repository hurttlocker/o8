import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { getDataDir } from '@/lib/data-dir-migration';
import type { ShippedButDarkAudit } from '@/lib/operator/shipped-dark-audit';
import {
  currentShippedDarkAuditStatus,
  ensureShippedDarkAuditBootHook,
  readShippedDarkAuditReceipt,
  runShippedDarkAudit,
  SHIPPED_DARK_AUDIT_INTERVAL_MS,
} from '@/lib/operator/shipped-dark-scheduler';

const audit: ShippedButDarkAudit = {
  currentRelease: '0.1.716',
  checkedFlags: [{
    key: 'experimentalChat',
    tomlKey: 'experimental.chat_enabled',
    codeDefault: false,
    operatorValue: false,
    operatorValueSource: 'default',
    defaultFile: 'src/lib/operator/defaults.ts',
    landedRelease: '0.1.681',
    darkForReleases: 35,
  }, {
    key: 'nativeBrowserView',
    tomlKey: 'experimental.native_browser_view',
    codeDefault: true,
    operatorValue: true,
    operatorValueSource: 'default',
    defaultFile: 'src/lib/operator/defaults.ts',
    landedRelease: '0.1.681',
    darkForReleases: 35,
  }],
  flags: [{
    key: 'experimentalChat',
    tomlKey: 'experimental.chat_enabled',
    codeDefault: false,
    operatorValue: false,
    operatorValueSource: 'default',
    defaultFile: 'src/lib/operator/defaults.ts',
    landedRelease: '0.1.681',
    darkForReleases: 35,
  }],
};

describe('scheduled shipped-dark audit real path', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('persists an atomic receipt and projects the warning after restart-style reread', async () => {
    const checkedAt = new Date('2026-08-27T12:05:00.000Z');
    await runShippedDarkAudit({ now: checkedAt, audit: async () => audit });

    expect(JSON.parse(readFileSync(join(getDataDir(), 'shipped-dark-audit.json'), 'utf8'))).toMatchObject({
      schema: 'o8/shipped-dark-audit/v1',
      checkedAt: checkedAt.toISOString(),
      thresholdReleases: 3,
    });
    expect(readShippedDarkAuditReceipt()?.audit.checkedFlags).toHaveLength(2);
    expect(currentShippedDarkAuditStatus()).toMatchObject({
      status: 'attention',
      checkedFlagCount: 2,
      flags: [{
        tomlKey: 'experimental.chat_enabled',
        landedRelease: '0.1.681',
        darkForReleases: 35,
      }],
    });
  });

  it('runs immediately at launch and again on the daily interval', async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => runShippedDarkAudit({ audit: async () => audit }));
    ensureShippedDarkAuditBootHook({ run });

    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(SHIPPED_DARK_AUDIT_INTERVAL_MS);
    expect(run).toHaveBeenCalledTimes(2);
  });
});
