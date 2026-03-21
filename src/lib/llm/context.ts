/**
 * Workspace context injection for LLM Chat.
 *
 * Gathers repo info, file tree, git status, and recent activity
 * to build a system prompt that makes the model workspace-aware.
 */

import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = process.env.CORTEX_IDE_REVIEW_REPO_ROOT || '/Users/marquisehurtt/clawd/repos/cortex-ide';

// Project rules files — checked in priority order, first found wins
const RULES_FILES = [
  '.cortexrules',
  '.cortex/rules.md',
  '.cursorrules',
  '.clinerules',
  'AGENTS.md',
];

interface WorkspaceContext {
  repoName: string;
  branch: string;
  status: string;         // git status --short
  recentCommits: string;  // last 5 commits oneline
  fileTreeSummary: string; // top-level + key dirs
}

function safeExec(cmd: string, cwd: string, timeoutMs = 3000): string {
  try {
    return execSync(cmd, { cwd, encoding: 'utf-8', timeout: timeoutMs }).trim();
  } catch {
    return '';
  }
}

export function getWorkspaceContext(): WorkspaceContext {
  const repoName = safeExec('basename $(git rev-parse --show-toplevel 2>/dev/null)', REPO_ROOT) || 'unknown';
  const branch = safeExec('git branch --show-current', REPO_ROOT) || 'main';
  const status = safeExec('git status --short --untracked-files=no', REPO_ROOT) || '(clean)';
  const recentCommits = safeExec('git log --oneline -5 --no-decorate', REPO_ROOT) || '(no commits)';

  // File tree — top level + key subdirs, truncated
  const topLevel = safeExec('ls -1', REPO_ROOT);
  const srcDirs = safeExec("find src -maxdepth 2 -type d 2>/dev/null | head -30", REPO_ROOT);
  const fileTreeSummary = topLevel + (srcDirs ? '\n\nsrc/ structure:\n' + srcDirs : '');

  return { repoName, branch, status, recentCommits, fileTreeSummary };
}

/**
 * Load project rules from .cortexrules, .cursorrules, etc.
 * First file found wins. Max 4KB to prevent context bloat.
 */
function loadProjectRules(): { content: string; source: string } | null {
  for (const filename of RULES_FILES) {
    const filepath = join(REPO_ROOT, filename);
    if (existsSync(filepath)) {
      try {
        let content = readFileSync(filepath, 'utf-8').trim();
        if (content.length > 4096) {
          content = content.slice(0, 4096) + '\n... (truncated — max 4KB)';
        }
        return { content, source: filename };
      } catch {
        continue;
      }
    }
  }
  return null;
}

export function buildSystemPrompt(ctx: WorkspaceContext): string {
  const rules = loadProjectRules();

  return `You are an AI assistant integrated into Cortex IDE, a desktop coding environment.

## Current Workspace
- **Repository:** ${ctx.repoName}
- **Branch:** ${ctx.branch}

## Git Status
\`\`\`
${ctx.status}
\`\`\`

## Recent Commits
\`\`\`
${ctx.recentCommits}
\`\`\`

## File Structure
\`\`\`
${ctx.fileTreeSummary}
\`\`\`

## Guidelines
- You have context about this workspace. Reference files and structure when relevant.
- Be concise and actionable. Suggest specific file paths when discussing code.
- You can see the repo structure but cannot yet read or edit files directly.
- When the user asks about code, reference the file tree to guide them.
- Format code blocks with language tags for syntax highlighting.
- When generating Mermaid diagrams, use simple syntax: short node IDs (A, B, C), avoid special characters in labels, use \`graph TD\` or \`flowchart TD\` for flow charts. Keep labels short and wrap in square brackets like \`A[Label]\`. Avoid pipes in labels.
- When you use information from tool results (search_web, read_file, search_code), cite your sources inline using numbered references like [1], [2], etc. The source cards will be shown separately — just use the numbers in your text to reference them.${rules ? `

## Project Rules (from ${rules.source})
${rules.content}` : ''}`;
}
