/**
 * Session-rules prompt block (#1329) — the ONE formatter for the
 * "Operator session rules (binding)" envelope. Shared by:
 *   - the per-turn orchestrator injection (`ws-server.ts` → every backend), and
 *   - the worker-inheritance injection (`buildPacketPrompt`).
 *
 * A clearly-delimited block so the model reads these as binding constraints,
 * not chat. Kept tiny + pure at the formatting layer so it's trivially testable;
 * the store read lives in `buildSessionRulesBlock`.
 */

import { listSessionRuleTexts } from '@/lib/db/session-rules-store';

const HEADER = 'Operator session rules (binding)';

interface SessionRulesBlockOptions {
  /**
   * In-band dispatch teaching (orchestrator turns only). Nothing else tells
   * the model its own thread id, so without this line it would omit
   * `orchestratorThreadId` on `create_mission` and worker inheritance would
   * never fire end-to-end. Set to the thread id on the per-turn injection
   * path; leave unset for worker prompts (workers don't create missions from
   * a rule-bearing thread — the instruction would just be noise there).
   */
  teachDispatchThreadId?: string;
}

/**
 * Pure formatter — turn a list of rule strings into the delimited block, or
 * null when there are no rules. No I/O, no truncation surprises: rules are
 * already length-capped at write time by the store.
 */
export function formatSessionRulesBlock(rules: string[], options?: SessionRulesBlockOptions): string | null {
  const clean = rules.map((rule) => rule.trim()).filter(Boolean);
  if (clean.length === 0) return null;
  const teachId = options?.teachDispatchThreadId?.trim();
  return [
    `<${HEADER}>`,
    'These rules were set by the operator for THIS session. They govern every turn'
      + ' and every task you dispatch. Follow them unless they conflict with a safety'
      + ' rule; if a rule is unclear, ask rather than guess.',
    ...clean.map((rule) => `- ${rule}`),
    ...(teachId
      ? [
          `When you dispatch work (create_mission / o8 mission create), pass orchestratorThreadId: "${teachId}"`
            + ' so the dispatched workers inherit these rules (o8 records a rules_applied audit event per dispatch).',
        ]
      : []),
    `</${HEADER}>`,
  ].join('\n');
}

/**
 * Read the active session rules for a thread and format the block. Returns null
 * when the thread has no rules (or no thread id). Swallows store errors so a
 * bad read never breaks a turn/dispatch — session rules degrade to "absent".
 */
export function buildSessionRulesBlock(
  threadId: string | null | undefined,
  options?: { teachDispatch?: boolean },
): string | null {
  const thread = (threadId ?? '').trim();
  if (!thread) return null;
  try {
    return formatSessionRulesBlock(
      listSessionRuleTexts(thread),
      options?.teachDispatch ? { teachDispatchThreadId: thread } : undefined,
    );
  } catch (error) {
    console.warn('[session-rules] failed to read rules for thread', thread, error);
    return null;
  }
}

/**
 * Prepend the session-rules block to an orchestrator turn message. When there
 * are no rules the message is returned untouched (identity), so the per-turn
 * call site stays a one-liner.
 *
 * Coverage note: this runs on the interactive path (`handleOrchestratorSendMsg`
 * in ws-server.ts) — the only turn source that carries an operator thread id.
 * Two automated paths call `backend.sendTurn()` directly and intentionally
 * bypass injection: auto-review (`lane/auto-review.ts`) and GitHub intake
 * (`intake/github-intake.ts`). Both are thread-less (repoPath only), so they
 * have no session tier to inject — do not "fix" that by threading synthetic
 * ids through them.
 *
 * The block also carries the dispatch-teaching line (thread id + the
 * instruction to pass `orchestratorThreadId` on create_mission) — the in-band
 * mechanism that makes worker inheritance reachable: nothing else ever tells
 * the model its own thread id.
 */
export function withSessionRules(message: string, threadId: string | null | undefined): string {
  const block = buildSessionRulesBlock(threadId, { teachDispatch: true });
  return block ? `${block}\n\n${message}` : message;
}
