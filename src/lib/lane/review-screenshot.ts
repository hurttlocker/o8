import type { LaneEvent } from './types';

export interface LaneReviewScreenshot {
  path?: string;
  base64?: string;
  mimeType?: string;
  width?: number;
  height?: number;
  capturedAt?: string;
}

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
