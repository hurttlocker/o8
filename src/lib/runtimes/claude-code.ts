/**
 * Claude Code Runtime Adapter
 *
 * Discovers Claude Code sessions from ~/.claude/projects/,
 * reads transcripts from JSONL files, and manages lifecycle
 * via the `claude` CLI.
 */

import { execFile, spawn } from 'node:child_process';
import { access, readdir, readFile, stat } from 'node:fs/promises';
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
} from './types';

const execFileAsync = promisify(execFile);

const CLAUDE_HOME = process.env.CLAUDE_HOME || path.join(os.homedir(), '.claude');
const CLAUDE_PROJECTS_DIR = path.join(CLAUDE_HOME, 'projects');
const RECENT_WINDOW_MS = 6 * 60 * 60_000; // 6 hours

const capabilities: RuntimeCapabilities = {
  discover: true,
  readTranscript: true,
  launch: true,
  resume: true,
  interrupt: true,
  reviewDiffs: true,
  costTelemetry: false,
  streaming: true,
};

// ── Path helpers ──

/**
 * Decode Claude Code's project directory name back to a filesystem path.
 * e.g., "-Users-marquisehurtt-clawd" → "/Users/marquisehurtt/clawd"
 */
function decodeProjectPath(encodedName: string): string {
  // Replace leading dash with /, then remaining dashes with /
  // But we need to be careful: the encoding replaces / with -
  return '/' + encodedName.slice(1).replace(/-/g, '/');
}

function shortenPath(filePath: string): string {
  return filePath.replace(`${os.homedir()}/`, '~/');
}

/**
 * Extract a human-readable project name from the path.
 * e.g., "/Users/marquisehurtt/clawd/repos/cortex-ide" → "cortex-ide"
 */
function projectDisplayName(projectPath: string): string {
  return path.basename(projectPath) || projectPath;
}

// ── Session JSONL parsing ──

interface ClaudeCodeMessage {
  type: 'user' | 'assistant' | 'system' | 'progress' | 'file-history-snapshot' | 'queue-operation';
  uuid?: string;
  timestamp?: string;
  sessionId?: string;
  cwd?: string;
  gitBranch?: string;
  message?: {
    role: string;
    content: MessageContent;
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
}

async function discoverProjectSessions(projectDirName: string): Promise<SessionMeta[]> {
  const projectDir = path.join(CLAUDE_PROJECTS_DIR, projectDirName);
  const projectPath = decodeProjectPath(projectDirName);

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

      // Read first few lines to get metadata
      const content = await readFile(jsonlPath, 'utf-8');
      const lines = content.split('\n').filter(Boolean);

      let firstUserMessage: string | undefined;
      let cwd: string | undefined;
      let gitBranch: string | undefined;

      for (const line of lines.slice(0, 20)) {
        try {
          const parsed = JSON.parse(line) as ClaudeCodeMessage;
          if (parsed.cwd && !cwd) cwd = parsed.cwd;
          if (parsed.gitBranch && !gitBranch) gitBranch = parsed.gitBranch;
          if (parsed.type === 'user' && parsed.message?.content && !firstUserMessage) {
            const text = typeof parsed.message.content === 'string'
              ? parsed.message.content
              : extractTextFromContent(parsed.message.content);
            firstUserMessage = text.slice(0, 200);
          }
          if (cwd && gitBranch && firstUserMessage) break;
        } catch { /* skip malformed lines */ }
      }

      sessions.push({
        sessionId,
        projectDir,
        projectPath,
        jsonlPath,
        lastModified: fileStat.mtime,
        firstUserMessage,
        cwd: cwd ?? projectPath,
        gitBranch,
      });
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
    const { stdout } = await execFileAsync('pgrep', ['-f', 'claude'], { timeout: 3000 });
    const pids = stdout.trim().split('\n').filter(Boolean).map(Number).filter(Boolean);

    const processes: LiveClaudeProcess[] = [];
    for (const pid of pids) {
      try {
        const { stdout: cwdOut } = await execFileAsync('lsof', ['-p', String(pid), '-Fn'], { timeout: 2000 });
        const cwdLine = cwdOut.split('\n').find((l) => l.startsWith('n') && l.includes('/'));
        processes.push({ pid, cwd: cwdLine?.slice(1) });
      } catch {
        processes.push({ pid });
      }
    }
    return processes;
  } catch {
    return [];
  }
}

// ── Determine session status ──

function inferSessionStatus(meta: SessionMeta, liveProcesses: LiveClaudeProcess[]): RuntimeSession['status'] {
  // Check if a live claude process matches this session's CWD
  const hasLiveProcess = liveProcesses.some((p) => p.cwd && meta.cwd && p.cwd.startsWith(meta.cwd));
  if (hasLiveProcess) return 'running';

  // Recent activity = reviewing, older = idle
  const ageMs = Date.now() - meta.lastModified.getTime();
  if (ageMs < 5 * 60_000) return 'reviewing'; // Active in last 5 min
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
      return [];
    }

    const [allSessions, liveProcesses] = await Promise.all([
      Promise.all(projectDirs.map((dir) => discoverProjectSessions(dir))).then((r) => r.flat()),
      findLiveClaudeProcesses(),
    ]);

    // Sort by most recent first
    allSessions.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());

    return allSessions.map((meta): RuntimeSession => {
      const status = inferSessionStatus(meta, liveProcesses);
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
          canSendInput: status !== 'running', // Can resume if not actively running
          canInterrupt: status === 'running',
          canReviewDiffs: true,
        },
        lastActivityAt: meta.lastModified,
        initialTask: meta.firstUserMessage,
        model: 'claude',
      };
    });
  },

  async readTranscript(sessionKey: string, _sinceId?: string, limit = 50): Promise<RuntimeTranscriptEntry[]> {
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

    const content = await readFile(jsonlPath, 'utf-8');
    const lines = content.split('\n').filter(Boolean);

    const entries: RuntimeTranscriptEntry[] = [];

    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as ClaudeCodeMessage;
        if (parsed.type !== 'user' && parsed.type !== 'assistant') continue;
        if (!parsed.message?.content) continue;

        const text = extractTextFromContent(parsed.message.content);
        if (!text.trim()) continue;

        entries.push({
          id: parsed.uuid ?? `cc-${entries.length}`,
          role: parsed.type === 'user' ? 'user' : 'assistant',
          text,
          timestamp: parsed.timestamp ? new Date(parsed.timestamp) : new Date(),
          toolName: parsed.type === 'assistant' ? extractToolName(parsed.message.content) : undefined,
          filePath: parsed.type === 'assistant' ? extractFilePath(parsed.message.content) : undefined,
        });
      } catch { /* skip malformed */ }
    }

    // Return last N entries
    return entries.slice(-limit);
  },

  async launch(opts: LaunchOptions): Promise<RuntimeActionResult> {
    try {
      const child = spawn('claude', [
        '-p', '--print',
        '--permission-mode', 'bypassPermissions',
        '--output-format', 'stream-json',
        '--no-session-persistence',
        opts.prompt,
      ], {
        cwd: opts.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true,
        env: { ...process.env },
      });

      child.unref();

      return {
        ok: true,
        note: `Claude Code session launched in ${shortenPath(opts.cwd)}`,
        sessionKey: `claude-code:launched-${Date.now()}`,
      };
    } catch (err) {
      return {
        ok: false,
        note: `Failed to launch Claude Code: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },

  async resume(sessionKey: string, message: string): Promise<RuntimeActionResult> {
    const sessionId = sessionKey.replace('claude-code:', '');

    try {
      const child = spawn('claude', [
        '-p', '--print',
        '--resume', sessionId,
        '--permission-mode', 'bypassPermissions',
        '--output-format', 'stream-json',
        message,
      ], {
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true,
        env: { ...process.env },
      });

      child.unref();

      return {
        ok: true,
        note: 'Message sent to Claude Code session.',
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
    // Find the process by matching the session
    const liveProcesses = await findLiveClaudeProcesses();
    if (liveProcesses.length === 0) {
      return { ok: false, note: 'No live Claude Code process found to interrupt.' };
    }

    // Try SIGINT on all claude processes (they handle it gracefully)
    let interrupted = false;
    for (const proc of liveProcesses) {
      try {
        process.kill(proc.pid, 'SIGINT');
        interrupted = true;
      } catch { /* process may have exited */ }
    }

    return {
      ok: interrupted,
      note: interrupted
        ? 'SIGINT sent to Claude Code process.'
        : 'Could not interrupt Claude Code process.',
      sessionKey,
    };
  },

  async getChangedFiles(sessionKey: string): Promise<RuntimeChangedFile[]> {
    const sessionId = sessionKey.replace('claude-code:', '');

    // Find the session to get CWD
    let cwd: string | null = null;
    try {
      const projectDirs = await readdir(CLAUDE_PROJECTS_DIR);
      for (const dir of projectDirs) {
        const jsonlPath = path.join(CLAUDE_PROJECTS_DIR, dir, `${sessionId}.jsonl`);
        try {
          await access(jsonlPath);
          cwd = decodeProjectPath(dir);
          break;
        } catch { /* not in this project */ }
      }
    } catch { /* projects dir missing */ }

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
