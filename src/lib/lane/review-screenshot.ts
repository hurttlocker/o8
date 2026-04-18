import { createHash } from 'node:crypto';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LaneEvent } from './types';

export interface LaneReviewScreenshot {
  path?: string;
  base64?: string;
  mimeType?: string;
  width?: number;
  height?: number;
  capturedAt?: string;
}

export interface LaneReviewScreenshotReference extends LaneReviewScreenshot {
  path: string;
}

const REVIEW_SCREENSHOT_FALLBACK_DIR = join(tmpdir(), 'o8-lane-review-screenshots');

function stringValue(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.trim();
  return normalized || undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function screenshotExtension(mimeType?: string): string {
  const normalized = mimeType?.trim().toLowerCase();
  if (normalized === 'image/jpeg' || normalized === 'image/jpg') {
    return 'jpg';
  }
  if (normalized === 'image/webp') {
    return 'webp';
  }
  if (normalized === 'image/gif') {
    return 'gif';
  }
  return 'png';
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function buildFallbackScreenshotPath(
  laneId: string,
  screenshot: LaneReviewScreenshot,
): string {
  const digest = createHash('sha1')
    .update(laneId)
    .update(':')
    .update(screenshot.capturedAt ?? '')
    .update(':')
    .update(String(screenshot.width ?? ''))
    .update('x')
    .update(String(screenshot.height ?? ''))
    .update(':')
    .update(screenshot.mimeType ?? 'image/png')
    .update(':')
    .update(String(screenshot.base64?.length ?? 0))
    .update(':')
    .update((screenshot.base64 ?? '').slice(0, 4096))
    .digest('hex')
    .slice(0, 12);

  return join(
    REVIEW_SCREENSHOT_FALLBACK_DIR,
    `${laneId}-${digest}.${screenshotExtension(screenshot.mimeType)}`,
  );
}

export function extractLaneReviewScreenshot(payload?: Record<string, unknown> | null): LaneReviewScreenshot | null {
  if (!payload) {
    return null;
  }

  const path = stringValue(payload.reviewScreenshotPath);
  const base64 = stringValue(payload.reviewScreenshotBase64);
  if (!path && !base64) {
    return null;
  }

  return {
    path,
    base64,
    mimeType: stringValue(payload.reviewScreenshotMimeType) ?? 'image/png',
    width: numberValue(payload.reviewScreenshotWidth),
    height: numberValue(payload.reviewScreenshotHeight),
    capturedAt: stringValue(payload.reviewScreenshotCapturedAt),
  };
}

export function findLatestLaneReviewScreenshot(
  events: LaneEvent[],
  opts?: { beforeTimestamp?: number },
): LaneReviewScreenshot | null {
  const beforeTimestamp = typeof opts?.beforeTimestamp === 'number' && Number.isFinite(opts.beforeTimestamp)
    ? opts.beforeTimestamp
    : null;

  let fallback: LaneReviewScreenshot | null = null;

  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    const screenshot = extractLaneReviewScreenshot(event?.payload);
    if (!screenshot) {
      continue;
    }

    if (fallback === null) {
      fallback = screenshot;
    }

    if (beforeTimestamp === null) {
      return screenshot;
    }

    const eventTimestamp = Number.isFinite(Date.parse(event.timestamp))
      ? Date.parse(event.timestamp)
      : Number.NaN;
    if (Number.isFinite(eventTimestamp) && eventTimestamp <= beforeTimestamp) {
      return screenshot;
    }
  }

  return fallback;
}

export function laneReviewScreenshotSrc(screenshot: LaneReviewScreenshot): string | null {
  if (screenshot.path) {
    return `/api/panel/serve-image?path=${encodeURIComponent(screenshot.path)}`;
  }

  if (screenshot.base64) {
    return `data:${screenshot.mimeType ?? 'image/png'};base64,${screenshot.base64}`;
  }

  return null;
}

export async function resolveLaneReviewScreenshotReference(
  laneId: string,
  screenshot: LaneReviewScreenshot | null,
): Promise<LaneReviewScreenshotReference | null> {
  if (!screenshot) {
    return null;
  }

  const existingPath = stringValue(screenshot.path);
  if (existingPath && await fileExists(existingPath)) {
    return { ...screenshot, path: existingPath };
  }

  if (!screenshot.base64) {
    return null;
  }

  await mkdir(REVIEW_SCREENSHOT_FALLBACK_DIR, { recursive: true });
  const fallbackPath = buildFallbackScreenshotPath(laneId, screenshot);
  if (!await fileExists(fallbackPath)) {
    await writeFile(fallbackPath, Buffer.from(screenshot.base64, 'base64'));
  }

  return {
    ...screenshot,
    path: fallbackPath,
  };
}
