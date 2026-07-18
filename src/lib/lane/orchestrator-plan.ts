/**
 * Backend-neutral orchestrator plan snapshots.
 *
 * Both runtime dialects surface plan/todo state — Codex `exec --json` as
 * `item.started|updated|completed` events with `item.type === 'todo_list'`,
 * Claude stream-json as `TodoWrite`/`update_plan` tool_use blocks — but the
 * mobile surface consumes ONE shape: a complete `plan-update` snapshot (never
 * a delta) with stable per-step ids. These helpers normalize each dialect into
 * that snapshot; ws-server wraps it with repoPath/threadId/backend/agent scope.
 */

export interface OrchestratorPlanStep {
  id: string;
  step: string;
  status: 'pending' | 'in_progress' | 'completed';
}

export interface OrchestratorPlanSnapshot {
  explanation: string | null;
  steps: OrchestratorPlanStep[];
}

function normalizeStatus(value: unknown): OrchestratorPlanStep['status'] {
  const status = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (status === 'completed' || status === 'complete' || status === 'done') return 'completed';
  if (status === 'in_progress' || status === 'inprogress' || status === 'running' || status === 'active') return 'in_progress';
  return 'pending';
}

/**
 * Codex todo_list item → snapshot. Items carry only `{ text, completed }`
 * (verified against a live `codex exec --json` turn 2026-07-18); the first
 * uncompleted step is the active one, matching how the codex CLI renders it.
 * Step ids derive from the list's own item id + position — the id is stable
 * across started→updated→completed snapshots of the same list.
 */
export function planFromCodexTodoList(item: Record<string, unknown>): OrchestratorPlanSnapshot | null {
  const listId = typeof item.id === 'string' && item.id ? item.id : 'todo';
  const raw = Array.isArray(item.items) ? item.items : null;
  if (!raw) return null;
  const steps: OrchestratorPlanStep[] = [];
  let activeAssigned = false;
  raw.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object') return;
    const rec = entry as Record<string, unknown>;
    const text = typeof rec.text === 'string' ? rec.text.trim() : '';
    if (!text) return;
    const completed = rec.completed === true;
    let status: OrchestratorPlanStep['status'] = completed ? 'completed' : 'pending';
    if (!completed && !activeAssigned) {
      status = 'in_progress';
      activeAssigned = true;
    }
    steps.push({ id: `${listId}-${index}`, step: text, status });
  });
  return steps.length > 0 ? { explanation: null, steps } : null;
}

const PLAN_TOOL_NAMES = new Set(['todowrite', 'todo_write', 'write_todos', 'update_todos', 'update_plan']);

export function isPlanToolName(name: string): boolean {
  return PLAN_TOOL_NAMES.has(name.trim().toLowerCase().replace(/[.:-]/g, '_'));
}

/**
 * Plan-shaped tool input → snapshot. Covers Claude's TodoWrite
 * (`{ todos: [{ content, status }] }`) and the update_plan dialect
 * (`{ explanation?, plan: [{ step, status }] }`). Both rewrite the full list
 * every call, so position-derived ids stay stable across a turn's snapshots.
 */
export function planFromToolInput(name: string, input: unknown): OrchestratorPlanSnapshot | null {
  if (!isPlanToolName(name)) return null;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const rec = input as Record<string, unknown>;
  const raw = Array.isArray(rec.todos)
    ? rec.todos
    : Array.isArray(rec.plan)
      ? rec.plan
      : Array.isArray(rec.steps)
        ? rec.steps
        : null;
  if (!raw) return null;
  const steps: OrchestratorPlanStep[] = [];
  raw.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object') return;
    const r = entry as Record<string, unknown>;
    const text = [r.content, r.step, r.text].find(
      (v): v is string => typeof v === 'string' && v.trim().length > 0,
    )?.trim();
    if (!text) return;
    const id = typeof r.id === 'string' && r.id.trim() ? r.id.trim() : `step-${index}`;
    steps.push({ id, step: text, status: normalizeStatus(r.status) });
  });
  const explanation = typeof rec.explanation === 'string' && rec.explanation.trim() ? rec.explanation.trim() : null;
  return steps.length > 0 ? { explanation, steps } : null;
}
