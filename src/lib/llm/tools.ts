/**
 * LLM Tool definitions and execution.
 *
 * Tools the model can call during a conversation:
 * - search_web: Search the internet
 * - read_file: Read a file from the workspace
 * - list_files: List directory contents
 * - search_code: Search through codebase with grep
 */

import { execSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createGithubIssue, readGithubIssueOrPr, createPullRequest } from '@/lib/github/tools';

const REPO_ROOT = process.env.CORTEX_IDE_REVIEW_REPO_ROOT || '/Users/marquisehurtt/clawd/repos/cortex-ide';
const MAX_FILE_SIZE = 50_000; // 50KB

// ── Tool Definitions (provider-agnostic) ──

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export const TOOLS: ToolDef[] = [
  {
    name: 'search_web',
    description: 'Search the internet for current information. Use when you need up-to-date facts, documentation, or external context.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
      },
      required: ['query'],
    },
  },
  {
    name: 'read_file',
    description: 'Read the contents of a file in the workspace. Use to examine code, configs, or documentation.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative file path from the repo root' },
        startLine: { type: 'number', description: 'Optional: start reading from this line (1-indexed)' },
        endLine: { type: 'number', description: 'Optional: stop reading at this line' },
      },
      required: ['path'],
    },
  },
  {
    name: 'list_files',
    description: 'List files and directories in a path. Use to explore the project structure.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative directory path (default: root)' },
        pattern: { type: 'string', description: 'Optional: glob pattern filter (e.g. "*.tsx")' },
      },
      required: [],
    },
  },
  {
    name: 'search_code',
    description: 'Search through the codebase for text patterns. Use to find function definitions, imports, usages.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search pattern (supports regex)' },
        filePattern: { type: 'string', description: 'Optional: file type filter (e.g. "*.tsx")' },
        maxResults: { type: 'number', description: 'Max results to return (default: 10)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'create_github_issue',
    description: 'Create a new GitHub issue. REQUIRES USER APPROVAL. Use when the user asks to file a bug, feature request, or task.',
    parameters: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repository in owner/name format (e.g. hurttlocker/cortex-ide)' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body in markdown' },
        labels: { type: 'array', items: { type: 'string' }, description: 'Optional labels' },
      },
      required: ['repo', 'title', 'body'],
    },
  },
  {
    name: 'read_github_issue_or_pr',
    description: 'Read the details, comments, and diff of a GitHub issue or pull request. Does NOT require approval.',
    parameters: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repository in owner/name format' },
        number: { type: 'number', description: 'Issue or PR number' },
      },
      required: ['repo', 'number'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a new branch from uncommitted changes, commit, push, and open a pull request. REQUIRES USER APPROVAL. Use when the user asks to submit their work as a PR.',
    parameters: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repository in owner/name format' },
        branch: { type: 'string', description: 'Branch name to create (e.g. feat/add-auth)' },
        title: { type: 'string', description: 'PR title' },
        body: { type: 'string', description: 'PR description in markdown' },
        baseBranch: { type: 'string', description: 'Base branch (default: main)' },
      },
      required: ['repo', 'branch', 'title', 'body'],
    },
  },
  {
    name: 'run_terminal_command',
    description: 'Execute a shell command in the workspace and return the output. Safe read-only commands run automatically. Write/mutation commands REQUIRE USER APPROVAL. Dangerous commands are blocked. Use for running tests, checking git status, building, installing packages, or any CLI task.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to execute (e.g. "npm run test", "git status", "ls -la src/")' },
        cwd: { type: 'string', description: 'Optional: working directory relative to repo root (default: repo root)' },
      },
      required: ['command'],
    },
  },
];

// Tools that ALWAYS require user approval before execution
export const APPROVAL_REQUIRED_TOOLS = new Set([
  'create_github_issue',
  'create_pull_request',
  // run_terminal_command uses dynamic approval — see classifyCommand()
]);

// ── Terminal Command Safety Tiers ──

// 🟢 Auto-run: read-only commands that can never cause damage
const SAFE_COMMANDS = new Set([
  'ls', 'cat', 'head', 'tail', 'wc', 'echo', 'pwd', 'which', 'whoami',
  'find', 'grep', 'rg', 'ag', 'tree', 'file', 'stat', 'du', 'df',
  'git status', 'git log', 'git diff', 'git branch', 'git remote',
  'git show', 'git stash list', 'git tag',
  'node -v', 'node --version', 'npm list', 'npm ls', 'npm --version',
  'npx tsc --noEmit', 'npx tsc --version',
  'go version', 'go test', 'python3 --version', 'rustc --version',
  'cortex stats', 'cortex doctor', 'cortex health', 'cortex search',
  'gh issue list', 'gh pr list', 'gh repo view',
  'date', 'uptime', 'hostname', 'env',
]);

// 🟡 Needs approval: mutation commands
const MUTATION_PREFIXES = [
  'npm install', 'npm run', 'npm ci', 'npm update', 'npm uninstall',
  'npx', 'yarn', 'pnpm',
  'git add', 'git commit', 'git push', 'git pull', 'git merge',
  'git checkout', 'git switch', 'git rebase', 'git reset', 'git stash',
  'go build', 'go install', 'go mod',
  'mkdir', 'touch', 'cp', 'mv', 'ln',
  'pip install', 'pip3 install',
  'cargo build', 'cargo install',
  'make', 'cmake',
  'docker', 'kubectl',
  'cortex import', 'cortex store', 'cortex embed', 'cortex cleanup',
  'cortex lifecycle', 'cortex optimize', 'cortex reimport',
  'gh issue create', 'gh pr create', 'gh pr merge',
];

// 🔴 Blocked: dangerous commands that should never run from chat
const BLOCKED_PATTERNS = [
  /\brm\s+(-[a-z]*r|-[a-z]*f|--recursive|--force)/i,  // rm -rf, rm -r, rm -f
  /\bsudo\b/,
  /\bchmod\s+777\b/,
  /\bchown\b/,
  /\bdd\s+if=/,
  /\bmkfs\b/,
  /\bformat\b/,
  />\s*\/dev\//,                     // redirect to device files
  /\bcurl\b.*\|\s*(sh|bash|zsh)/,   // curl pipe to shell
  /\bwget\b.*\|\s*(sh|bash|zsh)/,
  /\beval\b/,
  /\bexec\b/,
  /;.*\brm\b/,                      // chained rm
  /&&.*\brm\b/,                     // chained rm
  /\|\s*\brm\b/,                    // piped rm
  /\bkill\s+-9\b/,
  /\bshutdown\b/,
  /\breboot\b/,
  /\bnohup\b.*&/,                   // background persistent processes
  />\s*~\//,                         // overwrite home directory files
];

export type CommandSafety = 'safe' | 'needs_approval' | 'blocked';

export function classifyCommand(command: string): { safety: CommandSafety; reason: string } {
  const trimmed = command.trim();

  // Check blocked patterns first
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { safety: 'blocked', reason: `Blocked: matches dangerous pattern ${pattern.source}` };
    }
  }

  // Check safe commands (exact match on the base command)
  const baseCmd = trimmed.split(/\s+/).slice(0, 3).join(' '); // "git status", "npm list"
  const baseCmdTwo = trimmed.split(/\s+/).slice(0, 2).join(' ');
  const baseCmdOne = trimmed.split(/\s+/)[0];

  if (SAFE_COMMANDS.has(baseCmd) || SAFE_COMMANDS.has(baseCmdTwo) || SAFE_COMMANDS.has(baseCmdOne)) {
    return { safety: 'safe', reason: 'Read-only command' };
  }

  // Check mutation prefixes
  for (const prefix of MUTATION_PREFIXES) {
    if (trimmed.startsWith(prefix)) {
      return { safety: 'needs_approval', reason: `Mutation: ${prefix}` };
    }
  }

  // Default: anything unknown needs approval
  return { safety: 'needs_approval', reason: 'Unknown command — requires approval' };
}

// ── Tool Execution ──

export interface ToolResult {
  content: string;
  sources?: { title: string; url?: string; path?: string }[];
}

export async function executeTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  switch (name) {
    case 'search_web': return await searchWeb(args.query as string);
    case 'read_file': return readFile(args.path as string, args.startLine as number | undefined, args.endLine as number | undefined);
    case 'list_files': return listFiles(args.path as string | undefined, args.pattern as string | undefined);
    case 'search_code': return searchCode(args.query as string, args.filePattern as string | undefined, args.maxResults as number | undefined);
    case 'create_github_issue': return await createGithubIssue(args as Parameters<typeof createGithubIssue>[0]);
    case 'read_github_issue_or_pr': return await readGithubIssueOrPr(args as Parameters<typeof readGithubIssueOrPr>[0]);
    case 'create_pull_request': return await createPullRequest(args as Parameters<typeof createPullRequest>[0]);
    case 'run_terminal_command': return runTerminalCommand(args.command as string, args.cwd as string | undefined);
    default: return { content: `Unknown tool: ${name}` };
  }
}

const MAX_OUTPUT = 10_000; // 10KB output cap for LLM
const COMMAND_TIMEOUT = 30_000; // 30s timeout

function runTerminalCommand(command: string, cwd?: string): ToolResult {
  const classification = classifyCommand(command);

  if (classification.safety === 'blocked') {
    return { content: `🔴 Command blocked: ${classification.reason}\n\nThis command is not allowed to run from the chat for safety reasons.` };
  }

  // Resolve working directory
  let workDir = REPO_ROOT;
  if (cwd) {
    const resolved = join(REPO_ROOT, cwd);
    const rel = relative(REPO_ROOT, resolved);
    if (rel.startsWith('..') || rel.startsWith('/')) {
      return { content: 'Error: Working directory must be within the repository' };
    }
    workDir = resolved;
  }

  try {
    const output = execSync(command, {
      encoding: 'utf-8',
      timeout: COMMAND_TIMEOUT,
      cwd: workDir,
      maxBuffer: 1024 * 1024, // 1MB buffer
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' }, // no ANSI
      shell: '/bin/zsh',
    });

    let result = output.trim();

    // Truncate if too long
    if (result.length > MAX_OUTPUT) {
      const truncated = result.slice(0, MAX_OUTPUT);
      result = truncated + `\n\n... (output truncated — ${result.length.toLocaleString()} chars total, showing first ${MAX_OUTPUT.toLocaleString()})`;
    }

    return {
      content: result || '(command completed with no output)',
      sources: [{ title: `$ ${command}`, path: cwd || '.' }],
    };
  } catch (err) {
    // execSync throws on non-zero exit code — capture both stdout and stderr
    const execErr = err as { stdout?: string; stderr?: string; status?: number; message?: string };
    const stdout = (execErr.stdout || '').trim();
    const stderr = (execErr.stderr || '').trim();
    const status = execErr.status ?? 1;

    let output = '';
    if (stdout) output += stdout;
    if (stderr) output += (output ? '\n\n' : '') + `STDERR:\n${stderr}`;
    if (!output) output = execErr.message || 'Command failed with no output';

    // Truncate
    if (output.length > MAX_OUTPUT) {
      output = output.slice(0, MAX_OUTPUT) + '\n... (truncated)';
    }

    return {
      content: `Exit code ${status}:\n${output}`,
      sources: [{ title: `$ ${command} (exit ${status})`, path: cwd || '.' }],
    };
  }
}

async function searchWeb(query: string): Promise<ToolResult> {
  try {
    // Use Brave Search API if available
    const apiKey = process.env.BRAVE_SEARCH_API_KEY;
    if (!apiKey) {
      return { content: 'Web search not configured (BRAVE_SEARCH_API_KEY not set). Please provide the information you need directly.' };
    }

    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5`;
    const res = await fetch(url, {
      headers: { 'X-Subscription-Token': apiKey, 'Accept': 'application/json' },
    });

    if (!res.ok) {
      return { content: `Search failed (${res.status})` };
    }

    const data = await res.json();
    const results = (data.web?.results ?? []).slice(0, 5);

    const sources = results.map((r: { title: string; url: string }) => ({
      title: r.title,
      url: r.url,
    }));

    const content = results.map((r: { title: string; url: string; description: string }, i: number) =>
      `[${i + 1}] ${r.title}\n${r.description}\nURL: ${r.url}`
    ).join('\n\n');

    return { content: content || 'No results found', sources };
  } catch (err) {
    return { content: `Search error: ${err instanceof Error ? err.message : 'Unknown'}` };
  }
}

function readFile(path: string, startLine?: number, endLine?: number): ToolResult {
  try {
    const resolved = join(REPO_ROOT, path);
    const rel = relative(REPO_ROOT, resolved);
    if (rel.startsWith('..') || rel.startsWith('/')) {
      return { content: 'Error: Path outside repository' };
    }

    const stat = statSync(resolved);
    let content = readFileSync(resolved, 'utf-8');

    if (stat.size > MAX_FILE_SIZE) {
      content = content.slice(0, MAX_FILE_SIZE) + '\n... (truncated)';
    }

    if (startLine || endLine) {
      const lines = content.split('\n');
      const start = Math.max(0, (startLine || 1) - 1);
      const end = endLine || lines.length;
      content = lines.slice(start, end).map((line, i) => `${start + i + 1}: ${line}`).join('\n');
    }

    return {
      content,
      sources: [{ title: path, path }],
    };
  } catch {
    return { content: `Error: File not found: ${path}` };
  }
}

function listFiles(dirPath?: string, pattern?: string): ToolResult {
  try {
    const resolved = join(REPO_ROOT, dirPath || '.');
    const rel = relative(REPO_ROOT, resolved);
    if (rel.startsWith('..')) {
      return { content: 'Error: Path outside repository' };
    }

    let cmd = `find "${resolved}" -maxdepth 1 -not -name ".*" -not -name "node_modules"`;
    if (pattern) {
      cmd = `find "${resolved}" -maxdepth 2 -name "${pattern}" -not -path "*/node_modules/*" -not -path "*/.next/*" | head -30`;
    }

    const output = execSync(cmd, { encoding: 'utf-8', timeout: 5000 }).trim();
    const entries = output.split('\n').filter(Boolean).map(f => {
      const relPath = relative(REPO_ROOT, f);
      try {
        const s = statSync(f);
        return `${s.isDirectory() ? '📁' : '📄'} ${relPath}`;
      } catch {
        return `  ${relPath}`;
      }
    });

    return { content: entries.join('\n') || 'Empty directory' };
  } catch (err) {
    return { content: `Error: ${err instanceof Error ? err.message : 'Unknown'}` };
  }
}

function searchCode(query: string, filePattern?: string, maxResults?: number): ToolResult {
  try {
    const max = Math.min(maxResults || 10, 20);
    let cmd = `cd "${REPO_ROOT}" && grep -rn --include="*.ts" --include="*.tsx" --include="*.js" --include="*.json" --include="*.md"`;
    if (filePattern) {
      cmd = `cd "${REPO_ROOT}" && grep -rn --include="${filePattern}"`;
    }
    cmd += ` "${query.replace(/"/g, '\\"')}" . | head -${max}`;

    const output = execSync(cmd, { encoding: 'utf-8', timeout: 5000 }).trim();

    if (!output) return { content: 'No matches found' };

    const sources = [...new Set(
      output.split('\n').map(line => line.split(':')[0]?.replace('./', ''))
    )].filter(Boolean).map(path => ({ title: path, path }));

    return { content: output, sources };
  } catch {
    return { content: 'No matches found' };
  }
}

// ── Provider Format Converters ──

export function toolsForAnthropic(): { name: string; description: string; input_schema: Record<string, unknown> }[] {
  return TOOLS.map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  }));
}

export function toolsForOpenAI(): { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }[] {
  return TOOLS.map(t => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

export function toolsForGoogle(): { functionDeclarations: { name: string; description: string; parameters: Record<string, unknown> }[] }[] {
  return [{
    functionDeclarations: TOOLS.map(t => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    })),
  }];
}
