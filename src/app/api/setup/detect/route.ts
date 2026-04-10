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
  hasMemory: boolean;
  hasEmbeddings: boolean;
  recommendedPath: 'ready' | 'quick-setup' | 'full-wizard';
  summary: string;
}

function safeExec(cmd: string, args: string[], timeoutMs = 2000): string {
  try {
    return execFileSync(cmd, args, {
      encoding: 'utf-8',
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

function safeWhich(bin: string): string {
  try {
    return execFileSync('which', [bin], {
      encoding: 'utf-8',
      timeout: 1000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

async function safeFetch(url: string, timeoutMs = 2000): Promise<Response | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    return res;
  } catch {
    return null;
  }
}

function detectCodex(): DetectedTool {
  const home = homedir();
  const path = safeWhich('codex');
  const detected = !!path;
  let version: string | undefined;
  let threadCount = 0;

  if (detected) {
    version = safeExec('codex', ['--version']);
  }

  const sqlitePath = join(home, '.codex', 'state_5.sqlite');
  if (existsSync(sqlitePath)) {
    const count = safeExec('sqlite3', [
      '-json',
      sqlitePath,
      'SELECT count(*) as cnt FROM threads WHERE archived=0',
    ]);
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

function detectClaudeCode(): DetectedTool {
  const home = homedir();
  const path = safeWhich('claude');
  const detected = !!path;
  let version: string | undefined;
  let sessionCount = 0;

  if (detected) {
    version = safeExec('claude', ['--version'], 2000);
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

function detectGemini(): DetectedTool {
  const path = safeWhich('gemini');
  const detected = !!path;
  let version: string | undefined;

  if (detected) {
    version = safeExec('gemini', ['--version']);
  }

  return {
    id: 'gemini',
    name: 'Gemini CLI',
    detected,
    version,
    path,
  };
}

function detectCortex(): DetectedTool {
  const home = homedir();
  let path = join(home, 'bin', 'cortex');
  if (!existsSync(path)) {
    path = safeWhich('cortex');
  }
  const detected = !!path && existsSync(path);
  let version: string | undefined;
  let memoryCount = 0;
  let factCount = 0;

  if (detected) {
    version = safeExec(path, ['version'], 2000);
  }

  const dbPath = join(home, '.cortex', 'cortex.db');
  if (existsSync(dbPath) && detected) {
    const healthRaw = safeExec(path, ['health', '--json'], 3000);
    if (healthRaw) {
      try {
        const health = JSON.parse(healthRaw) as { memories?: number; facts?: number };
        memoryCount = health.memories ?? 0;
        factCount = health.facts ?? 0;
      } catch {
        // ignore parse errors
      }
    }
  }

  return {
    id: 'cortex',
    name: 'Cortex Memory',
    detected,
    version,
    path,
    details: { memoryCount, factCount, dbPath },
  };
}

async function detectOllama(): Promise<DetectedTool> {
  const res = await safeFetch('http://localhost:11434/api/tags', 2000);
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
    join(home, '.cortex-ide', '.env.local'),
    join(repoRoot, '.env.local'),
  ];

  const keys = {
    ANTHROPIC_API_KEY: false,
    OPENAI_API_KEY: false,
    GOOGLE_AI_API_KEY: false,
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

  const cortex = tools.find(t => t.id === 'cortex');
  if (cortex?.detected) {
    const factCount = (cortex.details?.factCount as number) ?? 0;
    const k = Math.floor(factCount / 1000);
    parts.push(`Cortex Memory (${k}K facts)`);
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

export async function GET() {
  const tools: DetectedTool[] = [
    detectCodex(),
    detectClaudeCode(),
    detectGemini(),
    detectCortex(),
    await detectOllama(),
    detectApiKeys(),
  ];

  const hasAgentSurface = false;
  const hasCliAgent = tools.some(t => ['codex', 'claude-code', 'gemini'].includes(t.id) && t.detected);
  const hasApiKey = tools.some(t => t.id === 'api-keys' && t.detected);
  const hasMemory = tools.some(t => t.id === 'cortex' && t.detected);
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
    hasMemory,
    hasEmbeddings,
    recommendedPath,
    summary,
  };

  return NextResponse.json(result);
}
