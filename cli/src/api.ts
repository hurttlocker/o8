/**
 * HTTP client + exit-code mapping for the o8 CLI.
 *
 * Wraps fetch with bearer-token injection and translates HTTP failures into
 * the documented exit-code surface (#2 connection refused, #3 unauthorized,
 * #4 not found, #5 conflict). Every other error bubbles as exit 1.
 */

import type { ResolvedConfig } from './config.js';

export const EXIT = {
  OK: 0,
  INVALID_ARGS: 1,
  CONNECTION_REFUSED: 2,
  UNAUTHORIZED: 3,
  NOT_FOUND: 4,
  CONFLICT: 5,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export class CliError extends Error {
  constructor(
    public code: string,
    message: string,
    public exit: ExitCode,
    public hint?: string,
  ) {
    super(message);
    this.name = 'CliError';
  }
}

export interface ApiRequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /** Treat 404 as success and return null instead of throwing. */
  allowNotFound?: boolean;
}

export interface ApiResponse<T> {
  status: number;
  data: T;
}

function buildUrl(base: string, path: string, query?: ApiRequestOptions['query']): string {
  const url = new URL(path.startsWith('/') ? path : `/${path}`, base);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v == null) continue;
      url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

export async function apiFetch<T = unknown>(
  cfg: ResolvedConfig,
  path: string,
  opts: ApiRequestOptions = {},
): Promise<ApiResponse<T | null>> {
  const url = buildUrl(cfg.apiBase, path, opts.query);
  const headers: Record<string, string> = {
    Accept: 'application/json',
  };
  if (cfg.token) headers.Authorization = `Bearer ${cfg.token}`;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';

  let res: Response;
  try {
    res = await fetch(url, {
      method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Node's fetch surfaces ECONNREFUSED as `cause: { code: 'ECONNREFUSED' }`
    // but the message also contains "fetch failed" + "ECONNREFUSED". Detect
    // either to stay forward-compatible across undici versions.
    if (/ECONNREFUSED|fetch failed/i.test(msg)) {
      throw new CliError(
        'connection_refused',
        `o8 desktop app is not reachable on ${cfg.apiBase}`,
        EXIT.CONNECTION_REFUSED,
        'Launch /Applications/o8.app or run `npm run dev` from the repo. Check ~/.o8/api-port for the picked port.',
      );
    }
    throw new CliError('network_error', msg, EXIT.CONNECTION_REFUSED);
  }

  if (res.status === 401 || res.status === 403) {
    throw new CliError(
      'unauthorized',
      `Server rejected the bearer token (${res.status}).`,
      EXIT.UNAUTHORIZED,
      cfg.token
        ? 'Token did not match ~/.o8/ws-token on the server. Refresh O8_API_TOKEN or rerun from a loopback host.'
        : 'Set O8_API_TOKEN or ensure ~/.o8/ws-token is readable; cross-origin callers require the bearer token.',
    );
  }
  if (res.status === 404) {
    if (opts.allowNotFound) return { status: 404, data: null };
    throw new CliError('not_found', `404 from ${path}`, EXIT.NOT_FOUND);
  }
  if (res.status === 409 || res.status === 422) {
    let detail = '';
    try {
      const json = await res.json() as { error?: string; note?: string; message?: string };
      detail = json.note || json.message || json.error || '';
    } catch {
      /* ignore */
    }
    throw new CliError(
      'conflict',
      `State machine rejected the operation (${res.status})${detail ? `: ${detail}` : '.'}`,
      EXIT.CONFLICT,
    );
  }
  if (!res.ok) {
    throw new CliError(
      'http_error',
      `HTTP ${res.status} from ${path}`,
      EXIT.INVALID_ARGS,
    );
  }

  // Allow empty 204 / non-JSON 200 to coexist; default to null.
  const text = await res.text();
  if (!text) return { status: res.status, data: null };
  try {
    return { status: res.status, data: JSON.parse(text) as T };
  } catch {
    throw new CliError(
      'invalid_response',
      `Non-JSON response from ${path}`,
      EXIT.INVALID_ARGS,
    );
  }
}
