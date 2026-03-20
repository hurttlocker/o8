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

import { execSync } from 'node:child_process';

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
    const labelArgs = labels?.length ? labels.map(l => `-l "${l}"`).join(' ') : '';

    const cmd = `gh issue create --repo "${repo}" --title "${title.replace(/"/g, '\\"')}" --body "${body.replace(/"/g, '\\"').replace(/\n/g, '\\n')}" ${labelArgs} 2>&1`;
    const output = execSync(cmd, { encoding: 'utf-8', timeout: 15000 }).trim();

    // Extract issue URL from output
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

    // Get issue/PR details
    const detailCmd = `gh issue view ${num} --repo "${repo}" --json title,body,state,labels,assignees,comments,url 2>&1 || gh pr view ${num} --repo "${repo}" --json title,body,state,labels,assignees,comments,url,additions,deletions,files 2>&1`;
    const raw = execSync(detailCmd, { encoding: 'utf-8', timeout: 10000 }).trim();

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

    // If it's a PR, get the diff too (abbreviated)
    if (data.additions !== undefined) {
      try {
        const diffCmd = `gh pr diff ${num} --repo "${repo}" 2>&1 | head -200`;
        const diff = execSync(diffCmd, { encoding: 'utf-8', timeout: 10000 }).trim();
        if (diff) {
          lines.push('');
          lines.push('## Diff (first 200 lines)');
          lines.push('```diff');
          lines.push(diff);
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
  try {
    const { repo, branch, title, body, baseBranch } = args;
    const repoRoot = process.env.CORTEX_IDE_REVIEW_REPO_ROOT || '/Users/marquisehurtt/clawd/repos/cortex-ide';

    // 1. Check for uncommitted changes
    const status = execSync(`cd "${repoRoot}" && git status --porcelain`, { encoding: 'utf-8' }).trim();
    if (!status) {
      return { content: 'No uncommitted changes to create a PR from.' };
    }

    // 2. Create branch
    const safeBranch = branch.replace(/[^a-zA-Z0-9/_-]/g, '-');
    execSync(`cd "${repoRoot}" && git checkout -b "${safeBranch}"`, { encoding: 'utf-8', timeout: 5000 });

    // 3. Stage and commit all changes
    const commitMsg = title;
    execSync(`cd "${repoRoot}" && git add -A && git commit -m "${commitMsg.replace(/"/g, '\\"')}"`, { encoding: 'utf-8', timeout: 10000 });

    // 4. Push branch
    execSync(`cd "${repoRoot}" && git push origin "${safeBranch}" 2>&1`, { encoding: 'utf-8', timeout: 15000 });

    // 5. Create PR
    const base = baseBranch || 'main';
    const prCmd = `gh pr create --repo "${repo}" --base "${base}" --head "${safeBranch}" --title "${title.replace(/"/g, '\\"')}" --body "${body.replace(/"/g, '\\"').replace(/\n/g, '\\n')}" 2>&1`;
    const output = execSync(prCmd, { encoding: 'utf-8', timeout: 15000 }).trim();

    const urlMatch = output.match(/(https:\/\/github\.com\/[^\s]+)/);
    const prUrl = urlMatch ? urlMatch[1] : output;

    // 6. Return to main
    execSync(`cd "${repoRoot}" && git checkout main 2>&1`, { encoding: 'utf-8', timeout: 5000 });

    return {
      content: `✅ Pull request created: ${prUrl}\n\nBranch: \`${safeBranch}\`\nChanges:\n\`\`\`\n${status}\n\`\`\``,
      sources: [{ title, url: prUrl }],
    };
  } catch (err) {
    // Try to return to main on failure
    try {
      const repoRoot = process.env.CORTEX_IDE_REVIEW_REPO_ROOT || '/Users/marquisehurtt/clawd/repos/cortex-ide';
      execSync(`cd "${repoRoot}" && git checkout main 2>&1`, { encoding: 'utf-8' });
    } catch { /* best effort */ }
    return { content: `Error creating PR: ${err instanceof Error ? err.message : 'Unknown'}` };
  }
}
