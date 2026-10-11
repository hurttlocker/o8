import 'server-only';

import { postHostedPayload } from '@/lib/feedback/hosted-report';
import { newReportId, recordReport, reportTitle } from '@/lib/feedback/report-ledger';

/** Text-only feedback never resolves account identity or collects diagnostics. */
export async function sendMinimalFeedback(
  body: Record<string, unknown>,
  metadata?: { version: string; os: string },
): Promise<{ ok: true; reportId: string } | { ok: false; error: string; status: number }> {
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  if (!message || message.length > 4000) {
    return { ok: false, error: 'Add feedback of 4,000 characters or fewer.', status: 400 };
  }
  if (body.email !== undefined && typeof body.email !== 'string') {
    return { ok: false, error: 'Enter a valid email address or leave it empty.', status: 400 };
  }
  const email = typeof body.email === 'string' ? body.email.trim() : '';
  if (email && (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
    return { ok: false, error: 'Enter a valid email address or leave it empty.', status: 400 };
  }
  if (body.includeMetadata !== undefined && typeof body.includeMetadata !== 'boolean') {
    return { ok: false, error: 'Choose whether to include app version and OS.', status: 400 };
  }

  const reportId = newReportId();
  const selectedMetadata = body.includeMetadata === true ? metadata : undefined;
  const fields = [
    ...(email ? [{ name: 'Email', value: email, inline: true }] : []),
    ...(selectedMetadata ? [
      { name: 'Version', value: selectedMetadata.version, inline: true },
      { name: 'OS', value: selectedMetadata.os, inline: true },
    ] : []),
  ];
  const posted = await postHostedPayload({
    username: 'o8 Report',
    embeds: [{
      title: `[REQUEST] ${reportId} · ${reportTitle(message)}`,
      description: message,
      fields,
      footer: { text: `o8 · report ${reportId} · private intake` },
    }],
  }, reportId);
  if (!posted.ok) return { ...posted, status: 502 };

  recordReport({
    id: reportId, ts: Date.now(), category: 'request', title: reportTitle(message),
    reporter: null, version: selectedMetadata?.version ?? 'unknown',
  });
  return { ok: true, reportId };
}
