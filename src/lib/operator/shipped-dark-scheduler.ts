import 'server-only';

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { getDataDir } from '@/lib/data-dir-migration';
import type { SettingSource } from './defaults';
import {
  auditShippedButDarkFlags,
  isOverdueShippedDarkFlag,
  type ShippedButDarkAudit,
  type ShippedButDarkFlag,
} from './shipped-dark-audit';
import { isShippedDarkLifecycle, type ShippedDarkLifecycle } from './shipped-dark-manifest';

export const SHIPPED_DARK_WARNING_RELEASES = 3;
export const SHIPPED_DARK_AUDIT_INTERVAL_MS = 24 * 60 * 60 * 1000;

const RECEIPT_SCHEMA = 'o8/shipped-dark-audit/v2' as const;
const STATUS_SCHEMA = 'o8/shipped-dark-audit-status/v2' as const;
const RECEIPT_FILE = 'shipped-dark-audit.json';

export interface ShippedDarkAuditReceipt {
  schema: typeof RECEIPT_SCHEMA;
  checkedAt: string;
  thresholdReleases: number;
  audit: ShippedButDarkAudit;
}

export interface ShippedDarkFlagStatus {
  tomlKey: string;
  codeDefault: unknown;
  operatorValue: unknown;
  operatorValueSource: ShippedButDarkFlag['operatorValueSource'];
  landedRelease: string | null;
  darkForReleases: number | null;
  lifecycle: ShippedDarkLifecycle;
  lifecycleRationale: string | null;
  /** True only for aged, unreviewed promotion candidates. */
  needsAttention: boolean;
}

export interface ShippedDarkAuditStatus {
  schema: typeof STATUS_SCHEMA;
  status: 'unverified' | 'current' | 'attention';
  checkedAt: string;
  currentRelease: string | null;
  thresholdReleases: number;
  checkedFlagCount: number;
  attentionFlagCount: number;
  flags: ShippedDarkFlagStatus[];
}

/** Every source `getOperatorDefaults` can report, so a valid receipt is kept. */
const SETTING_SOURCES: readonly SettingSource[] = ['env', 'file', 'profile', 'default'];

function isSettingSource(value: unknown): value is SettingSource {
  return typeof value === 'string' && (SETTING_SOURCES as readonly string[]).includes(value);
}

function receiptPath(): string {
  return join(getDataDir(), RECEIPT_FILE);
}

function isFlag(value: unknown): value is ShippedButDarkFlag {
  if (!value || typeof value !== 'object') return false;
  const flag = value as Partial<ShippedButDarkFlag>;
  return typeof flag.key === 'string'
    && typeof flag.tomlKey === 'string'
    && Object.prototype.hasOwnProperty.call(flag, 'codeDefault')
    && Object.prototype.hasOwnProperty.call(flag, 'operatorValue')
    && isSettingSource(flag.operatorValueSource)
    && typeof flag.defaultFile === 'string'
    && (flag.landedRelease === null || typeof flag.landedRelease === 'string')
    && (flag.darkForReleases === null
      || (typeof flag.darkForReleases === 'number' && Number.isInteger(flag.darkForReleases)))
    && isShippedDarkLifecycle(flag.lifecycle)
    && (flag.lifecycleRationale === null || typeof flag.lifecycleRationale === 'string');
}

function isAudit(value: unknown): value is ShippedButDarkAudit {
  if (!value || typeof value !== 'object') return false;
  const audit = value as Partial<ShippedButDarkAudit>;
  return (audit.currentRelease === null || typeof audit.currentRelease === 'string')
    && Array.isArray(audit.checkedFlags)
    && audit.checkedFlags.every(isFlag)
    && Array.isArray(audit.flags)
    && audit.flags.every(isFlag);
}

export function recordShippedDarkAudit(
  audit: ShippedButDarkAudit,
  checkedAt: string = new Date().toISOString(),
): ShippedDarkAuditReceipt {
  const receipt: ShippedDarkAuditReceipt = {
    schema: RECEIPT_SCHEMA,
    checkedAt,
    thresholdReleases: SHIPPED_DARK_WARNING_RELEASES,
    audit,
  };
  const directory = getDataDir();
  const target = receiptPath();
  const temporary = `${target}.${process.pid}.tmp`;
  mkdirSync(directory, { recursive: true });
  writeFileSync(temporary, `${JSON.stringify(receipt)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(temporary, target);
  return receipt;
}

export function readShippedDarkAuditReceipt(): ShippedDarkAuditReceipt | null {
  try {
    const parsed = JSON.parse(readFileSync(receiptPath(), 'utf8')) as Partial<ShippedDarkAuditReceipt>;
    if (parsed.schema !== RECEIPT_SCHEMA) return null;
    if (typeof parsed.checkedAt !== 'string' || !parsed.checkedAt.trim()) return null;
    if (parsed.thresholdReleases !== SHIPPED_DARK_WARNING_RELEASES) return null;
    if (!isAudit(parsed.audit)) return null;
    return parsed as ShippedDarkAuditReceipt;
  } catch {
    return null;
  }
}

function projectFlag(
  flag: ShippedButDarkFlag,
  thresholdReleases: number,
): ShippedDarkFlagStatus {
  return {
    tomlKey: flag.tomlKey,
    codeDefault: flag.codeDefault,
    operatorValue: flag.operatorValue,
    operatorValueSource: flag.operatorValueSource,
    landedRelease: flag.landedRelease,
    darkForReleases: flag.darkForReleases,
    lifecycle: flag.lifecycle,
    lifecycleRationale: flag.lifecycleRationale,
    needsAttention: isOverdueShippedDarkFlag(flag, thresholdReleases),
  };
}

export function currentShippedDarkAuditStatus(): ShippedDarkAuditStatus {
  const receipt = readShippedDarkAuditReceipt();
  if (!receipt) {
    return {
      schema: STATUS_SCHEMA,
      status: 'unverified',
      checkedAt: new Date(0).toISOString(),
      currentRelease: null,
      thresholdReleases: SHIPPED_DARK_WARNING_RELEASES,
      checkedFlagCount: 0,
      attentionFlagCount: 0,
      flags: [],
    };
  }
  // Deliberate default-off flags stay listed but never raise attention; only
  // unreviewed promotion candidates that aged past the threshold do.
  const flags = receipt.audit.flags.map((flag) => projectFlag(flag, receipt.thresholdReleases));
  const attentionFlagCount = flags.filter((flag) => flag.needsAttention).length;
  return {
    schema: STATUS_SCHEMA,
    status: attentionFlagCount > 0 ? 'attention' : 'current',
    checkedAt: receipt.checkedAt,
    currentRelease: receipt.audit.currentRelease,
    thresholdReleases: receipt.thresholdReleases,
    checkedFlagCount: receipt.audit.checkedFlags.length,
    attentionFlagCount,
    flags,
  };
}

export async function runShippedDarkAudit(options: {
  now?: Date;
  audit?: () => Promise<ShippedButDarkAudit>;
} = {}): Promise<ShippedDarkAuditReceipt> {
  const audit = await (options.audit ?? auditShippedButDarkFlags)();
  return recordShippedDarkAudit(audit, (options.now ?? new Date()).toISOString());
}

let bootHookFired = false;
let tickHandle: ReturnType<typeof setInterval> | null = null;

function runScheduledAudit(
  reason: 'boot' | 'tick',
  run: () => Promise<ShippedDarkAuditReceipt>,
): void {
  void run().catch((error: unknown) => {
    console.warn(
      `[shipped-dark-audit] ${reason} check failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
}

/** Start one immediate installed-runtime audit and repeat it every 24 hours. */
export function ensureShippedDarkAuditBootHook(options: {
  run?: () => Promise<ShippedDarkAuditReceipt>;
} = {}): void {
  if (bootHookFired) return;
  bootHookFired = true;
  const run = options.run ?? runShippedDarkAudit;
  setImmediate(() => runScheduledAudit('boot', run));
  if (tickHandle) return;
  tickHandle = setInterval(
    () => runScheduledAudit('tick', run),
    SHIPPED_DARK_AUDIT_INTERVAL_MS,
  );
  if (typeof tickHandle.unref === 'function') tickHandle.unref();
}
