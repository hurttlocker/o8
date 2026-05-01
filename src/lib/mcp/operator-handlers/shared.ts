import type { OrchestratorReviewFinding } from '@/lib/approvals/types';
import type { OrchestratorRuntime } from '@/lib/orchestrator/types';

// ── Types ──

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpToolResult {
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; data: string; mimeType: string }
  >;
  isError?: boolean;
}

// ── API Client State ──

let _apiBase = 'http://localhost:3001';
const MAX_RETRIES = 3;
const RETRY_DELAYS_MS = [500, 1500, 4000];
const FETCH_TIMEOUT_MS = 15_000;

let _apiHealthy = true;
let _lastHealthCheck = 0;
const HEALTH_CHECK_INTERVAL_MS = 10_000;

// ── Panel auth token ──
//
// The Next-side middleware gates /api/orchestrator/*, /api/panel/* (and a
// dozen other prefixes) on EITHER a loopback origin OR `Authorization: Bearer
// <ws-token>` matching ${dataDir}/ws-token. The middleware's loopback bypass
// has been observed to NOT trigger from this MCP server's plain Node fetch
// (no Origin or sec-fetch-site headers; nextUrl.hostname/Host inspection has
// edge cases — see epic-937 t6-mcp REPORT, 2026-04-30). Including the Bearer
// token explicitly is belt-and-suspenders: works whether or not the loopback
// path triggers.
let _cachedPanelToken: { value: string; readAt: number } | null = null;
const PANEL_TOKEN_TTL_MS = 30_000;

function readPanelToken(): string | null {
  const now = Date.now();
  if (_cachedPanelToken && now - _cachedPanelToken.readAt < PANEL_TOKEN_TTL_MS) {
    return _cachedPanelToken.value || null;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { readFileSync, existsSync } = require('node:fs') as typeof import('node:fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { join } = require('node:path') as typeof import('node:path');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { homedir } = require('node:os') as typeof import('node:os');
    // Match middleware's lookup order: CORTEX_IDE_DATA_DIR override, else ~/.o8.
    const dataDir = process.env.CORTEX_IDE_DATA_DIR || join(homedir(), '.o8');
    const tokenPath = join(dataDir, 'ws-token');
    if (!existsSync(tokenPath)) {
      _cachedPanelToken = { value: '', readAt: now };
      return null;
    }
    const value = readFileSync(tokenPath, 'utf-8').trim();
    _cachedPanelToken = { value, readAt: now };
    return value || null;
  } catch {
    return null;
  }
}

export function setApiBase(base: string): void {
  _apiBase = base;
}

export function getApiBase(): string {
  return _apiBase;
}

export async function checkApiHealth(): Promise<boolean> {
  const now = Date.now();
  if (now - _lastHealthCheck < HEALTH_CHECK_INTERVAL_MS) return _apiHealthy;
  _lastHealthCheck = now;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(`${_apiBase}/api/panel/repos`, { signal: controller.signal });
    clearTimeout(timer);
    _apiHealthy = res.ok;
  } catch {
    _apiHealthy = false;
  }
  return _apiHealthy;
}

// ── Helpers ──

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function apiFetch(path: string, init?: RequestInit): Promise<unknown> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)];
      console.error(`[o8-operator] API retry ${attempt}/${MAX_RETRIES} for ${path} in ${delay}ms`);
      await sleep(delay);
    }

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      const panelToken = readPanelToken();
      const baseHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
      if (panelToken) {
        baseHeaders.Authorization = `Bearer ${panelToken}`;
      }
      const res = await fetch(`${_apiBase}${path}`, {
        ...init,
        signal: controller.signal,
        headers: { ...baseHeaders, ...init?.headers },
      });
      clearTimeout(timer);
      _apiHealthy = true;
      return res.json();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      _apiHealthy = false;
      if (lastError.name === 'AbortError') {
        lastError = new Error(`Request to ${path} timed out after ${FETCH_TIMEOUT_MS}ms`);
      }
    }
  }

  throw new Error(
    `o8 API unreachable after ${MAX_RETRIES} retries (${path}): ${lastError?.message ?? 'unknown'}. ` +
    `Expected the o8 backend at ${_apiBase}. ` +
    `Open the o8 desktop app (it launches the backend automatically) or run \`npm run desktop:dev\` from the cortex-ide repo.`,
  );
}

export function textResult(text: string, isError = false): McpToolResult {
  return { content: [{ type: 'text', text }], isError };
}

export function jsonResult(data: unknown): McpToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

export function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function requiredString(args: Record<string, unknown>, key: string) {
  const value = args[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${key} is required`);
  }
  return value.trim();
}

export function optionalString(args: Record<string, unknown>, key: string) {
  const value = args[key];
  return typeof value === 'string' ? value.trim() : '';
}

export function parseMissionRuntime(value: unknown): OrchestratorRuntime {
  if (value === undefined || value === null || value === '') {
    // Fall back to the operator's configured default — respects users who
    // don't have a Codex subscription and set e.g. Gemini or Claude Code.
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { resolveDefaultDispatchRuntimeSync } = require('@/lib/operator/defaults') as typeof import('@/lib/operator/defaults');
      return resolveDefaultDispatchRuntimeSync();
    } catch {
      return 'codex';
    }
  }
  if (value === 'codex' || value === 'claude-code' || value === 'gemini' || value === 'opencode') {
    return value;
  }
  throw new Error('runtime must be one of "codex", "claude-code", "gemini", "opencode"');
}

export function parseIssueList(value: unknown) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('issues must be a non-empty array');
  }

  const issues = value
    .map((entry) => {
      if (typeof entry === 'string') return entry.trim();
      if (typeof entry === 'number' && Number.isFinite(entry)) return String(Math.floor(entry));
      return '';
    })
    .filter(Boolean);

  if (issues.length === 0) {
    throw new Error('issues must contain at least one issue reference');
  }

  return issues;
}

function normalizeFindingSeverity(value: unknown): OrchestratorReviewFinding['severity'] {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (normalized === 'bug' || normalized === 'high' || normalized === 'critical' || normalized === 'error') {
    return 'bug';
  }
  if (
    normalized === 'rule_violation'
    || normalized === 'medium'
    || normalized === 'warning'
    || normalized === 'policy'
  ) {
    return 'rule_violation';
  }
  if (normalized === 'note' || normalized === 'low' || normalized === 'info') {
    return 'note';
  }
  throw new Error(`Unsupported finding severity: ${String(value)}`);
}

function normalizeFindingResolution(value: unknown): OrchestratorReviewFinding['resolution'] {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (normalized === 'fixed' || normalized === 'resolved') {
    return 'fixed';
  }
  if (normalized === 'accepted' || normalized === 'waived' || normalized === 'intentional') {
    return 'accepted';
  }
  if (normalized === 'deferred' || normalized === 'todo' || normalized === 'followup' || normalized === 'follow-up') {
    return 'deferred';
  }
  throw new Error(`Unsupported finding resolution: ${String(value)}`);
}

export function parseReviewFindings(value: unknown): OrchestratorReviewFinding[] {
  if (!Array.isArray(value)) {
    throw new Error('findings must be an array');
  }

  return value.map((finding, index) => {
    if (!finding || typeof finding !== 'object') {
      throw new Error(`findings[${index}] must be an object`);
    }

    const candidate = finding as Record<string, unknown>;
    const file = typeof candidate.file === 'string' ? candidate.file.trim() : '';
    const description = typeof candidate.description === 'string' ? candidate.description.trim() : '';
    if (!file || !description) {
      throw new Error(`findings[${index}] must include file and description`);
    }

    const line = candidate.line;
    if (line !== undefined && (typeof line !== 'number' || !Number.isFinite(line) || line < 1)) {
      throw new Error(`findings[${index}].line must be a positive number`);
    }

    return {
      file,
      line: typeof line === 'number' ? Math.floor(line) : undefined,
      severity: normalizeFindingSeverity(candidate.severity),
      description,
      resolution: normalizeFindingResolution(candidate.resolution),
    };
  });
}
