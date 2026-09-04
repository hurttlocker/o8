import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { getDataDir } from '@/lib/data-dir-migration';
import type { ShippedButDarkAudit, ShippedButDarkFlag } from '@/lib/operator/shipped-dark-audit';
import {
  currentShippedDarkAuditStatus,
  ensureShippedDarkAuditBootHook,
  readShippedDarkAuditReceipt,
  runShippedDarkAudit,
  SHIPPED_DARK_AUDIT_INTERVAL_MS,
  SHIPPED_DARK_WARNING_RELEASES,
} from '@/lib/operator/shipped-dark-scheduler';

const deliberateFlag: ShippedButDarkFlag = {
  key: 'experimentalChat',
  tomlKey: 'experimental.chat_enabled',
  codeDefault: false,
  operatorValue: false,
  operatorValueSource: 'default',
  defaultFile: 'src/lib/operator/defaults.ts',
  landedRelease: '0.1.681',
  darkForReleases: 35,
  lifecycle: 'deliberate-default-off',
  lifecycleRationale: 'Alpha-only casual chat tab.',
};

const candidateFlag: ShippedButDarkFlag = {
  key: 'experimentalCanvas',
  tomlKey: 'experimental.canvas_enabled',
  codeDefault: false,
  operatorValue: false,
  operatorValueSource: 'default',
  defaultFile: 'src/lib/operator/defaults.ts',
  landedRelease: '0.1.700',
  darkForReleases: 16,
  lifecycle: 'promotion-candidate',
  lifecycleRationale: null,
};

const promotedFlag: ShippedButDarkFlag = {
  key: 'nativeBrowserView',
  tomlKey: 'experimental.native_browser_view',
  codeDefault: true,
  operatorValue: true,
  operatorValueSource: 'default',
  defaultFile: 'src/lib/operator/defaults.ts',
  landedRelease: '0.1.681',
  darkForReleases: 35,
  lifecycle: 'promoted',
  lifecycleRationale: null,
};

const audit: ShippedButDarkAudit = {
  currentRelease: '0.1.716',
  checkedFlags: [deliberateFlag, candidateFlag, promotedFlag],
  flags: [deliberateFlag, candidateFlag],
};

const deliberateOnlyAudit: ShippedButDarkAudit = {
  currentRelease: '0.1.716',
  checkedFlags: [deliberateFlag, promotedFlag],
  flags: [deliberateFlag],
};

describe('scheduled shipped-dark audit real path', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('persists an atomic receipt and warns only for the aged promotion candidate', async () => {
    const checkedAt = new Date('2026-08-27T12:05:00.000Z');
    await runShippedDarkAudit({ now: checkedAt, audit: async () => audit });

    expect(JSON.parse(readFileSync(join(getDataDir(), 'shipped-dark-audit.json'), 'utf8'))).toMatchObject({
      schema: 'o8/shipped-dark-audit/v2',
      checkedAt: checkedAt.toISOString(),
      thresholdReleases: SHIPPED_DARK_WARNING_RELEASES,
    });
    expect(readShippedDarkAuditReceipt()?.audit.checkedFlags).toHaveLength(3);

    const status = currentShippedDarkAuditStatus();
    expect(status).toMatchObject({
      schema: 'o8/shipped-dark-audit-status/v2',
      status: 'attention',
      checkedFlagCount: 3,
      attentionFlagCount: 1,
    });
    // The deliberate flag is older than the candidate and still does not warn.
    expect(status.flags).toEqual([
      expect.objectContaining({
        tomlKey: 'experimental.chat_enabled',
        darkForReleases: 35,
        lifecycle: 'deliberate-default-off',
        lifecycleRationale: 'Alpha-only casual chat tab.',
        needsAttention: false,
      }),
      expect.objectContaining({
        tomlKey: 'experimental.canvas_enabled',
        darkForReleases: 16,
        lifecycle: 'promotion-candidate',
        needsAttention: true,
      }),
    ]);
  });

  it('keeps a long-dark deliberate flag visible without raising attention', async () => {
    await runShippedDarkAudit({ audit: async () => deliberateOnlyAudit });

    const status = currentShippedDarkAuditStatus();
    expect(status.status).toBe('current');
    expect(status.attentionFlagCount).toBe(0);
    expect(status.checkedFlagCount).toBe(2);
    expect(status.flags.map((flag) => flag.tomlKey)).toEqual(['experimental.chat_enabled']);
    expect(status.flags[0]).toMatchObject({
      codeDefault: false,
      operatorValue: false,
      operatorValueSource: 'default',
      landedRelease: '0.1.681',
      darkForReleases: 35,
      lifecycle: 'deliberate-default-off',
      needsAttention: false,
    });
  });

  it('accepts every real operator value source, including profile defaults', async () => {
    const profileFlag: ShippedButDarkFlag = {
      ...deliberateFlag,
      operatorValueSource: 'profile',
    };
    await runShippedDarkAudit({
      audit: async () => ({
        currentRelease: '0.1.716',
        checkedFlags: [profileFlag],
        flags: [profileFlag],
      }),
    });

    expect(readShippedDarkAuditReceipt()?.audit.flags[0]?.operatorValueSource).toBe('profile');
    expect(currentShippedDarkAuditStatus()).toMatchObject({
      status: 'current',
      checkedFlagCount: 1,
      flags: [expect.objectContaining({ operatorValueSource: 'profile', needsAttention: false })],
    });
  });

  it('discards a legacy or malformed receipt instead of trusting its verdict', async () => {
    const target = join(getDataDir(), 'shipped-dark-audit.json');
    await runShippedDarkAudit({ audit: async () => audit });

    // v1 receipts predate the lifecycle field, so their flags carry no
    // disposition and cannot be classified after the fact.
    const legacy = {
      schema: 'o8/shipped-dark-audit/v1',
      checkedAt: '2026-08-01T00:00:00.000Z',
      thresholdReleases: SHIPPED_DARK_WARNING_RELEASES,
      audit: {
        currentRelease: '0.1.700',
        checkedFlags: [{ ...deliberateFlag, lifecycle: undefined, lifecycleRationale: undefined }],
        flags: [{ ...deliberateFlag, lifecycle: undefined, lifecycleRationale: undefined }],
      },
    };
    writeFileSync(target, `${JSON.stringify(legacy)}\n`, 'utf8');
    expect(readShippedDarkAuditReceipt()).toBeNull();
    expect(currentShippedDarkAuditStatus()).toMatchObject({
      status: 'unverified',
      checkedFlagCount: 0,
      attentionFlagCount: 0,
      flags: [],
    });

    // A current-schema receipt carrying an unknown lifecycle is equally untrusted.
    writeFileSync(target, `${JSON.stringify({
      schema: 'o8/shipped-dark-audit/v2',
      checkedAt: '2026-08-27T12:05:00.000Z',
      thresholdReleases: SHIPPED_DARK_WARNING_RELEASES,
      audit: {
        currentRelease: '0.1.716',
        checkedFlags: [{ ...deliberateFlag, lifecycle: 'retired' }],
        flags: [{ ...deliberateFlag, lifecycle: 'retired' }],
      },
    })}\n`, 'utf8');
    expect(readShippedDarkAuditReceipt()).toBeNull();
    expect(currentShippedDarkAuditStatus().status).toBe('unverified');

    writeFileSync(target, '{not json', 'utf8');
    expect(readShippedDarkAuditReceipt()).toBeNull();
    expect(currentShippedDarkAuditStatus().status).toBe('unverified');
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
