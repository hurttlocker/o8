const JPEG_MIME_TYPE = 'image/jpeg';

export interface SocketResponse {
  id?: string;
  success?: boolean;
  data?: unknown;
  error?: unknown;
}

interface PageMapElement {
  ref: number;
  tag: string;
  interactive?: boolean;
  type?: string;
  text?: string;
  placeholder?: string;
  ariaLabel?: string;
  role?: string;
  href?: string;
  name?: string;
  id?: string;
  value?: string;
  checked?: boolean;
  disabled?: boolean;
  options?: string[];
  context?: string;
  parentRef?: number;
  depth?: number;
  visible?: boolean;
}

interface PageMapResult {
  url?: string;
  title?: string;
  viewport?: { width?: number; height?: number };
  elements?: PageMapElement[];
  content?: string;
}

export interface O8WindowInfo {
  label: string;
  title?: string;
  url?: string;
  visible?: boolean;
  focused?: boolean;
  maximized?: boolean;
  fullscreen?: boolean;
  scaleFactor?: number;
  outerSize?: { width: number; height: number };
  innerSize?: { width: number; height: number };
  position?: { x: number; y: number };
  monitor?: { name?: string | null } | null;
}

export interface O8MonitorInfo {
  name?: string | null;
  size?: { width: number; height: number };
  position?: { x: number; y: number };
  scaleFactor?: number;
}

export interface O8AppInfo {
  app?: { name?: string; version?: string };
  os?: { os?: string; arch?: string; family?: string };
  windows?: O8WindowInfo[];
  monitors?: O8MonitorInfo[];
  primaryMonitor?: O8MonitorInfo | null;
}

/** Values accepted by `manage_window`'s `operation` field. */
export type O8WindowOperation =
  | 'show'
  | 'hide'
  | 'focus'
  | 'center'
  | 'minimize'
  | 'maximize'
  | 'unmaximize'
  | 'close'
  | 'setPosition'
  | 'setSize'
  | 'toggleFullscreen';

/** Values accepted by `navigate_webview`'s `action` field. */
export type O8NavigateWebviewAction = 'navigate' | 'reload' | 'back' | 'forward' | 'get_url';

/** Values accepted by `manage_events`' `action` field. */
export type O8EventsAction = 'emit' | 'emit_to' | 'listen' | 'sniff';

export function extractDataUrlPayload(value: unknown): { base64: string; mimeType: string } {
  const candidate = resolveImageDataCandidate(value);
  if (!candidate) {
    throw new Error('Failed to extract screenshot image data from o8 webview response');
  }

  const match = candidate.match(/^data:([^;]+);base64,(.+)$/);
  if (match) {
    return { mimeType: match[1], base64: match[2] };
  }

  return { mimeType: JPEG_MIME_TYPE, base64: candidate };
}

function resolveImageDataCandidate(value: unknown): string | null {
  if (typeof value === 'string') {
    return value;
  }

  if (!value || typeof value !== 'object') {
    return null;
  }

  const record = value as Record<string, unknown>;
  if (typeof record.data === 'string') {
    return record.data;
  }

  if (record.data && typeof record.data === 'object') {
    const nested = record.data as Record<string, unknown>;
    if (typeof nested.data === 'string') {
      return nested.data;
    }
  }

  return null;
}

export function getImageDimensions(base64Data: string): { width: number; height: number } {
  const bytes = Buffer.from(base64Data, 'base64');
  return getImageDimensionsFromBytes(bytes);
}

function getImageDimensionsFromBytes(bytes: Buffer): { width: number; height: number } {
  if (isPng(bytes)) {
    return {
      width: bytes.readUInt32BE(16),
      height: bytes.readUInt32BE(20),
    };
  }

  if (isJpeg(bytes)) {
    return getJpegDimensions(bytes);
  }

  throw new Error('Unsupported screenshot image format returned by o8 webview socket');
}

export function detectImageMimeType(base64Data: string, fallbackMimeType: string): string {
  const bytes = Buffer.from(base64Data, 'base64');
  if (isPng(bytes)) {
    return 'image/png';
  }
  if (isJpeg(bytes)) {
    return JPEG_MIME_TYPE;
  }
  return fallbackMimeType;
}

function isPng(bytes: Buffer): boolean {
  return bytes.length >= 24
    && bytes[0] === 0x89
    && bytes[1] === 0x50
    && bytes[2] === 0x4e
    && bytes[3] === 0x47;
}

function isJpeg(bytes: Buffer): boolean {
  return bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8;
}

function getJpegDimensions(bytes: Buffer): { width: number; height: number } {
  let offset = 2;

  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }

    const marker = bytes[offset + 1];
    if (marker === 0xd8 || marker === 0xd9) {
      offset += 2;
      continue;
    }

    if (offset + 4 > bytes.length) {
      break;
    }

    const segmentLength = bytes.readUInt16BE(offset + 2);
    if (segmentLength < 2 || offset + 2 + segmentLength > bytes.length) {
      break;
    }

    const isStartOfFrame = marker === 0xc0
      || marker === 0xc1
      || marker === 0xc2
      || marker === 0xc3
      || marker === 0xc5
      || marker === 0xc6
      || marker === 0xc7
      || marker === 0xc9
      || marker === 0xca
      || marker === 0xcb
      || marker === 0xcd
      || marker === 0xce
      || marker === 0xcf;

    if (isStartOfFrame) {
      return {
        height: bytes.readUInt16BE(offset + 5),
        width: bytes.readUInt16BE(offset + 7),
      };
    }

    offset += 2 + segmentLength;
  }

  throw new Error('Failed to parse screenshot dimensions from JPEG response');
}

/**
 * The plugin sometimes wraps a command result in a second `data` envelope.
 * Peel one level so callers see the handler's own JSON either way.
 */
export function unwrapCommandData(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object') {
    return {};
  }

  const record = value as Record<string, unknown>;
  if (record.data && typeof record.data === 'object' && !Array.isArray(record.data)) {
    return record.data as Record<string, unknown>;
  }

  return record;
}

export function coercePageMap(value: unknown): PageMapResult {
  if (!value || typeof value !== 'object') {
    return {};
  }

  const record = value as Record<string, unknown>;
  if (record.data && typeof record.data === 'object') {
    return record.data as PageMapResult;
  }

  return record as PageMapResult;
}

// Cap the rendered a11y tree so a dense page (hundreds of nodes) can't flood
// the caller's context. The true count is reported in the footer.
const SNAPSHOT_MAX_ELEMENTS = 200;

export function formatSnapshotTree(pageMap: PageMapResult): string {
  const lines: string[] = [];
  const title = typeof pageMap.title === 'string' ? pageMap.title : '';
  const url = typeof pageMap.url === 'string' ? pageMap.url : '';

  if (title) {
    lines.push(`Title: ${title}`);
  }
  if (url) {
    lines.push(`URL: ${url}`);
  }

  const elements = Array.isArray(pageMap.elements)
    ? pageMap.elements.filter((element) => element.visible !== false)
    : [];

  if (lines.length > 0) {
    lines.push('');
  }

  if (elements.length === 0) {
    lines.push('(no visible refs found)');
    return lines.join('\n');
  }

  const shown = elements.slice(0, SNAPSHOT_MAX_ELEMENTS);
  for (const element of shown) {
    const indent = '  '.repeat(Math.max(0, element.depth ?? 0));
    const attributes: string[] = [];

    const label = element.text || element.ariaLabel || element.placeholder || element.value || element.name || '';
    if (label) {
      attributes.push(JSON.stringify(label));
    }
    if (element.role) {
      attributes.push(`role=${element.role}`);
    }
    if (element.type) {
      attributes.push(`type=${element.type}`);
    }
    if (element.id) {
      attributes.push(`#${element.id}`);
    }
    if (element.href) {
      attributes.push(`href=${element.href}`);
    }
    if (element.placeholder && element.placeholder !== label) {
      attributes.push(`placeholder=${JSON.stringify(element.placeholder)}`);
    }
    if (element.checked === true) {
      attributes.push('checked');
    }
    if (element.disabled === true) {
      attributes.push('disabled');
    }
    if (Array.isArray(element.options) && element.options.length > 0) {
      attributes.push(`options=${JSON.stringify(element.options)}`);
    }
    if (element.interactive === false) {
      attributes.push('static');
    }

    const suffix = attributes.length > 0 ? ` ${attributes.join(' ')}` : '';
    lines.push(`${indent}[${element.ref}] <${element.tag}>${suffix}`);
  }

  if (elements.length > shown.length) {
    lines.push(`… (+${elements.length - shown.length} more refs — narrow with a selector or re-run after the page settles)`);
  }

  return lines.join('\n');
}

export function normalizeTextResult(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  if (!value || typeof value !== 'object') {
    return String(value ?? '');
  }

  const record = value as Record<string, unknown>;
  if (typeof record.result === 'string') {
    return record.result;
  }
  if (typeof record.text === 'string') {
    return record.text;
  }
  if (record.data && typeof record.data === 'object') {
    const nested = record.data as Record<string, unknown>;
    if (typeof nested.result === 'string') {
      return nested.result;
    }
    if (typeof nested.text === 'string') {
      return nested.text;
    }
  }

  return JSON.stringify(value);
}

export function extractCoordinates(value: unknown): { x: number; y: number } {
  if (!value || typeof value !== 'object') {
    throw new Error('Could not extract coordinates from o8 element lookup response');
  }

  const record = value as Record<string, unknown>;
  if (typeof record.x === 'number' && typeof record.y === 'number') {
    return { x: record.x, y: record.y };
  }

  if (record.data && typeof record.data === 'object') {
    const nested = record.data as Record<string, unknown>;
    if (typeof nested.x === 'number' && typeof nested.y === 'number') {
      return { x: nested.x, y: nested.y };
    }
  }

  throw new Error('Could not extract coordinates from o8 element lookup response');
}
