'use client';

/**
 * Shared client helpers for the one-way beta feedback/error intake — the
 * "report this" flow that posts a note + optional screenshot to the team
 * Discord via /api/feedback/report. Used by the global IDE hotkey host
 * (ReportIssueHost), the canvas feedback popover (CanvasFeedbackButton), and
 * the Settings form (ReportIssueSection), so the capture + submit logic lives
 * in ONE place instead of three near-identical copies.
 */

import { isTauri } from '@/lib/tauri/bridge';

export const MAX_REPORT_MESSAGE = 4000;
export const MAX_REPORT_IMAGE_BYTES = 8 * 1024 * 1024;

export type ReportCategory = 'bug' | 'request';

export interface ReportImage {
  dataUrl: string;
  name: string;
}

/**
 * Capture the o8 app window as a PNG data URL (Tauri only, via the Rust
 * `capture_app_window` command). Returns null when capture is unavailable
 * (web build) or denied — callers fall back to letting the user paste/drop a
 * shot. Capture BEFORE opening the report modal so the shot shows the app
 * state, not the modal itself.
 */
export async function captureAppWindow(): Promise<ReportImage | null> {
  try {
    if (!isTauri()) return null;
    const { invoke } = await import('@tauri-apps/api/core');
    const b64 = await invoke<string | null>('capture_app_window');
    if (typeof b64 === 'string' && b64) {
      return { dataUrl: `data:image/png;base64,${b64}`, name: 'o8-window.png' };
    }
  } catch {
    /* no capture — the operator can still paste/drop a shot */
  }
  return null;
}

/**
 * Read an image File into a data-URL attachment, enforcing the size cap.
 * Resolves an error string instead of throwing so callers surface it inline.
 */
export function fileToReportImage(
  file: File | null | undefined,
): Promise<{ ok: true; image: ReportImage } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    if (!file || !file.type.startsWith('image/')) {
      resolve({ ok: false, error: 'That file is not an image.' });
      return;
    }
    if (file.size > MAX_REPORT_IMAGE_BYTES) {
      resolve({ ok: false, error: 'Screenshot too large (max 8 MB).' });
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        resolve({ ok: true, image: { dataUrl: reader.result, name: file.name || 'screenshot.png' } });
      } else {
        resolve({ ok: false, error: 'Could not read that image.' });
      }
    };
    reader.onerror = () => resolve({ ok: false, error: 'Could not read that image.' });
    reader.readAsDataURL(file);
  });
}

/**
 * POST a report to the private team intake. `route` records where it fired.
 *
 * Resolves the short report id the server assigned. That id is the operator's
 * receipt: a commit carrying `Fixes-Report: <id>` announces the fix in the public
 * #fixed channel, credited to them. Show it — an id they never saw is a fix they
 * can never connect back to the thing they reported.
 */
export async function submitReport(input: {
  category: ReportCategory;
  message: string;
  route: string;
  image?: ReportImage | null;
}): Promise<{ ok: true; reportId: string | null } | { ok: false; error: string }> {
  try {
    const response = await fetch('/api/feedback/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        category: input.category,
        message: input.message,
        route: input.route,
        userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown',
        image: input.image ? { dataUrl: input.image.dataUrl, name: input.image.name } : undefined,
      }),
    });
    const body = (await response.json().catch(() => null)) as { ok?: boolean; error?: string; reportId?: string } | null;
    if (!response.ok || !body?.ok) {
      return { ok: false, error: body?.error || `Report failed (HTTP ${response.status}).` };
    }
    return { ok: true, reportId: typeof body.reportId === 'string' ? body.reportId : null };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Report failed.' };
  }
}
