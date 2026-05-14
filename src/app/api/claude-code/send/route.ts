import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Disabled June 2026 — Anthropic's pricing change billed every `claude -p`
 * spawn against the user's Agent SDK credit pool. This route used to spawn
 * `claude -p` in stream-json mode for chat turns, burning SDK credits with no
 * gate on `inAppOrchestratorEnabled`.
 *
 * The other claude-code surfaces shipped a 410 in v0.1.133 — this route was
 * missed and tracked in #1047. Now mirrors that pattern.
 *
 * Operators who want Claude reach it directly via:
 *   - Claude Code TUI / Desktop (unlimited interactive pool)
 *   - The LLM proxy with their own `ANTHROPIC_API_KEY` (BYOK, not SDK pool)
 *   - The o8 in-app orchestrator with the `inAppOrchestratorEnabled` toggle ON
 *     (opt-in to SDK billing)
 */
export async function POST() {
  return NextResponse.json(
    {
      error: 'claude-code CLI chat is disabled in o8. Use Claude Code TUI / Desktop directly, the LLM proxy with your ANTHROPIC_API_KEY, or toggle on the in-app orchestrator (Settings → Operator Defaults → 07) to opt in to Anthropic SDK billing.',
      reason: 'sdk-pool-protection',
      epic: 'https://github.com/hurttlocker/cortex-ide/issues/1044',
    },
    { status: 410 },
  );
}
