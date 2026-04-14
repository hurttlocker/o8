import { existsSync, readFileSync } from 'node:fs';
import { createConnection, type Socket } from 'node:net';
import * as os from 'node:os';

const DEFAULT_WINDOW_LABEL = 'main';
const REQUEST_TIMEOUT_MS = 30_000;
const UNAVAILABLE_MESSAGE = 'o8 webview tools unavailable — launch o8 with --features dev-mcp-plugin or use the signed build';
const JPEG_MIME_TYPE = 'image/jpeg';

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface SocketResponse {
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

function createCodedError(message: string, code?: string): Error {
  const error = new Error(message) as Error & { code?: string };
  if (code) {
    error.code = code;
  }
  return error;
}

function getErrorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}

function extractDataUrlPayload(value: unknown): { base64: string; mimeType: string } {
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

function getImageDimensions(base64Data: string): { width: number; height: number } {
  const bytes = Buffer.from(base64Data, 'base64');

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

function coercePageMap(value: unknown): PageMapResult {
  if (!value || typeof value !== 'object') {
    return {};
  }

  const record = value as Record<string, unknown>;
  if (record.data && typeof record.data === 'object') {
    return record.data as PageMapResult;
  }

  return record as PageMapResult;
}

function formatSnapshotTree(pageMap: PageMapResult): string {
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

  for (const element of elements) {
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

  return lines.join('\n');
}

function normalizeTextResult(value: unknown): string {
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

function extractCoordinates(value: unknown): { x: number; y: number } {
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

export class O8WebviewClient {
  private readonly socketPath: string;
  private readonly tokenPath: string;
  private socket: Socket | null = null;
  private connectPromise: Promise<void> | null = null;
  private isConnected = false;
  private buffer = '';
  private authToken?: string;
  private readonly pending = new Map<string, PendingRequest>();

  constructor() {
    const username = os.userInfo().username;
    this.socketPath = `/tmp/tauri-mcp-o8-${username}.sock`;
    this.tokenPath = `${this.socketPath}.token`;

    const cleanup = () => {
      this.dispose();
    };

    process.once('beforeExit', cleanup);
    process.once('exit', cleanup);
  }

  async screenshot(): Promise<{ imageBase64: string; width: number; height: number }> {
    const result = await this.sendCommand('take_screenshot', {
      window_label: DEFAULT_WINDOW_LABEL,
      save_to_disk: false,
      thumbnail: false,
    });
    const { base64 } = extractDataUrlPayload(result);
    const { width, height } = getImageDimensions(base64);
    return { imageBase64: base64, width, height };
  }

  async snapshot(): Promise<{ tree: string }> {
    const pageMap = coercePageMap(await this.sendCommand('get_page_map', {
      window_label: DEFAULT_WINDOW_LABEL,
      include_content: false,
      interactive_only: false,
      include_metadata: false,
    }));
    return { tree: formatSnapshotTree(pageMap) };
  }

  async click(opts: { ref?: number; x?: number; y?: number }): Promise<{ ok: boolean }> {
    let targetX = opts.x;
    let targetY = opts.y;

    if (typeof opts.ref === 'number') {
      const coords = extractCoordinates(await this.sendCommand('get_element_position', {
        window_label: DEFAULT_WINDOW_LABEL,
        selector_type: 'ref',
        selector_value: String(opts.ref),
        should_click: false,
      }));
      targetX = coords.x;
      targetY = coords.y;
    }

    if (typeof targetX !== 'number' || typeof targetY !== 'number') {
      throw new Error('click requires either ref or x/y coordinates');
    }

    await this.sendCommand('simulate_mouse_movement', {
      window_label: DEFAULT_WINDOW_LABEL,
      x: Math.round(targetX),
      y: Math.round(targetY),
      click: true,
    });

    return { ok: true };
  }

  async type(text: string): Promise<{ ok: boolean }> {
    await this.sendCommand('type_into_focused', {
      window_label: DEFAULT_WINDOW_LABEL,
      text,
    });
    return { ok: true };
  }

  async readPage(): Promise<{ text: string }> {
    const result = await this.evalJs(`(() => {
      const root = document.body || document.documentElement;
      return (root?.innerText || '').trim();
    })()`);
    return { text: result.result };
  }

  async evalJs(code: string): Promise<{ result: string }> {
    const result = await this.sendCommand('execute_js', {
      window_label: DEFAULT_WINDOW_LABEL,
      code,
    });
    return { result: normalizeTextResult(result) };
  }

  async waitFor(opts: { selector: string; text?: string; timeoutMs?: number }): Promise<{
    ok: boolean;
    matchedText: string;
    elapsedMs: number;
  }> {
    const selector = opts.selector;
    const expectedText = typeof opts.text === 'string' && opts.text.length > 0 ? opts.text : null;
    const timeoutMs = typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0
      ? Math.min(opts.timeoutMs, 25_000)
      : 10_000;

    // The Rust execute_js bridge does not await Promises, so we poll from Node.
    // Each tick runs a synchronous scan in the webview; the sleep happens here.
    // When `text` is provided, scan every match (querySelectorAll), not just
    // the first — otherwise `button` + text="Orchestrator" never finds the
    // right button.
    const started = Date.now();
    const deadline = started + timeoutMs;
    const probeCode = expectedText === null
      ? `(() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return '__O8_WAIT_NOT_FOUND__';
          const text = (el.innerText || el.textContent || '').trim();
          return '__O8_WAIT_FOUND__' + text.slice(0, 200);
        })()`
      : `(() => {
          const needle = ${JSON.stringify(expectedText)};
          const candidates = document.querySelectorAll(${JSON.stringify(selector)});
          for (const el of candidates) {
            const text = (el.innerText || el.textContent || '').trim();
            if (text.includes(needle)) {
              return '__O8_WAIT_FOUND__' + text.slice(0, 200);
            }
          }
          return '__O8_WAIT_NOT_FOUND__';
        })()`;

    while (true) {
      const raw = await this.evalJs(probeCode);
      const result = raw.result;
      if (typeof result === 'string' && result.startsWith('__O8_WAIT_FOUND__')) {
        return {
          ok: true,
          matchedText: result.slice('__O8_WAIT_FOUND__'.length),
          elapsedMs: Date.now() - started,
        };
      }
      if (Date.now() >= deadline) {
        throw createCodedError(
          `wait_for timed out after ${Date.now() - started}ms (selector: ${selector}${expectedText ? `, text: ${expectedText}` : ''})`,
          'ETIMEDOUT',
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }

  async navigate(path: string): Promise<{ ok: boolean }> {
    await this.evalJs(`(() => {
      const next = new URL(${JSON.stringify(path)}, window.location.origin);
      const route = \`\${next.pathname}\${next.search}\${next.hash}\`;
      window.history.pushState(window.history.state, '', route);
      const event = typeof PopStateEvent === 'function'
        ? new PopStateEvent('popstate', { state: window.history.state })
        : new Event('popstate');
      window.dispatchEvent(event);
      return route;
    })()`);
    return { ok: true };
  }

  dispose(): void {
    for (const [requestId, pending] of Array.from(this.pending.entries())) {
      clearTimeout(pending.timeout);
      pending.reject(createCodedError('Socket connection closed', 'ECONNRESET'));
      this.pending.delete(requestId);
    }

    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.destroy();
      this.socket = null;
    }

    this.isConnected = false;
    this.connectPromise = null;
    this.buffer = '';
  }

  private async sendCommand(command: string, payload: Record<string, unknown>): Promise<unknown> {
    return this.withReconnectRetry(() => this.sendCommandOnce(command, payload));
  }

  private async sendCommandOnce(command: string, payload: Record<string, unknown>): Promise<unknown> {
    await this.ensureConnected();

    if (!this.socket) {
      throw new Error('Socket client not initialized');
    }

    const socket = this.socket;

    return new Promise((resolve, reject) => {
      const requestId = `${Date.now()}${Math.random().toString(36).slice(2)}`;
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error('Request timed out after 30 seconds'));
      }, REQUEST_TIMEOUT_MS);

      this.pending.set(requestId, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (reason) => {
          clearTimeout(timeout);
          reject(reason);
        },
        timeout,
      });

      const request = JSON.stringify({
        command,
        payload,
        id: requestId,
        ...(this.authToken ? { authToken: this.authToken } : {}),
      }) + '\n';

      socket.write(request, (error) => {
        if (!error) {
          return;
        }

        clearTimeout(timeout);
        this.pending.delete(requestId);
        reject(this.normalizeConnectionError(error));
      });
    });
  }

  private async withReconnectRetry<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      const code = getErrorCode(error);
      if (code !== 'EPIPE' && code !== 'ECONNRESET') {
        throw error;
      }

      this.dispose();
      return operation();
    }
  }

  private async ensureConnected(): Promise<void> {
    if (this.isConnected && this.socket && !this.socket.destroyed) {
      return;
    }

    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.authToken = this.resolveAuthToken();

    this.connectPromise = new Promise((resolve, reject) => {
      const socket = createConnection({ path: this.socketPath });
      let settled = false;

      this.socket = socket;
      this.isConnected = false;
      this.buffer = '';

      socket.on('connect', () => {
        settled = true;
        this.isConnected = true;
        this.connectPromise = null;
        resolve();
      });

      socket.on('data', (chunk) => {
        this.handleData(chunk);
      });

      socket.on('error', (error) => {
        if (!settled) {
          settled = true;
          this.connectPromise = null;
          this.socket = null;
          reject(this.normalizeConnectionError(error));
        }
      });

      socket.on('close', () => {
        this.isConnected = false;
        this.connectPromise = null;
        if (this.socket === socket) {
          this.socket = null;
        }

        const pendingError = createCodedError('Socket connection closed', 'ECONNRESET');
        for (const [requestId, pending] of Array.from(this.pending.entries())) {
          clearTimeout(pending.timeout);
          pending.reject(pendingError);
          this.pending.delete(requestId);
        }

        this.buffer = '';

        if (!settled) {
          settled = true;
          reject(pendingError);
        }
      });
    });

    return this.connectPromise;
  }

  private handleData(chunk: Buffer): void {
    this.buffer += chunk.toString();

    let newlineIndex = this.buffer.indexOf('\n');
    while (newlineIndex !== -1) {
      const jsonLine = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);

      if (!jsonLine.trim()) {
        newlineIndex = this.buffer.indexOf('\n');
        continue;
      }

      try {
        const response = JSON.parse(jsonLine) as SocketResponse;
        const requestId = typeof response.id === 'string' && this.pending.has(response.id)
          ? response.id
          : this.getOldestPendingRequestId();

        if (!requestId) {
          newlineIndex = this.buffer.indexOf('\n');
          continue;
        }

        const pending = this.pending.get(requestId);
        if (!pending) {
          newlineIndex = this.buffer.indexOf('\n');
          continue;
        }

        this.pending.delete(requestId);
        if (response.success === false) {
          pending.reject(this.normalizeResponseError(response.error));
        } else {
          pending.resolve(response.data);
        }
      } catch (error) {
        console.error(`[o8-webview] Failed to parse socket response: ${(error as Error).message}`);
      }

      newlineIndex = this.buffer.indexOf('\n');
    }
  }

  private getOldestPendingRequestId(): string | undefined {
    const pendingIds = Array.from(this.pending.keys()).sort();
    return pendingIds[0];
  }

  private resolveAuthToken(): string | undefined {
    const envToken = process.env.TAURI_MCP_AUTH_TOKEN;
    if (envToken) {
      return envToken;
    }

    try {
      if (!existsSync(this.tokenPath)) {
        return undefined;
      }

      const token = readFileSync(this.tokenPath, 'utf-8').trim();
      return token || undefined;
    } catch {
      return undefined;
    }
  }

  private normalizeConnectionError(error: Error): Error {
    const code = getErrorCode(error);
    if (code === 'ECONNREFUSED' || code === 'ENOENT') {
      return createCodedError(UNAVAILABLE_MESSAGE, code);
    }

    return createCodedError(error.message, code);
  }

  private normalizeResponseError(error: unknown): Error {
    const message = typeof error === 'string' && error.trim()
      ? error
      : 'o8 webview command failed without an error message';
    return new Error(message);
  }
}
