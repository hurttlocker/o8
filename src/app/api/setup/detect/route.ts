import { NextResponse } from 'next/server';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import {
  probeCodexVoiceCapability,
  type CodexVoiceCapability,
} from '@/lib/codex/appserver-probe';
import { scanAndLink } from '@/lib/runtimes/shared/cli-locate';
import { getDataDir } from '@/lib/data-dir-migration';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface DetectedTool {
  id: string;
  name: string;
  detected: boolean;
  /** Runtimes only: binary present AND its required auth (key/login) is configured. */
  ready?: boolean;
  /** When detected but not ready, the one-line fix (e.g. "set GEMINI_API_KEY"). */
  authHint?: string;
  version?: string;
  path?: string;
  details?: Record<string, unknown>;
}

interface DetectionResult {
  tools: DetectedTool[];
  codexVoiceCapability?: CodexVoiceCapability;
  hasAnything: boolean;
  hasAgentSurface: boolean;
  hasCliAgent: boolean;
  hasApiKey: boolean;
  hasEmbeddings: boolean;
  recommendedPath: 'ready' | 'quick-setup' | 'full-wizard';
  summary: string;
  partial?: boolean;
  timedOut?: boolean;
}

const ROUTE_DEADLINE_MS = 10_000;
const MIN_PROBE_TIMEOUT_MS = 50;

function boundedTimeout(timeoutMs: number, deadlineAt?: number): number {
  if (!deadlineAt) return timeoutMs;
  const remaining = deadlineAt - Date.now();
  if (remaining < MIN_PROBE_TIMEOUT_MS) return 0;
  return Math.min(timeoutMs, remaining);
}

function safeExec(cmd: string, args: string[], timeoutMs = 2000, deadlineAt?: number): string {
  const timeout = boundedTimeout(timeoutMs, deadlineAt);
  if (timeout === 0) return '';
  try {
    return execFileSync(cmd, args, {
      encoding: 'utf-8',
      timeout,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

function safeWhich(bin: string, deadlineAt?: number): string {
  const timeout = boundedTimeout(1000, deadlineAt);
  if (timeout === 0) return '';
  try {
    return execFileSync('which', [bin], {
      encoding: 'utf-8',
      timeout,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

/**
 * Locate a runtime CLI: PATH first, then the deterministic well-known-dirs
 * scan (Claude native installer's ~/.local/bin, per-version nvm/fnm bins, bun,
 * pnpm, …). The scan also repairs ~/.o8/bin symlinks so PATH-based consumers
 * work afterward. Bare `which` alone missed real installs whenever the PATH
 * line lived in ~/.zshrc — the v0.1.548 "Claude/Gemini not detected" report.
 */
function locateBin(bin: string, deadlineAt?: number): string {
  const fromPath = safeWhich(bin, deadlineAt);
  if (fromPath) return fromPath;
  try {
    return scanAndLink(bin) ?? '';
  } catch {
    return '';
  }
}

async function safeFetch(url: string, timeoutMs = 2000, deadlineAt?: number): Promise<Response | null> {
  const timeout = boundedTimeout(timeoutMs, deadlineAt);
  if (timeout === 0) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { signal: controller.signal });
    return res;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// --- Runtime auth readiness ---------------------------------------------------
// A green "Ready" dot must mean the runtime will actually RUN, not just that the
// binary is on PATH. Each runtime needs an API key or a CLI login. We check both
// process.env (what the Tauri sidecar forwards to dispatched workers) and the
// .env.local files. Lenient where a login can't be detected reliably (codex /
// claude-code): only flag "auth missing" when we're confident none exists.
function loadConfiguredKeyNames(): Set<string> {
  const home = homedir();
  const repoRoot = process.env.CORTEX_IDE_REPO_ROOT || process.cwd();
  const names = new Set<string>();
  for (const envPath of [join(getDataDir(), '.env.local'), join(repoRoot, '.env.local')]) {
    if (!existsSync(envPath)) continue;
    try {
      for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
        const t = line.trim();
        if (!t || t.startsWith('#')) continue;
        const eq = t.indexOf('=');
        if (eq === -1) continue;
        const k = t.slice(0, eq).trim();
        const v = t.slice(eq + 1).trim();
        if (k && v && v !== '""' && v !== "''") names.add(k);
      }
    } catch { /* ignore */ }
  }
  return names;
}

function keyPresent(names: string[], configured: Set<string>): boolean {
  return names.some((n) => {
    const v = process.env[n];
    return (typeof v === 'string' && v.trim().length > 0) || configured.has(n);
  });
}

function detectCodex(deadlineAt?: number): DetectedTool {
  const home = homedir();
  const path = locateBin('codex', deadlineAt);
  const detected = !!path;
  let version: string | undefined;
  let threadCount = 0;

  if (detected) {
    version = safeExec(path, ['--version'], 2000, deadlineAt);
  }

  const sqlitePath = join(home, '.codex', 'state_5.sqlite');
  if (existsSync(sqlitePath)) {
    const count = safeExec('sqlite3', [
      '-json',
      sqlitePath,
      'SELECT count(*) as cnt FROM threads WHERE archived=0',
    ], 2000, deadlineAt);
    try {
      const parsed = JSON.parse(count) as Array<{ cnt: number }>;
      threadCount = parsed[0]?.cnt ?? 0;
    } catch {
      // ignore
    }
  }

  const authPresent = keyPresent(['OPENAI_API_KEY'], loadConfiguredKeyNames())
    || existsSync(join(home, '.codex', 'auth.json'))
    || threadCount > 0;
  return {
    id: 'codex',
    name: 'Codex CLI',
    detected,
    ready: detected ? authPresent : undefined,
    authHint: detected && !authPresent ? 'run: codex login (or set OPENAI_API_KEY)' : undefined,
    version,
    path,
    details: { threadCount, authPresent },
  };
}

function detectClaudeCode(deadlineAt?: number): DetectedTool {
  const home = homedir();
  const path = locateBin('claude', deadlineAt);
  const detected = !!path;
  let version: string | undefined;
  let sessionCount = 0;

  if (detected) {
    version = safeExec(path, ['--version'], 2000, deadlineAt);
  }

  const projectsDir = join(home, '.claude', 'projects');
  if (existsSync(projectsDir)) {
    try {
      const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
      const files = readdirSync(projectsDir);
      sessionCount = files.filter(f => {
        if (!f.endsWith('.jsonl')) return false;
        try {
          const stat = statSync(join(projectsDir, f));
          return stat.mtimeMs > sevenDaysAgo;
        } catch {
          return false;
        }
      }).length;
    } catch {
      // ignore
    }
  }

  const authPresent = keyPresent(['ANTHROPIC_API_KEY'], loadConfiguredKeyNames())
    || existsSync(join(home, '.claude', '.credentials.json'))
    || sessionCount > 0;
  return {
    id: 'claude-code',
    name: 'Claude Code CLI',
    detected,
    ready: detected ? authPresent : undefined,
    authHint: detected && !authPresent ? 'log in by running claude once (or set ANTHROPIC_API_KEY)' : undefined,
    version,
    path,
    details: { sessionCount, authPresent },
  };
}

function detectGemini(deadlineAt?: number): DetectedTool {
  const path = locateBin('gemini', deadlineAt);
  const detected = !!path;
  let version: string | undefined;

  if (detected) {
    version = safeExec(path, ['--version'], 2000, deadlineAt);
  }

  const authPresent = keyPresent(
    ['GEMINI_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY', 'GOOGLE_AI_API_KEY'],
    loadConfiguredKeyNames(),
  );
  return {
    id: 'gemini',
    name: 'Gemini CLI',
    detected,
    ready: detected ? authPresent : undefined,
    authHint: detected && !authPresent ? 'run: gemini (or set GEMINI_API_KEY)' : undefined,
    version,
    path,
    details: { authPresent },
  };
}

function detectAntigravity(deadlineAt?: number): DetectedTool {
  const path = locateBin('agy', deadlineAt) || locateBin('antigravity', deadlineAt);
  const detected = !!path;
  let version: string | undefined;

  if (detected) {
    version = safeExec(path, ['--version'], 2000, deadlineAt);
  }

  const authPresent = keyPresent(
    ['ANTIGRAVITY_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY', 'GOOGLE_AI_API_KEY'],
    loadConfiguredKeyNames(),
  ) || existsSync(join(homedir(), '.antigravity'));

  return {
    id: 'antigravity',
    name: 'Antigravity CLI',
    detected,
    ready: false,
    authHint: detected
      ? 'Discovery only until agy documents a resumable JSON/event contract.'
      : undefined,
    version,
    path,
    details: { authPresent, dispatchable: false },
  };
}

function detectOpenCode(deadlineAt?: number): DetectedTool {
  const path = locateBin('opencode', deadlineAt);
  const detected = !!path;
  let version: string | undefined;
  let authedProviders: string[] = [];

  if (detected) {
    version = safeExec(path, ['--version'], 2000, deadlineAt);
  }

  // Best-effort: peek at the auth manifest to see which providers the user has authed.
  // Used by the picker to show e.g. "OpenCode · 4 providers" — full sub-row expansion is
  // tracked in issue #512.
  const authPath = join(homedir(), '.local', 'share', 'opencode', 'auth.json');
  if (detected && existsSync(authPath)) {
    try {
      const raw = readFileSync(authPath, 'utf-8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      authedProviders = Object.keys(parsed).sort();
    } catch {
      // ignore parse errors
    }
  }

  const authPresent = authedProviders.length > 0;
  return {
    id: 'opencode',
    name: 'OpenCode CLI',
    detected,
    ready: detected ? authPresent : undefined,
    authHint: detected && !authPresent ? 'run: opencode auth login' : undefined,
    version,
    path,
    details: { authedProviders, authPresent },
  };
}

function detectCursor(deadlineAt?: number): DetectedTool {
  const path = locateBin('cursor-agent', deadlineAt);
  const detected = !!path;
  let version: string | undefined;

  if (detected) {
    version = safeExec(path, ['--version'], 2000, deadlineAt);
  }

  const authPresent = keyPresent(['CURSOR_API_KEY'], loadConfiguredKeyNames())
    || existsSync(join(homedir(), '.cursor'));
  return {
    id: 'cursor',
    name: 'Cursor CLI',
    detected,
    ready: detected ? authPresent : undefined,
    authHint: detected && !authPresent ? 'set CURSOR_API_KEY or sign in to Cursor' : undefined,
    version,
    path,
    details: { authPresent },
  };
}

function detectGrok(deadlineAt?: number): DetectedTool {
  const path = locateBin('grok', deadlineAt);
  const detected = !!path;
  let version: string | undefined;

  if (detected) {
    version = safeExec(path, ['--version'], 2000, deadlineAt);
  }

  const authPresent = keyPresent(['GROK_CODE_XAI_API_KEY'], loadConfiguredKeyNames())
    || existsSync(join(homedir(), '.grok'));
  return {
    id: 'grok',
    name: 'Grok Build',
    detected,
    ready: detected ? authPresent : undefined,
    authHint: detected && !authPresent ? 'set GROK_CODE_XAI_API_KEY or sign in to Grok' : undefined,
    version,
    path,
    details: { authPresent },
  };
}

function detectPi(deadlineAt?: number): DetectedTool {
  const path = locateBin('pi', deadlineAt);
  const detected = !!path;
  let version: string | undefined;

  if (detected) {
    version = safeExec(path, ['--version'], 2000, deadlineAt);
  }

  const authPresent = keyPresent(['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'], loadConfiguredKeyNames())
    || existsSync(join(homedir(), '.pi'));
  return {
    id: 'pi',
    name: 'Pi',
    detected,
    ready: detected ? authPresent : undefined,
    authHint: detected && !authPresent ? 'set ANTHROPIC_API_KEY or OPENAI_API_KEY' : undefined,
    version,
    path,
    details: { authPresent },
  };
}

async function detectOllama(deadlineAt?: number): Promise<DetectedTool> {
  const res = await safeFetch('http://localhost:11434/api/tags', 2000, deadlineAt);
  const detected = res?.ok ?? false;
  let models: string[] = [];
  let hasEmbed = false;

  if (detected && res) {
    try {
      const data = await res.json() as { models?: Array<{ name: string }> };
      models = data.models?.map(m => m.name) ?? [];
      hasEmbed = models.some(m => m.toLowerCase().includes('embed'));
    } catch {
      // ignore
    }
  }

  return {
    id: 'ollama',
    name: 'Ollama',
    detected,
    details: { models, hasEmbed },
  };
}

function detectApiKeys(): DetectedTool {
  const home = homedir();
  // Prefer the explicit env var; otherwise use the current working directory
  // (the Next server's cwd) which is the repo root in both dev and packaged builds.
  const repoRoot = process.env.CORTEX_IDE_REPO_ROOT || process.cwd();
  const paths = [
    join(getDataDir(), '.env.local'),
    join(repoRoot, '.env.local'),
  ];

  // v1: only OpenRouter is exposed in the wizard. The o8 Operator uses Gemini
  // under the hood via GOOGLE_AI_API_KEY which is provisioned silently.
  const keys = {
    OPENROUTER_API_KEY: false,
  };

  for (const envPath of paths) {
    if (!existsSync(envPath)) continue;
    try {
      const content = readFileSync(envPath, 'utf-8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx === -1) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        const value = trimmed.slice(eqIdx + 1).trim();
        if (key in keys && value && value !== '""' && value !== "''") {
          keys[key as keyof typeof keys] = true;
        }
      }
    } catch {
      // ignore
    }
  }

  const providers = Object.entries(keys).map(([key, configured]) => ({
    provider: key.replace('_API_KEY', '').toLowerCase(),
    configured,
  }));

  const detected = providers.some(p => p.configured);

  return {
    id: 'api-keys',
    name: 'API Keys',
    detected,
    details: { providers },
  };
}

function buildSummary(tools: DetectedTool[]): string {
  const parts: string[] = [];

  const claudeCode = tools.find(t => t.id === 'claude-code');
  if (claudeCode?.detected) {
    const sessionCount = (claudeCode.details?.sessionCount as number) ?? 0;
    parts.push(`Claude Code (${sessionCount} sessions)`);
  }

  const codex = tools.find(t => t.id === 'codex');
  if (codex?.detected) {
    const threadCount = (codex.details?.threadCount as number) ?? 0;
    parts.push(`Codex (${threadCount} threads)`);
  }

  const ollama = tools.find(t => t.id === 'ollama');
  if (ollama?.detected) {
    parts.push('Ollama ready');
  }

  if (parts.length === 0) {
    return "No tools detected — let's get you set up";
  }

  return parts.join(' · ');
}

function buildDetectionResult(
  tools: DetectedTool[],
  flags: { partial?: boolean; timedOut?: boolean } = {},
  codexVoiceCapability?: CodexVoiceCapability,
): DetectionResult {
  const hasAgentSurface = false;
  const hasCliAgent = tools.some(t => ['codex', 'claude-code', 'antigravity', 'opencode', 'cursor', 'grok', 'pi'].includes(t.id) && t.detected);
  const hasApiKey = tools.some(t => t.id === 'api-keys' && t.detected);
  const hasEmbeddings = tools.some(t => t.id === 'ollama' && t.detected);
  const hasAnything = hasAgentSurface || hasCliAgent || hasApiKey;

  let recommendedPath: 'ready' | 'quick-setup' | 'full-wizard';
  if (hasAgentSurface && (hasCliAgent || hasApiKey)) {
    recommendedPath = 'ready';
  } else if (hasAnything) {
    recommendedPath = 'quick-setup';
  } else {
    recommendedPath = 'full-wizard';
  }

  const summary = buildSummary(tools);

  const result: DetectionResult = {
    tools,
    codexVoiceCapability,
    hasAnything,
    hasAgentSurface,
    hasCliAgent,
    hasApiKey,
    hasEmbeddings,
    recommendedPath,
    summary,
    ...flags,
  };
  return result;
}

function isPastDeadline(deadlineAt: number) {
  return Date.now() >= deadlineAt;
}

export async function GET() {
  const deadlineAt = Date.now() + ROUTE_DEADLINE_MS;
  const tools: DetectedTool[] = [];
  let codexVoiceCapability: CodexVoiceCapability | undefined;

  if (!isPastDeadline(deadlineAt)) {
    const codex = detectCodex(deadlineAt);
    tools.push(codex);
    codexVoiceCapability = await probeCodexVoiceCapability({
      binaryPath: codex.path || null,
      version: codex.version ?? null,
      timeoutMs: Math.max(MIN_PROBE_TIMEOUT_MS, boundedTimeout(2_500, deadlineAt)),
    });
  }
  if (!isPastDeadline(deadlineAt)) tools.push(detectClaudeCode(deadlineAt));
  if (!isPastDeadline(deadlineAt)) tools.push(detectGemini(deadlineAt));
  if (!isPastDeadline(deadlineAt)) tools.push(detectAntigravity(deadlineAt));
  if (!isPastDeadline(deadlineAt)) tools.push(detectOpenCode(deadlineAt));
  if (!isPastDeadline(deadlineAt)) tools.push(detectCursor(deadlineAt));
  if (!isPastDeadline(deadlineAt)) tools.push(detectGrok(deadlineAt));
  if (!isPastDeadline(deadlineAt)) tools.push(detectPi(deadlineAt));
  if (!isPastDeadline(deadlineAt)) tools.push(await detectOllama(deadlineAt));
  if (!isPastDeadline(deadlineAt)) tools.push(detectApiKeys());

  const timedOut = isPastDeadline(deadlineAt);
  const result = buildDetectionResult(
    tools,
    timedOut ? { partial: true, timedOut: true } : {},
    codexVoiceCapability,
  );

  return NextResponse.json(result);
}
