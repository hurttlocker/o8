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

/**
 * Pure formatter — turn a list of rule strings into the delimited block, or
 * null when there are no rules. No I/O, no truncation surprises: rules are
 * already length-capped at write time by the store.
 */
export function formatSessionRulesBlock(rules: string[]): string | null {
  const clean = rules.map((rule) => rule.trim()).filter(Boolean);
  if (clean.length === 0) return null;
  return [
    `<${HEADER}>`,
    'These rules were set by the operator for THIS session. They govern every turn'
      + ' and every task you dispatch. Follow them unless they conflict with a safety'
      + ' rule; if a rule is unclear, ask rather than guess.',
    ...clean.map((rule) => `- ${rule}`),
    `</${HEADER}>`,
  ].join('\n');
}

/**
 * Read the active session rules for a thread and format the block. Returns null
 * when the thread has no rules (or no thread id). Swallows store errors so a
 * bad read never breaks a turn/dispatch — session rules degrade to "absent".
 */
export function buildSessionRulesBlock(threadId: string | null | undefined): string | null {
  const thread = (threadId ?? '').trim();
  if (!thread) return null;
  try {
    return formatSessionRulesBlock(listSessionRuleTexts(thread));
  } catch (error) {
    console.warn('[session-rules] failed to read rules for thread', thread, error);
    return null;
  }
}

/**
 * Prepend the session-rules block to an orchestrator turn message. When there
 * are no rules the message is returned untouched (identity), so the per-turn
 * call site stays a one-liner.
 */
export function withSessionRules(message: string, threadId: string | null | undefined): string {
  const block = buildSessionRulesBlock(threadId);
  return block ? `${block}\n\n${message}` : message;
}
