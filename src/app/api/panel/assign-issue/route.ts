import { NextResponse } from 'next/server';
import { execSync } from 'node:child_process';

/**
 * POST /api/panel/assign-issue
 * Body: { issue: number, agent: string }
 *
 * Assigns a GitHub issue to an agent by adding a comment and label.
 * Future: will actually spawn an agent session to work on the issue.
 */

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { issue, agent, repo } = body;

    if (!issue || !agent) {
      return NextResponse.json({ error: 'Missing issue or agent' }, { status: 400 });
    }

    const repoFlag = repo ? `--repo ${repo}` : '';

    // Add a comment noting the assignment
    const comment = `🤖 Assigned to **${agent}** via Cortex IDE timeline drill-down.`;
    try {
      execSync(
        `gh issue comment ${issue} ${repoFlag} --body "${comment.replace(/"/g, '\\"')}" 2>/dev/null`,
        { timeout: 10000 }
      );
    } catch { /* comment failed, continue anyway */ }

    // Add label
    try {
      execSync(
        `gh issue edit ${issue} ${repoFlag} --add-label "agent:${agent.toLowerCase()}" 2>/dev/null`,
        { timeout: 10000 }
      );
    } catch { /* label may not exist, that's ok */ }

    return NextResponse.json({
      ok: true,
      issue,
      agent,
      message: `Issue #${issue} assigned to ${agent}`,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
