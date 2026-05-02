import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// CLI usage scrape — reads the on-disk transcripts that Claude Code and
// Codex CLI write per session. Codex gives us the quota directly via
// `rate_limits` blocks; Claude's plan limits aren't exposed, so we sum
// `message.usage` tokens into rolling windows and let the UI render it
// as raw counts (operator can read the trend even without a percent).
//
// Pure read, no fetches. Safe to call from a Next API route.

export interface CliWindow {
  windowMinutes: number;
  usedPercent: number | null;
  resetsAt: number | null;
  tokens: number | null;
}

export interface CliUsage {
  runtime: 'codex' | 'claude';
  primary: CliWindow | null;
  secondary: CliWindow | null;
  source: string | null;
  available: boolean;
  error?: string;
}

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

function parseJsonl(content: string): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch { /* skip malformed */ }
  }
  return rows;
}

function listFilesRecursive(root: string, suffix: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: string[] = [];
    try { entries = readdirSync(dir); } catch { continue; }
    for (const name of entries) {
      const full = join(dir, name);
      let s; try { s = statSync(full); } catch { continue; }
      if (s.isDirectory()) {
        stack.push(full);
      } else if (s.isFile() && full.endsWith(suffix)) {
        out.push(full);
      }
    }
  }
  return out;
}

// ── Codex ───────────────────────────────────────────────────────────────────

export function readCodexUsage(): CliUsage {
  const sessionsRoot = join(homedir(), '.codex', 'sessions');
  if (!existsSync(sessionsRoot)) {
    return { runtime: 'codex', primary: null, secondary: null, source: null, available: false, error: 'no codex sessions dir' };
  }
  const files = listFilesRecursive(sessionsRoot, '.jsonl');
  if (files.length === 0) {
    return { runtime: 'codex', primary: null, secondary: null, source: null, available: false, error: 'no jsonl files' };
  }
  // Newest by mtime first; rate_limits live in the latest token_count event.
  files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);

  for (const file of files.slice(0, 3)) {
    try {
      const rows = parseJsonl(readFileSync(file, 'utf-8'));
      // Walk backward for the most recent token_count.
      for (let i = rows.length - 1; i >= 0; i--) {
        const row = rows[i] as { type?: string; payload?: { type?: string; rate_limits?: { primary?: Record<string, unknown>; secondary?: Record<string, unknown> }; info?: { total_token_usage?: { total_tokens?: number } } } };
        if (row.type !== 'event_msg') continue;
        const payload = row.payload;
        if (!payload || payload.type !== 'token_count') continue;
        const rl = payload.rate_limits;
        if (!rl) continue;
        const toWindow = (raw: Record<string, unknown> | undefined): CliWindow | null => {
          if (!raw) return null;
          const minutes = typeof raw.window_minutes === 'number' ? raw.window_minutes : 0;
          const used = typeof raw.used_percent === 'number' ? raw.used_percent : null;
          const reset = typeof raw.resets_at === 'number' ? raw.resets_at : null;
          return {
            windowMinutes: minutes,
            usedPercent: used,
            resetsAt: reset,
            tokens: null,
          };
        };
        return {
          runtime: 'codex',
          primary: toWindow(rl.primary),
          secondary: toWindow(rl.secondary),
          source: file,
          available: true,
        };
      }
    } catch { /* try next file */ }
  }
  return { runtime: 'codex', primary: null, secondary: null, source: null, available: false, error: 'no token_count event' };
}

// ── Claude Code ─────────────────────────────────────────────────────────────

interface ClaudeTurn {
  ts: number;
  inputTokens: number;
  outputTokens: number;
}

function extractClaudeTurns(file: string, sinceMs: number): ClaudeTurn[] {
  const turns: ClaudeTurn[] = [];
  try {
    const content = readFileSync(file, 'utf-8');
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line) as { timestamp?: string; message?: { usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number } } };
        const usage = row.message?.usage;
        if (!usage) continue;
        const ts = row.timestamp ? Date.parse(row.timestamp) : NaN;
        if (!Number.isFinite(ts) || ts < sinceMs) continue;
        // Exclude cache_read_input_tokens — those are free context replays
        // and would dominate the count without representing real model work.
        // cache_creation counts as input because it's paid (writes to cache).
        const input = (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
        const output = usage.output_tokens ?? 0;
        if (input === 0 && output === 0) continue;
        turns.push({ ts, inputTokens: input, outputTokens: output });
      } catch { /* skip */ }
    }
  } catch { /* skip file */ }
  return turns;
}

export function readClaudeUsage(): CliUsage {
  const projectsRoot = join(homedir(), '.claude', 'projects');
  if (!existsSync(projectsRoot)) {
    return { runtime: 'claude', primary: null, secondary: null, source: null, available: false, error: 'no claude projects dir' };
  }
  const now = Date.now();
  const sevenDaysAgo = now - SEVEN_DAYS_MS;
  const fiveHoursAgo = now - FIVE_HOURS_MS;

  const files = listFilesRecursive(projectsRoot, '.jsonl').filter((f) => {
    try { return statSync(f).mtimeMs >= sevenDaysAgo; } catch { return false; }
  });
  if (files.length === 0) {
    return { runtime: 'claude', primary: null, secondary: null, source: null, available: false, error: 'no recent jsonl' };
  }

  const fiveH = { input: 0, output: 0 };
  const weekly = { input: 0, output: 0 };
  let oldestTs = now;

  for (const file of files) {
    const turns = extractClaudeTurns(file, sevenDaysAgo);
    for (const t of turns) {
      weekly.input += t.inputTokens;
      weekly.output += t.outputTokens;
      if (t.ts >= fiveHoursAgo) {
        fiveH.input += t.inputTokens;
        fiveH.output += t.outputTokens;
      }
      if (t.ts < oldestTs) oldestTs = t.ts;
    }
  }

  const fiveHTokens = fiveH.input + fiveH.output;
  const weeklyTokens = weekly.input + weekly.output;
  // Anthropic doesn't expose Max plan caps in the JSONL. Leave usedPercent
  // null — UI shows raw token counts. Reset estimation: 5h window slides
  // forward continuously from the OLDEST in-window turn, not a fixed clock.
  const primaryReset = oldestTs >= fiveHoursAgo
    ? Math.floor((oldestTs + FIVE_HOURS_MS) / 1000)
    : null;
  return {
    runtime: 'claude',
    primary: {
      windowMinutes: 300,
      usedPercent: null,
      resetsAt: primaryReset,
      tokens: fiveHTokens,
    },
    secondary: {
      windowMinutes: 10080,
      usedPercent: null,
      resetsAt: null,
      tokens: weeklyTokens,
    },
    source: projectsRoot,
    available: true,
  };
}

export interface CliUsageSnapshot {
  generatedAt: number;
  codex: CliUsage;
  claude: CliUsage;
}

export function readAllCliUsage(): CliUsageSnapshot {
  return {
    generatedAt: Date.now(),
    codex: readCodexUsage(),
    claude: readClaudeUsage(),
  };
}
