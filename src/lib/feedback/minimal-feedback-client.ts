'use client';

import { REPORT_DATA_SHARING_OFF_ERROR, REPORT_DATA_SHARING_OFF_MESSAGE } from '@/lib/feedback/data-sharing';
import { readReportDataSharingEnabled } from '@/lib/feedback/report-data-sharing-client';

/** Sends only the feedback fields the user selected, without collecting app state. */
export async function submitFeedback(input: {
  message: string;
  email?: string;
  includeMetadata?: boolean;
}): Promise<{ ok: true; reportId: string } | { ok: false; error: string; code?: string }> {
  try {
    const sharingEnabled = await readReportDataSharingEnabled().catch(() => false);
    if (!sharingEnabled) {
      return { ok: false, error: REPORT_DATA_SHARING_OFF_MESSAGE, code: REPORT_DATA_SHARING_OFF_ERROR };
    }
    const response = await fetch('/api/feedback/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: 'feedback',
        message: input.message,
        ...(input.email?.trim() ? { email: input.email.trim() } : {}),
        includeMetadata: input.includeMetadata !== false,
      }),
      signal: AbortSignal.timeout(20_000),
    });
    const body = (await response.json().catch(() => null)) as {
      ok?: unknown; reportId?: unknown; error?: string; message?: string;
    } | null;
    if (!response.ok || body?.ok !== true) {
      return { ok: false, error: body?.message || body?.error || `Feedback failed (HTTP ${response.status}).`, code: body?.error };
    }
    if (typeof body.reportId !== 'string' || !body.reportId.trim()) {
      return { ok: false, error: 'Feedback returned an invalid receipt. Try again.' };
    }
    return { ok: true, reportId: body.reportId };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Feedback failed.' };
  }
}
