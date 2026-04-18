/**
 * Claude Code Runtime Adapter
 *
 * Discovers Claude Code sessions from ~/.claude/projects/,
 * reads transcripts from JSONL files, and manages lifecycle
 * via the `claude` CLI.
 */

import { execFile, spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { access, mkdtemp, open, readdir, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type {
  AgentRuntime,
  RuntimeCapabilities,
  RuntimeSession,
  RuntimeTranscriptEntry,
  RuntimeChangedFile,
  RuntimeActionResult,
  LaunchOptions,
  RuntimeTelemetry,
} from '@/lib/runtimes/types';
import {
  detectCompactionEvents,
  jsonlUsageTotal,
  type JsonlEntry,
} from '@/lib/runtimes/compaction-detector';
import { parseSessionCost } from '@/lib/runtimes/cost-parser';
import { tmuxSessionName } from '@/lib/terminal/tmux';
import { spawnBridgeTerminalSession } from '@/lib/runtime/pty-bridge';
import { getRuntimeTerminalSession, registerRuntimeTerminalSession } from '@/lib/runtime/terminal-session-registry';
import { monitorUsageDispatch, readClaudeUsageSnapshot, type UsageSnapshot } from '@/lib/usage-log';

const execFileAsync = promisify(execFile);

const CLAUDE_HOME = process.env.CLAUDE_HOME || path.join(os.homedir(), '.claude');
const CLAUDE_BIN = process.env.CLAUDE_BIN || path.join(os.homedir(), '.local', 'bin', 'claude');
const CLAUDE_PROJECTS_DIR = path.join(CLAUDE_HOME, 'projects');
const RECENT_WINDOW_MS = 6 * 60 * 60_000; // 6 hours
const LAUNCH_SESSION_ID_TIMEOUT_MS = 12_000;
const CLAUDE_DEFAULT_CONTEXT_WINDOW_TOKENS = 200_000;
const CLAUDE_ONE_MILLION_CONTEXT_WINDOW_TOKENS = 1_000_000;
const CLAUDE_CONTEXT_RESERVE_MAX_OUTPUT_TOKENS = 20_000;

const capabilities: RuntimeCapabilities = {
  discover: true,
  readTranscript: true,
  launch: true,
  resume: true,
  interrupt: true,
  reviewDiffs: true,
  costTelemetry: true,
  streaming: true,
};

// ── Path helpers ──

/**
 * Decode Claude Code's project directory name back to a filesystem path.
 * e.g., "-Users-alice-projects" → "/Users/alice/projects"
 */
function decodeProjectPath(encodedName: string): string {
  // Replace leading dash with /, then remaining dashes with /
  // But we need to be careful: the encoding replaces / with -
  return '/' + encodedName.slice(1).replace(/-/g, '/');
}

function shortenPath(filePath: string): string {
  return filePath.replace(`${os.homedir()}/`, '~/');
}

function normalizeFsPath(filePath?: string) {
  return (filePath ?? '').replace(/\/+$/, '');
}

function encodeProjectPath(projectPath: string): string {
  const resolved = path.resolve(projectPath);
  return `-${resolved.replace(/^\/+/, '').replace(/\//g, '-')}`;
}

function quoteShellArg(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

async function spawnDetached(command: string, args: string[], cwd: string) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: 'ignore',
      detached: true,
      cwd,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
    });

    const handleSpawn = () => {
      child.off('error', handleError);
      child.unref();
      resolve();
    };
    const handleError = (error: Error) => {
      child.off('spawn', handleSpawn);
      reject(error);
    };

    child.once('spawn', handleSpawn);
    child.once('error', handleError);
  });
}

async function listProjectSessionIds(projectPath: string) {
  const projectDir = path.join(CLAUDE_PROJECTS_DIR, encodeProjectPath(projectPath));
  const entries = await readdir(projectDir).catch(() => []);
  return new Set(
    entries
      .filter((entry) => entry.endsWith('.jsonl'))
      .map((entry) => entry.replace(/\.jsonl$/, '')),
  );
}

async function findSessionJsonl(sessionId: string) {
  try {
    const projectDirs = await readdir(CLAUDE_PROJECTS_DIR);
    for (const projectDirName of projectDirs) {
      const jsonlPath = path.join(CLAUDE_PROJECTS_DIR, projectDirName, `${sessionId}.jsonl`);
      try {
        await access(jsonlPath);
        return { jsonlPath, projectDirName };
      } catch {
        continue;
      }
    }
  } catch {
    return null;
  }

  return null;
}

async function readSessionCwd(jsonlPath: string) {
  try {
    const raw = await readFile(jsonlPath, 'utf8');
    for (const line of raw.split('\n')) {
      if (!line) continue;
      try {
        const parsed = JSON.parse(line) as ClaudeCodeMessage;
        if (typeof parsed.cwd === 'string' && parsed.cwd) {
          return parsed.cwd;
        }
      } catch {
        continue;
      }
    }
  } catch {
    return undefined;
  }

  return undefined;
}

async function resolveSessionProjectPath(sessionId: string) {
  const match = await findSessionJsonl(sessionId);
  if (!match) {
    return null;
  }

  const cwd = await readSessionCwd(match.jsonlPath);
  return {
    jsonlPath: match.jsonlPath,
    projectDirName: match.projectDirName,
    projectPath: cwd ?? decodeProjectPath(match.projectDirName),
    cwd,
  };
}

async function resolveMostRecentSessionIdForCwd(cwd: string) {
  const encodedDir = `-${cwd.replace(/^\/+/, '').replace(/\//g, '-')}`;
  const projectDirPath = path.join(CLAUDE_PROJECTS_DIR, encodedDir);
  const dirEntries = await readdir(projectDirPath).catch(() => [] as string[]);
  const jsonlFiles = dirEntries.filter((entry) => entry.endsWith('.jsonl'));
  if (jsonlFiles.length === 0) {
    return null;
  }

  const withStats = await Promise.all(
    jsonlFiles.map(async (entry) => {
      const jsonlPath = path.join(projectDirPath, entry);
      const jsonlStat = await stat(jsonlPath).catch(() => null);
      return {
        file: entry,
        mtime: jsonlStat?.mtimeMs ?? 0,
      };
    }),
  );
  withStats.sort((left, right) => right.mtime - left.mtime);

  return withStats[0]?.file.replace('.jsonl', '') ?? null;
}

async function resolveLiveSessionIdFromPid(pid: number) {
  if (!Number.isFinite(pid) || pid <= 0) {
    return null;
  }

  try {
    const { stdout: cwdOut } = await execFileAsync(
      'lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'],
      { timeout: 2000 },
    );
    const cwdLine = cwdOut.split('\n').find((line) => line.startsWith('n/'));
    const cwd = cwdLine?.slice(1);
    return cwd ? await resolveMostRecentSessionIdForCwd(cwd) : null;
  } catch {
    return null;
  }
}

function extractSessionIdFromOutput(raw: string) {
  for (const line of raw.split('\n').filter(Boolean)) {
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      if (typeof event.session_id === 'string' && event.session_id) {
        return event.session_id;
      }
      if (typeof event.sessionId === 'string' && event.sessionId) {
        return event.sessionId;
      }
    } catch {
      continue;
    }
  }

  return null;
}

async function waitForLaunchSessionId(
  outputPath: string,
  projectPaths: string[],
  knownSessionIds: Map<string, Set<string>>,
  timeoutMs = LAUNCH_SESSION_ID_TIMEOUT_MS,
) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const raw = await readFile(outputPath, 'utf8').catch(() => '');
    const streamedSessionId = extractSessionIdFromOutput(raw);
    if (streamedSessionId) {
      return streamedSessionId;
    }

    for (const projectPath of projectPaths) {
      const known = knownSessionIds.get(projectPath) ?? new Set<string>();
      const current = await listProjectSessionIds(projectPath);
      const nextId = [...current].find((sessionId) => !known.has(sessionId));
      if (nextId) {
        return nextId;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  return null;
}

async function waitForClaudeRunToFinish(sessionId: string, startedAtMs: number) {
  let lastMtimeMs = 0;
  let settledPolls = 0;

  for (let attempt = 0; attempt < 7200; attempt += 1) {
    const sessionProject = await resolveSessionProjectPath(sessionId).catch(() => null);
    const sessionCwd = normalizeFsPath(sessionProject?.cwd ?? sessionProject?.projectPath);
    const liveProcesses = sessionCwd ? await findLiveClaudeProcesses().catch(() => []) : [];
    const runningInSessionCwd = sessionCwd
      ? liveProcesses.some((proc) => {
          const procCwd = normalizeFsPath(proc.cwd);
          return Boolean(procCwd) && (
            procCwd === sessionCwd
            || procCwd.startsWith(`${sessionCwd}/`)
            || sessionCwd.startsWith(`${procCwd}/`)
          );
        })
      : false;
    const fileStat = sessionProject?.jsonlPath ? await stat(sessionProject.jsonlPath).catch(() => null) : null;
    const nextMtimeMs = fileStat?.mtimeMs ?? lastMtimeMs;

    if (nextMtimeMs !== lastMtimeMs) {
      lastMtimeMs = nextMtimeMs;
      settledPolls = 0;
    } else if (!runningInSessionCwd && sessionProject?.jsonlPath) {
      settledPolls += 1;
      if (settledPolls >= 2) {
        return {
          finishedAtMs: Math.max(startedAtMs, lastMtimeMs || Date.now()),
          snapshot: sessionProject?.jsonlPath ? await readClaudeUsageSnapshot(sessionProject.jsonlPath).catch(() => null) : null,
        };
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  const sessionProject = await resolveSessionProjectPath(sessionId).catch(() => null);
  return {
    finishedAtMs: Math.max(startedAtMs, Date.now()),
    snapshot: sessionProject?.jsonlPath ? await readClaudeUsageSnapshot(sessionProject.jsonlPath).catch(() => null) : null,
  };
}

/**
 * Extract a human-readable project name from the path.
 * e.g., "/Users/alice/projects/cortex-ide" → "cortex-ide"
 */
function projectDisplayName(projectPath: string): string {
  return path.basename(projectPath) || projectPath;
}

// ── Session JSONL parsing ──

interface ClaudeCodeMessage extends JsonlEntry {
  type: string;
  subtype?: string;
  uuid?: string;
  timestamp?: string;
  sessionId?: string;
  cwd?: string;
  gitBranch?: string;
  content?: string;
  isMeta?: boolean;
  isCompactSummary?: boolean;
  isVisibleInTranscriptOnly?: boolean;
  compactMetadata?: {
    trigger?: string;
    preTokens?: number;
    postTokens?: number;
    tokensAfter?: number;
  };
  usage?: Record<string, number>;
  message?: {
    role?: string;
    content?: MessageContent;
    model?: string;
    usage?: Record<string, unknown>;
  };
}

type ContentBlock = {
  type: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string | Array<{ type: string; text?: string }>;
};

type MessageContent = string | ContentBlock[];

function extractTextFromContent(content: MessageContent): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  const parts: string[] = [];
  for (const block of content) {
    if (block.type === 'text' && block.text) {
      parts.push(block.text);
    } else if (block.type === 'tool_use' && block.name) {
      const desc = block.input && typeof block.input === 'object'
        ? (block.input as Record<string, unknown>).description ?? (block.input as Record<string, unknown>).command ?? ''
        : '';
      parts.push(`[Tool: ${block.name}${desc ? ` — ${String(desc).slice(0, 100)}` : ''}]`);
    } else if (block.type === 'tool_result') {
      const resultContent = block.content;
      if (typeof resultContent === 'string') {
        parts.push(resultContent.slice(0, 200));
      } else if (Array.isArray(resultContent)) {
        for (const sub of resultContent) {
          if (sub.type === 'text' && sub.text) {
            parts.push(sub.text.slice(0, 200));
          }
        }
      }
    }
  }
  return parts.join('\n');
}

function extractToolName(content: MessageContent): string | undefined {
  if (!Array.isArray(content)) return undefined;
  for (const block of content) {
    if (block.type === 'tool_use' && block.name) return block.name;
  }
  return undefined;
}

function extractFilePath(content: MessageContent): string | undefined {
  if (!Array.isArray(content)) return undefined;
  for (const block of content) {
    if (block.type === 'tool_use' && block.input && typeof block.input === 'object') {
      const input = block.input as Record<string, unknown>;
      if (typeof input.file_path === 'string') return input.file_path;
      if (typeof input.path === 'string') return input.path;
    }
  }
  return undefined;
}

function buildCompactionTranscriptEntry(
  event: ReturnType<typeof detectCompactionEvents>[number],
): RuntimeTranscriptEntry {
  return {
    id: event.id,
    role: 'system',
    text: 'Context compaction event',
    timestamp: event.timestamp,
    type: 'compaction',
    compaction: event,
  };
}

const CONTEXT_WINDOW_SIGNAL_PATTERNS = {
  oneMillion: [
    /set model to .*1m context/i,
    /(?:^|[\s(])(?:opus|sonnet)\[1m\](?:[\s)]|$)/i,
    /--model\s+(?:opus|sonnet)\[1m\]/i,
    /anthropic_model=(?:opus|sonnet)\[1m\]/i,
    /\/model\s+(?:opus|sonnet)\[1m\]/i,
  ],
  default: [
    /set model to .*opus 4\.6(?!.*1m context)/i,
    /set model to .*sonnet 4\.6(?!.*1m context)/i,
    /--model\s+(?:opus|sonnet)(?!\[1m\])/i,
    /anthropic_model=(?:opus|sonnet)(?!\[1m\])/i,
    /\/model\s+(?:opus|sonnet)(?!\[1m\])/i,
  ],
};

const MAX_OUTPUT_TOKEN_KEYS = new Set([
  'maxOutput',
  'max_output',
  'maxOutputTokens',
  'max_output_tokens',
  'maxTokens',
  'max_tokens',
]);

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stripAnsi(value: string) {
  return value.replace(/\u001b\[[0-9;]*m/g, '');
}

function extractEntryText(entry: ClaudeCodeMessage): string {
  if (typeof entry.content === 'string' && entry.content) {
    return entry.content;
  }

  if (typeof entry.message?.content === 'string') {
    return entry.message.content;
  }

  if (Array.isArray(entry.message?.content)) {
    return extractTextFromContent(entry.message.content);
  }

  return '';
}

function extractExplicitContextWindowSignal(entry: ClaudeCodeMessage): number | undefined {
  const text = stripAnsi(extractEntryText(entry)).trim();
  if (!text) return undefined;

  if (CONTEXT_WINDOW_SIGNAL_PATTERNS.oneMillion.some((pattern) => pattern.test(text))) {
    return CLAUDE_ONE_MILLION_CONTEXT_WINDOW_TOKENS;
  }

  if (CONTEXT_WINDOW_SIGNAL_PATTERNS.default.some((pattern) => pattern.test(text))) {
    return CLAUDE_DEFAULT_CONTEXT_WINDOW_TOKENS;
  }

  return undefined;
}

function inferContextWindowFromModel(model?: string): number | undefined {
  const normalized = model?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized.includes('claude-opus-4-6')) return CLAUDE_DEFAULT_CONTEXT_WINDOW_TOKENS;
  if (normalized.includes('claude-sonnet-4-6')) return CLAUDE_DEFAULT_CONTEXT_WINDOW_TOKENS;
  if (normalized.startsWith('claude-')) return CLAUDE_DEFAULT_CONTEXT_WINDOW_TOKENS;
  return undefined;
}

function findNumericMetadataValue(
  value: unknown,
  keys: Set<string>,
  depth = 0,
): number | undefined {
  if (depth > 4 || value == null) return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findNumericMetadataValue(item, keys, depth + 1);
      if (found != null) return found;
    }
    return undefined;
  }
  if (typeof value !== 'object') return undefined;

  for (const [key, candidate] of Object.entries(value)) {
    if (keys.has(key)) {
      const numeric = asFiniteNumber(candidate);
      if (numeric != null) return numeric;
    }
    const nested = findNumericMetadataValue(candidate, keys, depth + 1);
    if (nested != null) return nested;
  }

  return undefined;
}

function calculateContextUsedPercent(
  totalTokens: number,
  contextWindow: number,
  maxOutputTokens?: number,
): number | undefined {
  if (!Number.isFinite(totalTokens) || totalTokens <= 0) {
    return undefined;
  }

  const reservedOutputTokens = Math.min(
    maxOutputTokens ?? CLAUDE_CONTEXT_RESERVE_MAX_OUTPUT_TOKENS,
    CLAUDE_CONTEXT_RESERVE_MAX_OUTPUT_TOKENS,
  );
  const effectiveContextWindow = contextWindow - reservedOutputTokens;
  if (effectiveContextWindow <= 0) {
    return undefined;
  }

  return Math.max(
    0,
    Math.min(100, Math.round((totalTokens / effectiveContextWindow) * 100)),
  );
}

type ClaudeTailMetadata = {
  model?: string;
  contextUsedPercent?: number;
  hasErrorInTail: boolean;
};

function extractClaudeTailMetadata(
  lines: string[],
  initialModel?: string,
  initialContextWindowTokens?: number,
): ClaudeTailMetadata {
  let model = initialModel;
  let totalTokens: number | undefined;
  let maxOutputTokens: number | undefined;
  let explicitContextWindowTokens: number | undefined;

  for (const line of [...lines].reverse()) {
    try {
      const parsed = JSON.parse(line) as ClaudeCodeMessage;
      if (!model && parsed.message?.model) {
        model = parsed.message.model;
      }
      if (explicitContextWindowTokens == null) {
        explicitContextWindowTokens = extractExplicitContextWindowSignal(parsed);
      }
      if (maxOutputTokens == null) {
        maxOutputTokens = findNumericMetadataValue(parsed, MAX_OUTPUT_TOKEN_KEYS);
      }
      if (totalTokens == null) {
        totalTokens = jsonlUsageTotal(parsed.message?.usage);
      }
      if (model && totalTokens != null && explicitContextWindowTokens != null && maxOutputTokens != null) {
        break;
      }
    } catch {
      continue;
    }
  }

  const recentTail = lines.slice(-10);
  let hasErrorInTail = false;
  for (const line of recentTail) {
    try {
      const parsed = JSON.parse(line) as ClaudeCodeMessage;
      if (parsed.type === 'system' && typeof parsed.message?.content === 'string') {
        const lower = parsed.message.content.toLowerCase();
        if (
          lower.includes('error')
          || lower.includes('crash')
          || lower.includes('fatal')
          || lower.includes('oom')
          || lower.includes('killed')
        ) {
          hasErrorInTail = true;
          break;
        }
      }
    } catch {
      continue;
    }
  }

  const contextWindow =
    explicitContextWindowTokens
    ?? initialContextWindowTokens
    ?? inferContextWindowFromModel(model);

  return {
    model,
    contextUsedPercent: totalTokens != null && contextWindow != null
      ? calculateContextUsedPercent(totalTokens, contextWindow, maxOutputTokens)
      : undefined,
    hasErrorInTail,
  };
}

// ── Session metadata ──

interface SessionMeta {
  sessionId: string;
  projectDir: string;
  projectPath: string;
  jsonlPath: string;
  lastModified: Date;
  firstUserMessage?: string;
  cwd?: string;
  gitBranch?: string;
  model?: string;
  contextUsedPercent?: number;
  hasErrorInTail?: boolean;
}

// ── Positional read helpers ──

const HEAD_BYTES = 8 * 1024;       // 8KB for first 20 lines of metadata
const TAIL_BYTES = 64 * 1024;      // 64KB for tail windows (50 + 30 + 10 lines)
const TRANSCRIPT_TAIL_BYTES = 512 * 1024; // 512KB for transcript tail reads (compaction summaries can be large)

/** mtime cache: avoids re-reading files that haven't changed */
const sessionMetaCache = new Map<string, { mtimeMs: number; meta: SessionMeta }>();

/**
 * Read the first `bytes` of a file via positional read.
 * Returns the decoded string. For files smaller than `bytes`, returns the full content.
 */
async function readHead(filePath: string, fileSize: number, bytes: number): Promise<string> {
  const readLen = Math.min(bytes, fileSize);
  if (readLen === 0) return '';
  const fh = await open(filePath, 'r');
  try {
    const buf = Buffer.alloc(readLen);
    const { bytesRead } = await fh.read(buf, 0, readLen, 0);
    return buf.toString('utf-8', 0, bytesRead);
  } finally {
    await fh.close();
  }
}

/**
 * Read the last `bytes` of a file via positional read.
 * Returns the decoded string. For files smaller than `bytes`, returns the full content.
 */
async function readTail(filePath: string, fileSize: number, bytes: number): Promise<string> {
  const offset = Math.max(0, fileSize - bytes);
  const readLen = fileSize - offset;
  if (readLen === 0) return '';
  const fh = await open(filePath, 'r');
  try {
    const buf = Buffer.alloc(readLen);
    const { bytesRead } = await fh.read(buf, 0, readLen, offset);
    return buf.toString('utf-8', 0, bytesRead);
  } finally {
    await fh.close();
  }
}

/**
 * Parse head lines (first N) from a raw head-read string.
 * Discards the last element if it's a partial line (cut mid-JSON).
 */
function headLines(raw: string, count: number): string[] {
  const lines = raw.split('\n').filter(Boolean);
  // Last line may be truncated at the byte boundary — drop it
  if (lines.length > 0 && !raw.endsWith('\n')) lines.pop();
  return lines.slice(0, count);
}

/**
 * Parse tail lines (last N) from a raw tail-read string.
 * Discards the first element if it's a partial line (cut mid-JSON).
 */
function tailLines(raw: string, count: number): string[] {
  const lines = raw.split('\n').filter(Boolean);
  // First line may be truncated at the byte boundary — drop it
  if (lines.length > 0 && !raw.startsWith('\n') && raw.length > 0) lines.shift();
  return lines.slice(-count);
}

type ClaudeHeadMetadata = {
  firstUserMessage?: string;
  cwd?: string;
  gitBranch?: string;
  model?: string;
  explicitContextWindowTokens?: number;
};

function extractClaudeHeadMetadata(lines: string[]): ClaudeHeadMetadata {
  let firstUserMessage: string | undefined;
  let cwd: string | undefined;
  let gitBranch: string | undefined;
  let model: string | undefined;
  let explicitContextWindowTokens: number | undefined;

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as ClaudeCodeMessage;
      if (parsed.cwd && !cwd) cwd = parsed.cwd;
      if (parsed.gitBranch && !gitBranch) gitBranch = parsed.gitBranch;
      if (parsed.message?.model && !model) model = parsed.message.model;
      if (explicitContextWindowTokens == null) {
        explicitContextWindowTokens = extractExplicitContextWindowSignal(parsed);
      }
      if (parsed.type === 'user' && parsed.message?.content && !firstUserMessage) {
        const text = typeof parsed.message.content === 'string'
          ? parsed.message.content
          : extractTextFromContent(parsed.message.content);
        firstUserMessage = text.slice(0, 200);
      }
      if (cwd && gitBranch && firstUserMessage) break;
    } catch {
      continue;
    }
  }

  return {
    firstUserMessage,
    cwd,
    gitBranch,
    model,
    explicitContextWindowTokens,
  };
}

async function discoverProjectSessions(projectDirName: string): Promise<SessionMeta[]> {
  const projectDir = path.join(CLAUDE_PROJECTS_DIR, projectDirName);

  let entries: string[];
  try {
    entries = await readdir(projectDir);
  } catch {
    return [];
  }

  const sessions: SessionMeta[] = [];
  const now = Date.now();

  for (const entry of entries) {
    if (!entry.endsWith('.jsonl')) continue;
    const sessionId = entry.replace('.jsonl', '');
    const jsonlPath = path.join(projectDir, entry);

    try {
      const fileStat = await stat(jsonlPath);
      // Skip sessions older than the recent window
      if (now - fileStat.mtimeMs > RECENT_WINDOW_MS) continue;

      // Check mtime cache — skip file I/O if unchanged
      const cached = sessionMetaCache.get(jsonlPath);
      if (cached && cached.mtimeMs === fileStat.mtimeMs) {
        sessions.push(cached.meta);
        continue;
      }

      const fileSize = fileStat.size;

      const headRaw = await readHead(jsonlPath, fileSize, HEAD_BYTES);
      const headMetadata = extractClaudeHeadMetadata(headLines(headRaw, 20));
      const tailRaw = await readTail(jsonlPath, fileSize, TAIL_BYTES);
      const tailMetadata = extractClaudeTailMetadata(
        tailLines(tailRaw, Number.MAX_SAFE_INTEGER),
        headMetadata.model,
        headMetadata.explicitContextWindowTokens,
      );
      const projectPath = headMetadata.cwd ?? decodeProjectPath(projectDirName);

      const meta: SessionMeta = {
        sessionId,
        projectDir,
        projectPath,
        jsonlPath,
        lastModified: fileStat.mtime,
        firstUserMessage: headMetadata.firstUserMessage,
        cwd: headMetadata.cwd ?? projectPath,
        gitBranch: headMetadata.gitBranch,
        model: tailMetadata.model ?? headMetadata.model,
        contextUsedPercent: tailMetadata.contextUsedPercent,
        hasErrorInTail: tailMetadata.hasErrorInTail,
      };

      // Cache for next scan
      sessionMetaCache.set(jsonlPath, { mtimeMs: fileStat.mtimeMs, meta });
      sessions.push(meta);
    } catch { /* skip unreadable files */ }
  }

  return sessions;
}

// ── Live process detection ──

interface LiveClaudeProcess {
  pid: number;
  cwd?: string;
}

async function findLiveClaudeProcesses(): Promise<LiveClaudeProcess[]> {
  try {
    // Find Claude Code CLI processes (not Claude Desktop app)
    const { stdout } = await execFileAsync(
      'bash', ['-c', 'ps -eo pid=,command= | grep -E "claude (--|-)" | grep -v grep | grep -v ".app/"'],
      { timeout: 3000 },
    );
    const pids: number[] = [];
    for (const line of stdout.trim().split('\n').filter(Boolean)) {
      const match = line.trim().match(/^(\d+)/);
      if (match) pids.push(Number(match[1]));
    }
    if (pids.length === 0) return [];

    // #476 — Batch all PIDs into a single lsof call instead of O(N) sequential calls.
    // lsof accepts comma-separated PIDs with -p and OR's them by default.
    const processes: LiveClaudeProcess[] = pids.map((pid) => ({ pid }));
    try {
      const { stdout: cwdOut } = await execFileAsync(
        'lsof', ['-a', '-p', pids.join(','), '-d', 'cwd', '-Fn'],
        { timeout: 4000 },
      );
      // lsof output: "p<PID>\nn<path>\n" blocks per process
      let currentPid: number | null = null;
      for (const line of cwdOut.split('\n')) {
        if (line.startsWith('p')) {
          currentPid = Number(line.slice(1));
        } else if (line.startsWith('n/') && currentPid !== null) {
          const proc = processes.find((p) => p.pid === currentPid);
          if (proc) proc.cwd = line.slice(1);
        }
      }
    } catch {
      // lsof failed — processes returned without CWD info (status detection still works)
    }
    return processes;
  } catch {
    return [];
  }
}

function inferHistoricalClaudeStatus(meta: SessionMeta): RuntimeSession['status'] {
  if (meta.hasErrorInTail) {
    const ageMs = Date.now() - meta.lastModified.getTime();
    if (ageMs < 30 * 60_000) return 'failed';
  }

  const ageMs = Date.now() - meta.lastModified.getTime();
  if (ageMs < 5 * 60_000) return 'reviewing';
  return 'idle';
}

// ── The Runtime ──

export const claudeCodeRuntime: AgentRuntime = {
  id: 'claude-code',
  displayName: 'Claude Code',
  capabilities,

  async discoverSessions(): Promise<RuntimeSession[]> {
    let projectDirs: string[];
    try {
      projectDirs = await readdir(CLAUDE_PROJECTS_DIR);
    } catch {
      projectDirs = [];
    }

    const [allSessions, liveProcesses] = await Promise.all([
      projectDirs.length > 0
        ? Promise.all(projectDirs.map((dir) => discoverProjectSessions(dir))).then((r) => r.flat())
        : Promise.resolve([]),
      findLiveClaudeProcesses(),
    ]);

    // Sort by most recent first
    allSessions.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());
    const liveSlotsByCwd = new Map<string, number>();
    for (const proc of liveProcesses) {
      const cwd = normalizeFsPath(proc.cwd);
      if (!cwd) continue;
      liveSlotsByCwd.set(cwd, (liveSlotsByCwd.get(cwd) ?? 0) + 1);
    }
    const claimedLiveSlots = new Map<string, number>();

    const results: RuntimeSession[] = allSessions.map((meta): RuntimeSession => {
      const normalizedCwd = normalizeFsPath(meta.cwd ?? meta.projectPath);
      const availableSlots = liveSlotsByCwd.get(normalizedCwd) ?? 0;
      const claimedSlots = claimedLiveSlots.get(normalizedCwd) ?? 0;
      const isLiveSession = availableSlots > claimedSlots;
      if (isLiveSession) {
        claimedLiveSlots.set(normalizedCwd, claimedSlots + 1);
      }
      const status = isLiveSession ? 'running' : inferHistoricalClaudeStatus(meta);
      const name = `${projectDisplayName(meta.projectPath)}${meta.gitBranch ? ` • ${meta.gitBranch}` : ''}`;

      return {
        sessionKey: `claude-code:${meta.sessionId}`,
        runtimeId: 'claude-code',
        displayName: name,
        cwd: meta.cwd ?? meta.projectPath,
        branch: meta.gitBranch,
        status,
        ownership: 'discovered',
        sessionCapabilities: {
          canSendInput: status !== 'failed',
          canInterrupt: status === 'running',
          canReviewDiffs: true,
        },
        lastActivityAt: meta.lastModified,
        initialTask: meta.firstUserMessage,
        model: meta.model ?? 'claude',
        contextUsedPercent: meta.contextUsedPercent,
        tmuxSession: getRuntimeTerminalSession(`claude-code:${meta.sessionId}`)?.sessionName ?? undefined,
      };
    });

    // Create sessions for live Claude Code processes that don't match a recent session.
    // Instead of synthetic IDs, find the REAL most-recent JSONL in the matching project dir
    // so transcript and resume actually work.
    const matchedCwds = new Set(
      results
        .filter((session) => session.status === 'running')
        .map((session) => session.cwd)
        .filter(Boolean),
    );

    for (const proc of liveProcesses) {
      if (!proc.cwd) continue;
      const alreadyMatched = [...matchedCwds].some(
        (cwd) => cwd && (proc.cwd!.startsWith(cwd) || cwd.startsWith(proc.cwd!)),
      );
      if (alreadyMatched) continue;

      // Find the project dir for this CWD
      const encodedDir = `-${proc.cwd.replace(/^\/+/, '').replace(/\//g, '-')}`;
      const projectDirPath = path.join(CLAUDE_PROJECTS_DIR, encodedDir);
      let realSessionId: string | undefined;
      let contextUsedPercent: number | undefined;
      let firstUserMessage: string | undefined;
      let gitBranch: string | undefined;
      let model: string | undefined;

      try {
        const dirEntries = await readdir(projectDirPath);
        const jsonlFiles = dirEntries.filter((e) => e.endsWith('.jsonl'));
        if (jsonlFiles.length > 0) {
          // Find most recently modified JSONL
          const withStats = await Promise.all(
            jsonlFiles.map(async (f) => {
              const fp = path.join(projectDirPath, f);
              const s = await stat(fp).catch(() => null);
              return { file: f, mtime: s?.mtimeMs ?? 0, path: fp };
            }),
          );
          withStats.sort((a, b) => b.mtime - a.mtime);
          const best = withStats[0];
          realSessionId = best.file.replace('.jsonl', '');

          // Positional reads for metadata and context %
          try {
            const bestStat = await stat(best.path);
            const bestSize = bestStat.size;
            const hRaw = await readHead(best.path, bestSize, HEAD_BYTES);
            const headMetadata = extractClaudeHeadMetadata(headLines(hRaw, 20));
            const tRaw = await readTail(best.path, bestSize, TAIL_BYTES);
            const tailMetadata = extractClaudeTailMetadata(
              tailLines(tRaw, Number.MAX_SAFE_INTEGER),
              headMetadata.model,
              headMetadata.explicitContextWindowTokens,
            );
            firstUserMessage = headMetadata.firstUserMessage;
            gitBranch = headMetadata.gitBranch;
            model = tailMetadata.model ?? headMetadata.model;
            contextUsedPercent = tailMetadata.contextUsedPercent;
          } catch { /* couldn't read JSONL */ }
        }
      } catch { /* project dir doesn't exist */ }

      const dirName = proc.cwd.split('/').pop() || 'unknown';
      const displayName = `${dirName}${gitBranch ? ` • ${gitBranch}` : ''}`;

      results.push({
        sessionKey: realSessionId ? `claude-code:${realSessionId}` : `claude-code:live-${proc.pid}`,
        runtimeId: 'claude-code',
        displayName,
        cwd: proc.cwd,
        branch: gitBranch,
        status: 'running',
        ownership: 'discovered',
        sessionCapabilities: {
          canSendInput: true,
          canInterrupt: true,
          canReviewDiffs: Boolean(realSessionId),
        },
        lastActivityAt: new Date(),
        initialTask: firstUserMessage ?? `Live Claude Code session (PID ${proc.pid})`,
        model: model ?? 'claude',
        contextUsedPercent,
        tmuxSession: realSessionId ? (getRuntimeTerminalSession(`claude-code:${realSessionId}`)?.sessionName ?? undefined) : undefined,
      });
    }

    return results;
  },

  async readTranscript(sessionKey: string, sinceId?: string, limit = 50): Promise<RuntimeTranscriptEntry[]> {
    const sessionId = sessionKey.replace('claude-code:', '');

    // Find the JSONL file across all projects
    let jsonlPath: string | null = null;
    try {
      const projectDirs = await readdir(CLAUDE_PROJECTS_DIR);
      for (const dir of projectDirs) {
        const candidate = path.join(CLAUDE_PROJECTS_DIR, dir, `${sessionId}.jsonl`);
        try {
          await access(candidate);
          jsonlPath = candidate;
          break;
        } catch { /* not in this project */ }
      }
    } catch { /* projects dir missing */ }

    if (!jsonlPath) return [];

    // Tail-read: only the last chunk instead of the entire file
    const fileStat = await stat(jsonlPath).catch(() => null);
    if (!fileStat || fileStat.size === 0) return [];

    const tailRaw = await readTail(jsonlPath, fileStat.size, TRANSCRIPT_TAIL_BYTES);
    const lines = tailLines(tailRaw, Number.MAX_SAFE_INTEGER);
    const parsedEntries: ClaudeCodeMessage[] = [];

    for (const line of lines) {
      try {
        parsedEntries.push(JSON.parse(line) as ClaudeCodeMessage);
      } catch { /* skip malformed */ }
    }

    const compactionEvents = detectCompactionEvents(parsedEntries);

    const skippedEntryIds = new Set(
      compactionEvents.flatMap((event) => [
        event.boundaryEntryId,
        event.summaryEntryId,
      ]).filter((id): id is string => Boolean(id)),
    );

    const entries: RuntimeTranscriptEntry[] = compactionEvents.map((event) => (
      buildCompactionTranscriptEntry(event)
    ));
    let entryIndex = 0;

    for (const parsed of parsedEntries) {
      if (parsed.uuid && skippedEntryIds.has(parsed.uuid)) continue;
      if (parsed.isCompactSummary) continue;
      if (parsed.type !== 'user' && parsed.type !== 'assistant') continue;
      if (!parsed.message?.content) continue;

      const text = extractTextFromContent(parsed.message.content);
      if (!text.trim()) continue;

      const id = parsed.uuid ?? `cc-${entryIndex}`;
      entryIndex++;

      entries.push({
        id,
        role: parsed.type === 'user' ? 'user' : 'assistant',
        text,
        timestamp: parsed.timestamp ? new Date(parsed.timestamp) : new Date(),
        type: 'message',
        toolName: parsed.type === 'assistant' ? extractToolName(parsed.message.content) : undefined,
        filePath: parsed.type === 'assistant' ? extractFilePath(parsed.message.content) : undefined,
      });
    }

    entries.sort((left, right) => left.timestamp.getTime() - right.timestamp.getTime());

    // sinceId filtering: return only entries after the given id
    let result = entries;
    if (sinceId) {
      const idx = result.findIndex((e) => e.id === sinceId);
      if (idx !== -1) {
        result = result.slice(idx + 1);
      }
    }

    // Return last N entries
    return result.slice(-limit);
  },

  async launch(opts: LaunchOptions): Promise<RuntimeActionResult> {
    try {
      const startedAtMs = Date.now();
      const launchId = `launched-${Date.now()}`;
      const projectPaths = Array.from(new Set(
        [opts.worktreePath, opts.cwd]
          .filter((value): value is string => Boolean(value))
          .map((value) => path.resolve(value)),
      ));
      const knownSessionIds = new Map(
        await Promise.all(
          projectPaths.map(async (projectPath) => [projectPath, await listProjectSessionIds(projectPath)] as const),
        ),
      );
      const captureDir = await mkdtemp(path.join(os.tmpdir(), 'cortex-claude-launch-'));
      const stdoutPath = path.join(captureDir, 'stdout.jsonl');
      const stderrPath = path.join(captureDir, 'stderr.log');
      const cliArgs = [
        '-p', '--print',
        ...(opts.worktreeFlag ? ['--worktree', opts.worktreeFlag] : []),
        '--dangerously-skip-permissions',
        '--output-format', 'stream-json',
        '--verbose',
        opts.prompt,
      ];
      const bridgeSessionName = tmuxSessionName('cc', launchId);
      const shellCmd = `${quoteShellArg(CLAUDE_BIN)} ${cliArgs.map(quoteShellArg).join(' ')} | tee ${quoteShellArg(stdoutPath)} 2>${quoteShellArg(stderrPath)}`;

      try {
        await spawnBridgeTerminalSession({
          sessionName: bridgeSessionName,
          shellCommand: shellCmd,
          cwd: opts.cwd,
          env: { FORCE_COLOR: '0', NO_COLOR: '1' },
        });
        const sessionId = await waitForLaunchSessionId(stdoutPath, projectPaths, knownSessionIds);
        if (sessionId) {
          registerRuntimeTerminalSession(`claude-code:${sessionId}`, {
            sessionName: bridgeSessionName,
            runtime: 'claude-code',
            cwd: opts.cwd,
          });
          monitorUsageDispatch({
            dispatchKey: `claude-code:${sessionId}:${startedAtMs}`,
            runtime: 'claude-code',
            laneId: opts.laneId,
            sessionKey: `claude-code:${sessionId}`,
            model: opts.model,
            startedAtMs,
            awaitCompletion: async () => waitForClaudeRunToFinish(sessionId, startedAtMs),
          });
          return {
            ok: true,
            note: `Claude Code session launched in terminal:${bridgeSessionName} at ${shortenPath(opts.cwd)}`,
            sessionKey: `claude-code:${sessionId}`,
          };
        }
        return {
          ok: false,
          note: `Claude Code launched in terminal:${bridgeSessionName}, but Cortex could not resolve the persistent session id.`,
        };
      } catch {
        // bridge spawn failed — fall through to detached spawn
      }

      // Fallback: detached spawn (existing behavior)
      const stdoutFd = openSync(stdoutPath, 'a');
      const stderrFd = openSync(stderrPath, 'a');
      try {
        const child = spawn(CLAUDE_BIN, cliArgs, {
          cwd: opts.cwd,
          stdio: ['ignore', stdoutFd, stderrFd],
          detached: true,
          env: { ...process.env, FORCE_COLOR: '0' },
        });
        child.unref();
      } finally {
        closeSync(stdoutFd);
        closeSync(stderrFd);
      }

      const sessionId = await waitForLaunchSessionId(stdoutPath, projectPaths, knownSessionIds);
      if (!sessionId) {
        return {
          ok: false,
          note: `Claude Code launched in ${shortenPath(opts.cwd)}, but Cortex could not resolve the persistent session id.`,
        };
      }

      monitorUsageDispatch({
        dispatchKey: `claude-code:${sessionId}:${startedAtMs}`,
        runtime: 'claude-code',
        laneId: opts.laneId,
        sessionKey: `claude-code:${sessionId}`,
        model: opts.model,
        startedAtMs,
        awaitCompletion: async () => waitForClaudeRunToFinish(sessionId, startedAtMs),
      });

      return {
        ok: true,
        note: `Claude Code session launched in ${shortenPath(opts.cwd)}`,
        sessionKey: `claude-code:${sessionId}`,
      };
    } catch (err) {
      return {
        ok: false,
        note: `Failed to launch Claude Code: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },

  async resume(sessionKey: string, message: string): Promise<RuntimeActionResult> {
    const startedAtMs = Date.now();
    let sessionId = sessionKey.replace('claude-code:', '');

    // If sessionId is a synthetic live-PID key, try to resolve to a real session ID
    // by finding the most recent JSONL in the project dir that matches the PID's CWD
    if (sessionId.startsWith('live-')) {
      const pid = Number(sessionId.replace('live-', ''));
      const resolvedSessionId = await resolveLiveSessionIdFromPid(pid);
      if (resolvedSessionId) {
        sessionId = resolvedSessionId;
      }
    }

    // Resolve the CWD for this session so we can use --continue (which is more
    // reliable than --resume <id> — the latter requires the session to be in
    // Claude's internal conversation store, which has different retention)
    const sessionProject = await resolveSessionProjectPath(sessionId);
    const sessionCwd = sessionProject?.cwd ?? sessionProject?.projectPath;
    const baseline: UsageSnapshot | null = sessionProject?.jsonlPath
      ? await readClaudeUsageSnapshot(sessionProject.jsonlPath).catch(() => null)
      : null;

    // Use --continue with the correct CWD (picks up most recent conversation
    // in that directory). Falls back to --resume <id> if CWD unknown.
    const cliArgs = sessionCwd
      ? [
          '-p', '--print',
          '--continue',
          '--dangerously-skip-permissions',
          '--output-format', 'stream-json',
          '--verbose',
          message,
        ]
      : [
          '-p', '--print',
          '--resume', sessionId,
          '--dangerously-skip-permissions',
          '--output-format', 'stream-json',
          '--verbose',
          message,
        ];

    const spawnCwd = sessionCwd ?? process.env.HOME ?? '/tmp';

    try {
      // Resume must start a fresh Claude CLI turn every time. Reusing a dead
      // tmux session name can silently no-op on later sends, so resume runs
      // detached instead of through the tmux session helper.
      await spawnDetached(CLAUDE_BIN, cliArgs, spawnCwd);
      monitorUsageDispatch({
        dispatchKey: `claude-code:${sessionId}:${startedAtMs}`,
        runtime: 'claude-code',
        sessionKey: `claude-code:${sessionId}`,
        model: baseline?.model ?? null,
        startedAtMs,
        baseline,
        awaitCompletion: async () => waitForClaudeRunToFinish(sessionId, startedAtMs),
      });

      return {
        ok: true,
        note: `Message sent to Claude Code session${sessionCwd ? ` in ${shortenPath(sessionCwd)}` : ''}.`,
        sessionKey,
      };
    } catch (err) {
      return {
        ok: false,
        note: `Failed to resume Claude Code session: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },

  async interrupt(sessionKey: string): Promise<RuntimeActionResult> {
    const sessionId = sessionKey.replace('claude-code:', '');
    const liveProcesses = await findLiveClaudeProcesses();
    if (liveProcesses.length === 0) {
      return { ok: false, note: 'No live Claude Code process found to interrupt.' };
    }

    const livePidMatch = sessionId.match(/^live-(\d+)$/);
    let targetPids: number[] = [];

    if (livePidMatch?.[1]) {
      targetPids = [Number(livePidMatch[1])];
    } else {
      const sessionProject = await resolveSessionProjectPath(sessionId);
      const sessionCwd = sessionProject?.cwd ?? sessionProject?.projectPath;

      if (sessionCwd) {
        const normalizedTarget = normalizeFsPath(sessionCwd);
        targetPids = liveProcesses
          .filter((proc) => {
            const normalizedProc = normalizeFsPath(proc.cwd);
            return normalizedProc === normalizedTarget
              || normalizedProc.startsWith(`${normalizedTarget}/`)
              || normalizedTarget.startsWith(`${normalizedProc}/`);
          })
          .map((proc) => proc.pid);
      }
    }

    targetPids = [...new Set(targetPids.filter((pid) => Number.isFinite(pid) && pid > 0))];
    if (targetPids.length === 0) {
      return {
        ok: false,
        note: 'No live Claude Code PID matched this session.',
        sessionKey,
      };
    }

    let interrupted = false;
    for (const pid of targetPids) {
      try {
        process.kill(pid, 'SIGINT');
        interrupted = true;
      } catch { /* process may have exited */ }
    }

    return {
      ok: interrupted,
      note: interrupted
        ? `SIGINT sent to Claude Code pid${targetPids.length === 1 ? '' : 's'} ${targetPids.join(', ')}.`
        : 'Could not interrupt the live Claude Code process for this session.',
      sessionKey,
    };
  },

  async getTelemetry(sessionKey: string): Promise<RuntimeTelemetry | undefined> {
    let sessionId = sessionKey.replace('claude-code:', '');
    if (sessionId.startsWith('live-')) {
      const pid = Number(sessionId.replace('live-', ''));
      const resolvedSessionId = await resolveLiveSessionIdFromPid(pid);
      if (resolvedSessionId) {
        sessionId = resolvedSessionId;
      }
    }

    const sessionProject = await resolveSessionProjectPath(sessionId);
    if (!sessionProject?.jsonlPath) {
      return undefined;
    }

    const sessionCost = await parseSessionCost(sessionProject.jsonlPath);
    const totalTokens = sessionCost.inputTokens
      + sessionCost.outputTokens
      + sessionCost.cacheReadTokens
      + sessionCost.cacheWriteTokens;

    return {
      totalTokens,
      estimatedCostUsd: sessionCost.totalCostUsd,
      inputTokens: sessionCost.inputTokens,
      outputTokens: sessionCost.outputTokens,
      cacheReadTokens: sessionCost.cacheReadTokens,
      cacheWriteTokens: sessionCost.cacheWriteTokens,
      model: sessionCost.model ?? undefined,
    };
  },

  async getChangedFiles(sessionKey: string): Promise<RuntimeChangedFile[]> {
    const sessionId = sessionKey.replace('claude-code:', '');

    // Find the session to get CWD
    const sessionProject = await resolveSessionProjectPath(sessionId);
    const cwd = sessionProject?.cwd ?? sessionProject?.projectPath ?? null;

    if (!cwd) return [];

    // Use git diff to find changed files
    try {
      const { stdout } = await execFileAsync('git', ['diff', '--numstat', 'HEAD'], {
        cwd,
        timeout: 5000,
      });

      return stdout.trim().split('\n').filter(Boolean).map((line) => {
        const [add, del, filePath] = line.split('\t');
        return {
          path: filePath ?? '',
          status: 'modified' as const,
          additions: parseInt(add ?? '0', 10) || 0,
          deletions: parseInt(del ?? '0', 10) || 0,
        };
      });
    } catch {
      return [];
    }
  },
};
