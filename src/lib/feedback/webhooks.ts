import 'server-only';

/**
 * Resolve the feedback webhooks. NOT hardcoded, deliberately.
 *
 * The intake webhook used to be a string literal in the report route. Anyone with
 * a clone — or with git history, forever — could post as us into the private ops
 * channel. It was revoked 2026-07-13 and replaced with this.
 *
 * Source order:
 *   1. env — the packaged build bakes it (scripts/tauri-export.mjs), and it's the
 *      operator override in dev.
 *   2. o8.release.json at the repo root — gitignored, the same file that already
 *      holds the Sentry DSN and the GitHub client id. This is what makes `next dev`
 *      work without an env dance.
 *   3. null — the caller must fail loudly. A report that silently goes nowhere is
 *      worse than one that errors: the operator thinks they were heard.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

type WebhookKey = 'feedbackWebhookUrl' | 'fixedWebhookUrl';

let cached: Record<string, string | null> | null = null;

function readReleaseConfig(): Record<string, unknown> {
  try {
    const raw = readFileSync(path.join(process.cwd(), 'o8.release.json'), 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    // Absent in a packaged install — env carries it there.
    return {};
  }
}

function resolve(envVar: string, key: WebhookKey): string | null {
  const fromEnv = process.env[envVar]?.trim();
  if (fromEnv) return fromEnv;

  if (cached === null) {
    const cfg = readReleaseConfig();
    cached = {
      feedbackWebhookUrl: typeof cfg.feedbackWebhookUrl === 'string' ? cfg.feedbackWebhookUrl.trim() || null : null,
      fixedWebhookUrl: typeof cfg.fixedWebhookUrl === 'string' ? cfg.fixedWebhookUrl.trim() || null : null,
    };
  }
  return cached[key] ?? null;
}

/** The PRIVATE ops channel — reports land here with screenshots and stack traces. */
export function resolveFeedbackWebhook(): string | null {
  return resolve('O8_FEEDBACK_WEBHOOK_URL', 'feedbackWebhookUrl');
}

/** The PUBLIC #fixed channel — only shipped fixes, credited, ever go here. */
export function resolveFixedWebhook(): string | null {
  return resolve('O8_FIXED_WEBHOOK_URL', 'fixedWebhookUrl');
}

/** Test seam — the module caches the on-disk read. */
export function __resetWebhookCache(): void {
  cached = null;
}
