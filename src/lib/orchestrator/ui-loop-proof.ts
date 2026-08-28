import 'server-only';

import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { getDataDir } from '@/lib/data-dir-migration';
import { recordLaneEvent } from '@/lib/lane/events';
import {
  type LaneReviewScreenshot,
  type LaneReviewScreenshotReference,
} from '@/lib/lane/review-screenshot';
import { createO8WebviewBrowserHandlers } from '@/lib/mcp/o8-webview-browser-tools';

export interface UiLoopElementRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface UiLoopProofCaptureContext {
  selector: string;
  element: string;
  rect?: UiLoopElementRect;
  filePath?: string;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function screenshotFromDataUri(
  dataUri: string | undefined,
  rect?: UiLoopElementRect,
): LaneReviewScreenshot | null {
  if (!dataUri) return null;
  const match = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/i.exec(dataUri.trim());
  if (!match) return null;
  return {
    base64: match[2].replace(/\s+/g, ''),
    mimeType: match[1].toLowerCase(),
    width: rect?.width,
    height: rect?.height,
    capturedAt: new Date().toISOString(),
  };
}

function safePathSegment(value: string): string {
  const safe = value.trim().replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200);
  return safe || 'proof';
}

function screenshotExtension(mimeType?: string): string {
  if (mimeType === 'image/jpeg' || mimeType === 'image/jpg') return 'jpg';
  if (mimeType === 'image/webp') return 'webp';
  if (mimeType === 'image/gif') return 'gif';
  return 'png';
}

async function persistProofScreenshot(input: {
  laneId: string;
  proofId: string;
  frame: 'before' | 'after';
  screenshot: LaneReviewScreenshot | null;
}): Promise<LaneReviewScreenshotReference | null> {
  if (!input.screenshot?.base64) return null;
  const mimeType = input.screenshot.mimeType ?? 'image/png';
  const directory = join(getDataDir(), 'ui-loop-proofs', safePathSegment(input.laneId));
  const filePath = join(
    directory,
    `${safePathSegment(input.proofId)}.${input.frame}.${screenshotExtension(mimeType)}`,
  );
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(filePath, Buffer.from(input.screenshot.base64, 'base64'), { mode: 0o600 });
  await chmod(filePath, 0o600);
  return {
    path: filePath,
    mimeType,
    width: input.screenshot.width,
    height: input.screenshot.height,
    capturedAt: input.screenshot.capturedAt,
  };
}

function parseToolJson(result: Awaited<ReturnType<ReturnType<typeof createO8WebviewBrowserHandlers>[string]>>): Record<string, unknown> {
  const content = result.content.find((item) => item.type === 'text');
  if (!content || content.type !== 'text') return {};
  try {
    const parsed = JSON.parse(content.text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

export async function persistUiLoopBeforeScreenshot(input: {
  laneId: string;
  proofId: string;
  dataUri?: string;
  rect?: UiLoopElementRect;
}): Promise<LaneReviewScreenshotReference | null> {
  return persistProofScreenshot({
    laneId: input.laneId,
    proofId: input.proofId,
    frame: 'before',
    screenshot: screenshotFromDataUri(input.dataUri, input.rect),
  });
}

export async function captureUiLoopAfterScreenshot(input: {
  laneId: string;
  proofId: string;
  capture: UiLoopProofCaptureContext;
}): Promise<LaneReviewScreenshotReference | null> {
  const handler = createO8WebviewBrowserHandlers().o8_browser_grab;
  const parsed = parseToolJson(await handler({ selector: input.capture.selector }));
  const element = parsed.element && typeof parsed.element === 'object' && !Array.isArray(parsed.element)
    ? parsed.element as Record<string, unknown>
    : null;
  const screenshot = screenshotFromDataUri(stringValue(element?.screenshot) ?? undefined, {
    top: finiteNumber((element?.boundingRect as Record<string, unknown> | undefined)?.top) ?? input.capture.rect?.top ?? 0,
    left: finiteNumber((element?.boundingRect as Record<string, unknown> | undefined)?.left) ?? input.capture.rect?.left ?? 0,
    width: finiteNumber((element?.boundingRect as Record<string, unknown> | undefined)?.width) ?? input.capture.rect?.width ?? 0,
    height: finiteNumber((element?.boundingRect as Record<string, unknown> | undefined)?.height) ?? input.capture.rect?.height ?? 0,
  });
  return persistProofScreenshot({
    laneId: input.laneId,
    proofId: input.proofId,
    frame: 'after',
    screenshot,
  });
}

export function recordUiLoopProof(input: {
  packetId: string;
  laneId: string;
  proofId: string;
  before: LaneReviewScreenshotReference;
  after: LaneReviewScreenshotReference;
  previewUrl: string;
  elapsedMs: number;
  capture: UiLoopProofCaptureContext;
}): void {
  recordLaneEvent(input.laneId, 'ui_loop_proof', 'orchestrator', {
    packetId: input.packetId,
    laneId: input.laneId,
    proofId: input.proofId,
    before: input.before,
    after: input.after,
    previewUrl: input.previewUrl,
    elapsedMs: input.elapsedMs,
    element: input.capture.element,
    selector: input.capture.selector,
    ...(input.capture.rect ? { rect: input.capture.rect } : {}),
    ...(input.capture.filePath ? { filePath: input.capture.filePath } : {}),
  });
}
