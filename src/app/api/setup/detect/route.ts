import { NextResponse } from 'next/server';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface DetectedTool {
  id: string;
  name: string;
  detected: boolean;
  version?: string;
  path?: string;
  details?: Record<string, unknown>;
}

interface DetectionResult {
  tools: DetectedTool[];
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

function detectCodex(deadlineAt?: number): DetectedTool {
  const home = homedir();
  const path = safeWhich('codex', deadlineAt);
  const detected = !!path;
  let version: string | undefined;
  let threadCount = 0;

  if (detected) {
    version = safeExec('codex', ['--version'], 2000, deadlineAt);
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

  return {
    id: 'codex',
    name: 'Codex CLI',
    detected,
    version,
    path,
    details: { threadCount },
  };
}

function detectClaudeCode(deadlineAt?: number): DetectedTool {
  const home = homedir();
  const path = safeWhich('claude', deadlineAt);
  const detected = !!path;
  let version: string | undefined;
  let sessionCount = 0;

  if (detected) {
    version = safeExec('claude', ['--version'], 2000, deadlineAt);
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

  return {
    id: 'claude-code',
    name: 'Claude Code CLI',
    detected,
    version,
    path,
    details: { sessionCount },
  };
}

function detectGemini(deadlineAt?: number): DetectedTool {
  const path = safeWhich('gemini', deadlineAt);
  const detected = !!path;
  let version: string | undefined;

  if (detected) {
    version = safeExec('gemini', ['--version'], 2000, deadlineAt);
  }

  return {
    id: 'gemini',
    name: 'Gemini CLI',
    detected,
    version,
    path,
  };
}

function detectOpenCode(deadlineAt?: number): DetectedTool {
  const path = safeWhich('opencode', deadlineAt);
  const detected = !!path;
  let version: string | undefined;
  let authedProviders: string[] = [];

  if (detected) {
    version = safeExec('opencode', ['--version'], 2000, deadlineAt);
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

  return {
    id: 'opencode',
    name: 'OpenCode CLI',
    detected,
    version,
    path,
    details: { authedProviders },
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
    join(home, '.o8', '.env.local'),
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

function buildDetectionResult(tools: DetectedTool[], flags: { partial?: boolean; timedOut?: boolean } = {}): DetectionResult {
  const hasAgentSurface = false;
  const hasCliAgent = tools.some(t => ['codex', 'claude-code', 'gemini', 'opencode'].includes(t.id) && t.detected);
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

  if (!isPastDeadline(deadlineAt)) tools.push(detectCodex(deadlineAt));
  if (!isPastDeadline(deadlineAt)) tools.push(detectClaudeCode(deadlineAt));
  if (!isPastDeadline(deadlineAt)) tools.push(detectGemini(deadlineAt));
  if (!isPastDeadline(deadlineAt)) tools.push(detectOpenCode(deadlineAt));
  if (!isPastDeadline(deadlineAt)) tools.push(await detectOllama(deadlineAt));
  if (!isPastDeadline(deadlineAt)) tools.push(detectApiKeys());

  const timedOut = isPastDeadline(deadlineAt);
  const result = buildDetectionResult(tools, timedOut ? { partial: true, timedOut: true } : {});

  return NextResponse.json(result);
}
