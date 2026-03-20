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
];

// Tools that require user approval before execution
export const APPROVAL_REQUIRED_TOOLS = new Set([
  'create_github_issue',
  'create_pull_request',
]);

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
    default: return { content: `Unknown tool: ${name}` };
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
