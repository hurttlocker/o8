import 'server-only';

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { getDataDir } from '@/lib/data-dir-migration';

export type SymonPhoneBillingSource = 'chatgpt-subscription' | 'openai-api-key';

const STATE_VERSION = 1;
const STATE_FILE = 'symon-phone-billing.json';

interface SymonPhoneBillingState {
  version: typeof STATE_VERSION;
  billingSource: SymonPhoneBillingSource;
  updatedAt: number;
}

function statePath(): string {
  return path.join(getDataDir(), STATE_FILE);
}

function isBillingSource(value: unknown): value is SymonPhoneBillingSource {
  return value === 'chatgpt-subscription' || value === 'openai-api-key';
}

export async function readLastSymonPhoneBillingSource(): Promise<SymonPhoneBillingSource | null> {
  // This read/decision/write sequence is intentionally unlocked on one desktop.
  // A racing mint can cause one extra acknowledgement prompt, but cannot skip one.
  try {
    const parsed = JSON.parse(await readFile(statePath(), 'utf8')) as Partial<SymonPhoneBillingState>;
    return parsed.version === STATE_VERSION && isBillingSource(parsed.billingSource)
      ? parsed.billingSource
      : null;
  } catch {
    return null;
  }
}

export async function recordSymonPhoneBillingSource(
  billingSource: SymonPhoneBillingSource,
): Promise<void> {
  const filePath = statePath();
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  const state: SymonPhoneBillingState = {
    version: STATE_VERSION,
    billingSource,
    updatedAt: Date.now(),
  };

  try {
    await writeFile(tempPath, `${JSON.stringify(state)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}
