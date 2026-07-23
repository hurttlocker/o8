export const dynamic = 'force-dynamic';

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';

/**
 * Persist a Design Mode draw screenshot (captured from the LIVE native
 * browser window at send time — Q's ruling 2026-07-12: "the screenshot is
 * when I send it, not when I start drawing"). The dashboard posts the base64
 * PNG here and injects the returned path into the repo chat so the
 * orchestrator can read exactly what the operator circled.
 *
 * Gated by the default-deny middleware (loopback/token) like every panel
 * route. Size-capped — a screenshot, not an upload endpoint.
 */

const MAX_BASE64_LENGTH = 16 * 1024 * 1024; // ~12MB decoded

export async function POST(request: Request): Promise<Response> {
  const body = await request.json().catch(() => null) as {
    screenshotBase64?: unknown;
    variant?: unknown;
    ts?: unknown;
  } | null;
  const base64 = typeof body?.screenshotBase64 === 'string' ? body.screenshotBase64.trim() : '';
  // Two variants share one timestamp: the full-page capture and the crop of the
  // drawn region (Cursor parity, 2026-07-12). `ts` ties the pair together.
  const isCrop = body?.variant === 'crop';
  const ts = Number.isFinite(Number(body?.ts)) && Number(body?.ts) > 0 ? Math.floor(Number(body?.ts)) : Date.now();
  if (!base64) {
    return Response.json({ ok: false, error: 'screenshotBase64 is required' }, { status: 400 });
  }
  if (base64.length > MAX_BASE64_LENGTH) {
    return Response.json({ ok: false, error: 'screenshot too large' }, { status: 413 });
  }
  if (!/^[A-Za-z0-9+/=\r\n]+$/.test(base64)) {
    return Response.json({ ok: false, error: 'invalid base64 payload' }, { status: 400 });
  }
  try {
    const dataDir = getDataDir();
    const shotsDir = path.join(dataDir, 'design-shots');
    mkdirSync(shotsDir, { recursive: true });
    const filePath = path.join(shotsDir, `draw-${ts}${isCrop ? '-crop' : ''}.png`);
    writeFileSync(filePath, Buffer.from(base64, 'base64'));
    return Response.json({ ok: true, path: filePath });
  } catch (error) {
    return Response.json({
      ok: false,
      error: error instanceof Error ? error.message : 'failed to persist screenshot',
    }, { status: 500 });
  }
}
