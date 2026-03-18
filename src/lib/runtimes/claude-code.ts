/**
 * Claude Code Runtime Adapter
 *
 * Discovers Claude Code sessions from ~/.claude/projects/,
 * reads transcripts from JSONL files, and manages lifecycle
 * via the `claude` CLI.
 */

import { execFile, spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { access, mkdtemp, readdir, readFile, stat } from 'node:fs/promises';
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
import {
  isTmuxAvailable,
  tmuxSessionName,
  createTmuxSession,
  renameTmuxSession,
} from '@/lib/terminal/tmux';

const execFileAsync = promisify(execFile);

const CLAUDE_HOME = process.env.CLAUDE_HOME || path.join(os.homedir(), '.claude');
const CLAUDE_BIN = process.env.CLAUDE_BIN || path.join(os.homedir(), '.local', 'bin', 'claude');
const CLAUDE_PROJECTS_DIR = path.join(CLAUDE_HOME, 'projects');
const RECENT_WINDOW_MS = 6 * 60 * 60_000; // 6 hours
const LAUNCH_SESSION_ID_TIMEOUT_MS = 12_000;

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

function encodeProjectPath(projectPath: string): string {
  const resolved = path.resolve(projectPath);
  return `-${resolved.replace(/^\/+/, '').replace(/\//g, '-')}`;
}

function quoteShellArg(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`;
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
    usage?: Record<string, number>;
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
  contextUsedPercent?: number;
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

      // Extract context % from last assistant message usage (read tail)
      let contextUsedPercent: number | undefined;
      const CLAUDE_CTX_WINDOW = 200_000;
      const tailLines = lines.slice(-30).reverse();
      for (const tl of tailLines) {
        try {
          const tp = JSON.parse(tl) as ClaudeCodeMessage;
          if (tp.type === 'assistant' && tp.message?.usage) {
            const u = tp.message.usage as Record<string, number>;
            const totalIn = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
            if (totalIn > 0) {
              contextUsedPercent = Math.min(100, Math.round(totalIn / CLAUDE_CTX_WINDOW * 100));
              break;
            }
          }
        } catch { /* skip */ }
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
        contextUsedPercent,
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

    const processes: LiveClaudeProcess[] = [];
    for (const pid of pids) {
      try {
        // Use lsof -a -p PID -d cwd to get ONLY the working directory
        // -a = AND mode (without it, -p and -d are OR'd, dumping all processes)
        const { stdout: cwdOut } = await execFileAsync(
          'lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'],
          { timeout: 2000 },
        );
        const cwdLine = cwdOut.split('\n').find((l) => l.startsWith('n/'));
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

    const results: RuntimeSession[] = allSessions.map((meta): RuntimeSession => {
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
          canSendInput: status !== 'running',
          canInterrupt: status === 'running',
          canReviewDiffs: true,
        },
        lastActivityAt: meta.lastModified,
        initialTask: meta.firstUserMessage,
        model: 'claude',
        contextUsedPercent: meta.contextUsedPercent,
      };
    });

    // Create sessions for live Claude Code processes that don't match a recent session.
    // Instead of synthetic IDs, find the REAL most-recent JSONL in the matching project dir
    // so transcript and resume actually work.
    const matchedCwds = new Set(
      allSessions
        .filter((m) => inferSessionStatus(m, liveProcesses) === 'running')
        .map((m) => m.cwd)
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
      let realJsonlPath: string | undefined;
      let contextUsedPercent: number | undefined;
      let firstUserMessage: string | undefined;
      let gitBranch: string | undefined;

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
          realJsonlPath = best.path;

          // Read tail for context % and metadata
          try {
            const content = await readFile(best.path, 'utf-8');
            const lines = content.split('\n').filter(Boolean);
            // Metadata from head
            for (const line of lines.slice(0, 20)) {
              try {
                const p = JSON.parse(line) as ClaudeCodeMessage;
                if (p.gitBranch && !gitBranch) gitBranch = p.gitBranch;
                if (p.type === 'user' && p.message?.content && !firstUserMessage) {
                  const text = typeof p.message.content === 'string'
                    ? p.message.content
                    : extractTextFromContent(p.message.content);
                  firstUserMessage = text.slice(0, 200);
                }
                if (gitBranch && firstUserMessage) break;
              } catch { /* skip */ }
            }
            // Context from tail
            const CLAUDE_CTX_WINDOW = 200_000;
            const tailLines = lines.slice(-30).reverse();
            for (const tl of tailLines) {
              try {
                const tp = JSON.parse(tl) as ClaudeCodeMessage;
                if (tp.type === 'assistant' && tp.message?.usage) {
                  const u = tp.message.usage as Record<string, number>;
                  const totalIn = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
                  if (totalIn > 0) {
                    contextUsedPercent = Math.min(100, Math.round(totalIn / CLAUDE_CTX_WINDOW * 100));
                    break;
                  }
                }
              } catch { /* skip */ }
            }
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
        model: 'claude',
        contextUsedPercent,
      });
    }

    return results;
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
        '--permission-mode', 'bypassPermissions',
        '--output-format', 'stream-json',
        '--verbose',
        opts.prompt,
      ];
      let tmuxName: string | null = null;

      // Try tmux-wrapped launch first
      if (await isTmuxAvailable()) {
        tmuxName = tmuxSessionName('cc', launchId);
        const shellCmd = `${quoteShellArg(CLAUDE_BIN)} ${cliArgs.map(quoteShellArg).join(' ')} | tee ${quoteShellArg(stdoutPath)} 2>${quoteShellArg(stderrPath)}`;
        const result = await createTmuxSession(tmuxName, 'sh', ['-c', shellCmd], opts.cwd);
        if (result.ok) {
          const sessionId = await waitForLaunchSessionId(stdoutPath, projectPaths, knownSessionIds);
          if (sessionId) {
            await renameTmuxSession(tmuxName, tmuxSessionName('cc', sessionId));
            return {
              ok: true,
              note: `Claude Code session launched in tmux:${tmuxSessionName('cc', sessionId)} at ${shortenPath(opts.cwd)}`,
              sessionKey: `claude-code:${sessionId}`,
            };
          }
          return {
            ok: false,
            note: `Claude Code launched in tmux:${tmuxName}, but Cortex could not resolve the persistent session id.`,
          };
        }
        // tmux failed — fall through to detached spawn
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
    let sessionId = sessionKey.replace('claude-code:', '');

    // If sessionId is a synthetic live-PID key, try to resolve to a real session ID
    // by finding the most recent JSONL in the project dir that matches the PID's CWD
    if (sessionId.startsWith('live-')) {
      const pid = Number(sessionId.replace('live-', ''));
      if (pid > 0) {
        try {
          const { stdout: cwdOut } = await execFileAsync(
            'lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'],
            { timeout: 2000 },
          );
          const cwdLine = cwdOut.split('\n').find((l) => l.startsWith('n/'));
          const cwd = cwdLine?.slice(1);
          if (cwd) {
            const encodedDir = `-${cwd.replace(/^\/+/, '').replace(/\//g, '-')}`;
            const projectDirPath = path.join(CLAUDE_PROJECTS_DIR, encodedDir);
            const dirEntries = await readdir(projectDirPath).catch(() => [] as string[]);
            const jsonlFiles = dirEntries.filter((e) => e.endsWith('.jsonl'));
            if (jsonlFiles.length > 0) {
              const withStats = await Promise.all(
                jsonlFiles.map(async (f) => {
                  const fp = path.join(projectDirPath, f);
                  const s = await stat(fp).catch(() => null);
                  return { file: f, mtime: s?.mtimeMs ?? 0 };
                }),
              );
              withStats.sort((a, b) => b.mtime - a.mtime);
              sessionId = withStats[0].file.replace('.jsonl', '');
            }
          }
        } catch { /* fallback to original sessionId */ }
      }
    }

    const cliArgs = [
      '-p', '--print',
      '--resume', sessionId,
      '--permission-mode', 'bypassPermissions',
      '--output-format', 'stream-json',
      message,
    ];

    try {
      // Try tmux-wrapped resume
      if (await isTmuxAvailable()) {
        const tmuxName = tmuxSessionName('cc', sessionId);
        const result = await createTmuxSession(tmuxName, 'claude', cliArgs, process.env.HOME ?? '/tmp');
        if (result.ok) {
          return {
            ok: true,
            note: 'Message sent to Claude Code session (tmux).',
            sessionKey,
          };
        }
      }

      // Fallback: detached spawn
      const child = spawn('claude', cliArgs, {
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
