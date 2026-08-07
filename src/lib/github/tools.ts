/**
 * GitHub Tools for LLM Chat
 *
 * Tools that let the LLM interact with GitHub:
 * - create_github_issue: Create a new issue
 * - read_github_issue_or_pr: Read issue/PR details + comments
 * - create_pull_request: Branch, commit, push, open PR
 *
 * All mutating tools require user approval before execution.
 */

import { execFileSync } from 'node:child_process';

interface GitHubToolResult {
  content: string;
  requiresApproval?: boolean;
  approvalSummary?: string;
  sources?: { title: string; url?: string; path?: string }[];
}

// ── Tool: Create GitHub Issue ──

export async function createGithubIssue(args: {
  repo: string;
  title: string;
  body: string;
  labels?: string[];
}): Promise<GitHubToolResult> {
  try {
    const { repo, title, body, labels } = args;

    // Use argument array — no shell, no escaping issues
    const ghArgs = ['issue', 'create', '--repo', repo, '--title', title, '--body', body];
    if (labels?.length) {
      for (const label of labels) {
        ghArgs.push('-l', label);
      }
    }

    const output = execFileSync('gh', ghArgs, { windowsHide: true, encoding: 'utf-8', timeout: 15000 }).trim();

    const urlMatch = output.match(/(https:\/\/github\.com\/[^\s]+)/);
    const issueUrl = urlMatch ? urlMatch[1] : output;

    return {
      content: `✅ Issue created: ${issueUrl}`,
      sources: [{ title, url: issueUrl }],
    };
  } catch (err) {
    return { content: `Error creating issue: ${err instanceof Error ? err.message : 'Unknown'}` };
  }
}

// ── Tool: Read GitHub Issue or PR ──

export async function readGithubIssueOrPr(args: {
  repo: string;
  number: number;
}): Promise<GitHubToolResult> {
  try {
    const { repo, number: num } = args;
    const numStr = String(num);

    // Try issue first, fall back to PR
    let raw: string;
    try {
      raw = execFileSync('gh', ['issue', 'view', numStr, '--repo', repo, '--json', 'title,body,state,labels,assignees,comments,url'], { windowsHide: true, encoding: 'utf-8', timeout: 10000 }).trim();
    } catch {
      raw = execFileSync('gh', ['pr', 'view', numStr, '--repo', repo, '--json', 'title,body,state,labels,assignees,comments,url,additions,deletions,files'], { windowsHide: true, encoding: 'utf-8', timeout: 10000 }).trim();
    }

    const data = JSON.parse(raw);
    const lines: string[] = [];

    lines.push(`# ${data.title}`);
    lines.push(`**State:** ${data.state} · **URL:** ${data.url}`);

    if (data.labels?.length) {
      lines.push(`**Labels:** ${data.labels.map((l: { name: string }) => l.name).join(', ')}`);
    }
    if (data.assignees?.length) {
      lines.push(`**Assignees:** ${data.assignees.map((a: { login: string }) => a.login).join(', ')}`);
    }
    if (data.additions !== undefined) {
      lines.push(`**Changes:** +${data.additions} / -${data.deletions} across ${data.files?.length || 0} files`);
    }

    lines.push('');
    lines.push(data.body || '*No description*');

    if (data.comments?.length) {
      lines.push('');
      lines.push(`## Comments (${data.comments.length})`);
      for (const comment of data.comments.slice(-5)) {
        lines.push(`---`);
        lines.push(`**${comment.author?.login || 'unknown'}** (${new Date(comment.createdAt).toLocaleDateString()}):`);
        lines.push(comment.body);
      }
    }

    // If it's a PR, get the diff too
    if (data.additions !== undefined) {
      try {
        const diff = execFileSync('gh', ['pr', 'diff', numStr, '--repo', repo], { windowsHide: true, encoding: 'utf-8', timeout: 10000 }).trim();
        if (diff) {
          const diffLines = diff.split('\n').slice(0, 200);
          lines.push('');
          lines.push('## Diff (first 200 lines)');
          lines.push('```diff');
          lines.push(diffLines.join('\n'));
          lines.push('```');
        }
      } catch { /* no diff available */ }
    }

    return {
      content: lines.join('\n'),
      sources: [{ title: `#${num}: ${data.title}`, url: data.url }],
    };
  } catch (err) {
    return { content: `Error reading #${args.number}: ${err instanceof Error ? err.message : 'Unknown'}` };
  }
}

// ── Tool: Create Pull Request ──

export async function createPullRequest(args: {
  repo: string;
  branch: string;
  title: string;
  body: string;
  baseBranch?: string;
}): Promise<GitHubToolResult> {
  const repoRoot = process.env.CORTEX_IDE_REVIEW_REPO_ROOT || process.cwd();
  const opts = { windowsHide: true, encoding: 'utf-8' as const, cwd: repoRoot, timeout: 15000 };

  try {
    const { repo, branch, title, body, baseBranch } = args;

    // 1. Check for uncommitted changes
    const status = execFileSync('git', ['status', '--porcelain'], opts).trim();
    if (!status) {
      return { content: 'No uncommitted changes to create a PR from.' };
    }

    // 2. Create branch
    const safeBranch = branch.replace(/[^a-zA-Z0-9/_-]/g, '-');
    execFileSync('git', ['checkout', '-b', safeBranch], opts);

    // 3. Stage and commit
    execFileSync('git', ['add', '-A'], opts);
    execFileSync('git', ['commit', '-m', title], opts);

    // 4. Push branch
    execFileSync('git', ['push', 'origin', safeBranch], opts);

    // 5. Create PR
    const base = baseBranch || 'main';
    const output = execFileSync('gh', [
      'pr', 'create',
      '--repo', repo,
      '--base', base,
      '--head', safeBranch,
      '--title', title,
      '--body', body,
    ], opts).trim();

    const urlMatch = output.match(/(https:\/\/github\.com\/[^\s]+)/);
    const prUrl = urlMatch ? urlMatch[1] : output;

    // 6. Return to main
    execFileSync('git', ['checkout', 'main'], opts);

    return {
      content: `✅ Pull request created: ${prUrl}\n\nBranch: \`${safeBranch}\`\nChanges:\n\`\`\`\n${status}\n\`\`\``,
      sources: [{ title, url: prUrl }],
    };
  } catch (err) {
    try { execFileSync('git', ['checkout', 'main'], opts); } catch { /* best effort */ }
    return { content: `Error creating PR: ${err instanceof Error ? err.message : 'Unknown'}` };
  }
}
