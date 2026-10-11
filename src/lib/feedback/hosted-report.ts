import 'server-only';

import { ensureFreeEntitlement } from '@/lib/entitlement/bootstrap';
import { configuredLicenseServerBaseUrl, readCachedEntitlement } from '@/lib/entitlement/license';

interface ReportFile {
  bytes: Buffer;
  mime: string;
  filename: string;
}

/** Shared delivery and receipt validation; callers control the report content. */
export async function postHostedPayload(
  payload: { username: string; embeds: Array<Record<string, unknown>> },
  reportId: string,
  files: ReportFile[] = [],
): Promise<{ ok: true } | { ok: false; error: string }> {
  const relayBaseUrl = configuredLicenseServerBaseUrl();
  if (!relayBaseUrl) {
    return { ok: false, error: 'Report intake is disabled because o8 hosted services are off.' };
  }

  try {
    await ensureFreeEntitlement({ allowPinnedPlan: true });
    const planToken = readCachedEntitlement()?.licenseKey?.trim();
    if (!planToken) {
      return { ok: false, error: 'Could not authenticate this report. Check your connection and try again.' };
    }

    let body: FormData | string;
    const headers: Record<string, string> = { Authorization: `Bearer ${planToken}` };
    if (files.length > 0) {
      const form = new FormData();
      form.append('payload_json', JSON.stringify(payload));
      files.forEach((file, i) => {
        form.append(`files[${i}]`, new Blob([file.bytes], { type: file.mime }), file.filename);
      });
      body = form;
    } else {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(payload);
    }

    const response = await fetch(`${relayBaseUrl}/v1/feedback`, {
      method: 'POST', headers, body, signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      if (response.status === 401) return { ok: false, error: 'Report authentication expired. Try again.' };
      if (response.status === 429) return { ok: false, error: 'Too many reports were sent recently. Try again later.' };
      if (response.status === 503) return { ok: false, error: 'Report intake is temporarily unavailable.' };
      return { ok: false, error: `Report relay returned HTTP ${response.status}.` };
    }
    const receipt = (await response.json().catch(() => null)) as { ok?: unknown; reportId?: unknown } | null;
    if (receipt?.ok !== true || receipt.reportId !== reportId) {
      return { ok: false, error: 'Report relay returned an invalid receipt.' };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Report relay request failed.' };
  }
}
