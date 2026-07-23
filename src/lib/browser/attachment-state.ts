import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserAttachmentSummary } from '@/lib/browser/types';
import { getDataDir } from '@/lib/data-dir-migration';

const STATE_DIR = getDataDir();
const ATTACHMENT_STATE_PATH = join(STATE_DIR, 'browser-attachment.json');

function ensureStateDir() {
  if (!existsSync(STATE_DIR)) {
    mkdirSync(STATE_DIR, { recursive: true });
  }
}

export function getAttachedBrowserSummary(): BrowserAttachmentSummary | null {
  try {
    if (!existsSync(ATTACHMENT_STATE_PATH)) return null;
    const raw = readFileSync(ATTACHMENT_STATE_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as BrowserAttachmentSummary | null;
    return parsed ?? null;
  } catch {
    return null;
  }
}

export function setAttachedBrowserSummary(summary: BrowserAttachmentSummary | null) {
  try {
    ensureStateDir();
    writeFileSync(ATTACHMENT_STATE_PATH, JSON.stringify(summary ?? null), 'utf-8');
  } catch {
    // Best-effort shared state; command center still keeps local truth for the
    // current session if this write fails.
  }
}
