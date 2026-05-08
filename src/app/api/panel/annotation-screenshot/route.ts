export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { NextResponse } from 'next/server';
import { O8WebviewClient } from '@/lib/mcp/o8-webview-client';
import type { PreviewAnnotationPayload } from '@/lib/panel/preview';

interface PanelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface AnnotationScreenshotRequest {
  annotation?: PreviewAnnotationPayload;
  panelRect?: PanelRect | null;
}

const OUTPUT_DIR = join('/tmp', 'o8-visual-annotations');

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isPanelRect(value: unknown): value is PanelRect {
  if (!isObject(value)) return false;
  return (
    typeof value.x === 'number'
    && typeof value.y === 'number'
    && typeof value.width === 'number'
    && typeof value.height === 'number'
  );
}

function isAnnotationPayload(value: unknown): value is PreviewAnnotationPayload {
  if (!isObject(value)) return false;
  return (
    typeof value.targetUrl === 'string'
    && typeof value.pageTitle === 'string'
    && value.kind === 'arrow'
    && typeof value.createdAt === 'string'
    && isObject(value.viewport)
    && isObject(value.annotation)
    && isObject(value.domMap)
  );
}

function imageExtension(mimeType: string): 'png' | 'jpg' {
  return mimeType === 'image/png' ? 'png' : 'jpg';
}

function responseError(error: unknown, status = 503) {
  return NextResponse.json({
    ok: false,
    error: error instanceof Error ? error.message : 'Failed to capture annotation screenshot',
  }, { status });
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null) as AnnotationScreenshotRequest | null;

  if (!body || !isAnnotationPayload(body.annotation)) {
    return responseError(new Error('annotation payload required'), 400);
  }

  try {
    const screenshot = await new O8WebviewClient().screenshot();
    if (screenshot.mimeType !== 'image/png' && screenshot.mimeType !== 'image/jpeg') {
      throw new Error(`Unsupported screenshot mime type: ${screenshot.mimeType}`);
    }

    const capturedAt = new Date().toISOString();
    const digest = createHash('sha256')
      .update(`${body.annotation.targetUrl}:${body.annotation.createdAt}:${screenshot.imageBase64.slice(0, 2048)}`)
      .digest('hex')
      .slice(0, 12);
    const stamp = capturedAt.replace(/[:.]/g, '-');
    const extension = imageExtension(screenshot.mimeType);
    const filePath = join(OUTPUT_DIR, `${stamp}-${digest}.${extension}`);
    const sidecarPath = join(OUTPUT_DIR, `${stamp}-${digest}.json`);

    const sidecar = {
      capturedAt,
      targetUrl: body.annotation.targetUrl,
      pageTitle: body.annotation.pageTitle,
      panelRect: isPanelRect(body.panelRect) ? body.panelRect : null,
      screenshot: {
        path: filePath,
        mimeType: screenshot.mimeType,
        width: screenshot.width,
        height: screenshot.height,
      },
      annotation: body.annotation,
    };

    await mkdir(OUTPUT_DIR, { recursive: true });
    await writeFile(filePath, Buffer.from(screenshot.imageBase64, 'base64'));
    await writeFile(sidecarPath, `${JSON.stringify(sidecar, null, 2)}\n`);

    return NextResponse.json({
      ok: true,
      screenshot: {
        path: filePath,
        src: `/api/panel/serve-image?path=${encodeURIComponent(filePath)}`,
        mimeType: screenshot.mimeType,
        width: screenshot.width,
        height: screenshot.height,
        capturedAt,
        sidecarPath,
      },
    });
  } catch (error) {
    return responseError(error);
  }
}
