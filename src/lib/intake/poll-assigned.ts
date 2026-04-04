/**
 * Poll for assigned GitHub issues that haven't been processed yet.
 *
 * Runs on startup to catch issues assigned while the app was closed.
 * The webhook handles real-time; this is the reliability layer.
 */

import 'server-only';

const LOG_PREFIX = '[intake-poll]';

export async function pollUnprocessedAssignedIssues(
  repoFullName: string,
  repoPath: string,
): Promise<{ processed: number }> {
  const { listGitHubIssues } = await import('@/lib/github-broker/store');
  const { readOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');

  const issues = listGitHubIssues(repoFullName);
  const state = readOrchestratorControlPlaneState();

  // Find open issues with assignees that don't have matching packets
  const existingIssueNumbers = new Set(
    state.packets
      .map((p) => {
        const match = p.title.match(/#(\d+)/);
        return match ? Number(match[1]) : null;
      })
      .filter((n): n is number => n !== null),
  );

  const unprocessed = issues.filter((issue) =>
    issue.state === 'open'
    && issue.assignees.length > 0
    && !existingIssueNumbers.has(issue.number),
  );

  if (unprocessed.length === 0) {
    console.log(`${LOG_PREFIX} No unprocessed assigned issues for ${repoFullName}`);
    return { processed: 0 };
  }

  console.log(`${LOG_PREFIX} Found ${unprocessed.length} unprocessed assigned issue(s) for ${repoFullName}`);

  const { processAssignedIssue } = await import('@/lib/intake/github-intake');
  let processed = 0;

  for (const issue of unprocessed) {
    try {
      const result = await processAssignedIssue(issue, repoFullName, repoPath);
      if (result.ok) processed++;
    } catch (error) {
      console.error(`${LOG_PREFIX} Failed to process issue #${issue.number}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  console.log(`${LOG_PREFIX} Processed ${processed}/${unprocessed.length} assigned issues`);
  return { processed };
}
