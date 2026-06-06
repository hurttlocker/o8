/**
 * Billing guard (#1066). `claude -p` / `--print` routes the spawn to the gated
 * Agent SDK pool instead of the user's interactive Claude Code subscription
 * pool. Every o8 code path that spawns `claude` must stay subscription-billed,
 * so this is the single shared chokepoint that rejects the print flags before
 * spawn — call it from every `claude` arg builder so the rule can't silently
 * regress in one place while another only documents it in a comment.
 */
export function assertNoPrintFlag(args: readonly string[], context = 'Claude Code'): void {
  if (args.includes('-p') || args.includes('--print')) {
    throw new Error(`${context} must not use -p/--print — those flip billing to the Agent SDK pool (#1066).`);
  }
}
