import { describe, it, expect } from 'vitest';

import { handleCodexJsonLine, type CodexLineHandlerState } from './codex-orchestrator-events';
import { createToolCallTracker, processStreamEvent, type OrchestratorEvent } from './orchestrator-stream-events';
import { planFromToolInput } from './orchestrator-plan';

// Verbatim lines captured from a live `codex exec --json` turn (2026-07-18
// plan-probe) — the real dialect, not a hand-written approximation. Codex
// emits the SAME full list on item.started and item.completed.
const CODEX_TODO_STARTED = '{"type":"item.started","item":{"id":"item_1","type":"todo_list","items":[{"text":"Step A","completed":true},{"text":"Step B","completed":false},{"text":"Step C","completed":false}]}}';
const CODEX_TODO_COMPLETED = '{"type":"item.completed","item":{"id":"item_1","type":"todo_list","items":[{"text":"Step A","completed":true},{"text":"Step B","completed":false},{"text":"Step C","completed":false}]}}';

function collectCodex(lines: string[]): OrchestratorEvent[] {
  const events: OrchestratorEvent[] = [];
  const state: CodexLineHandlerState = { threadId: null, cost: null };
  for (const line of lines) {
    handleCodexJsonLine(line, state, (e) => events.push(e), { isLocalModel: false });
  }
  return events;
}

describe('codex todo_list → plan snapshots', () => {
  it('maps a real todo_list item into a full plan snapshot with stable ids', () => {
    const events = collectCodex([CODEX_TODO_STARTED]);
    expect(events).toHaveLength(1);
    const plan = events[0];
    expect(plan.type).toBe('plan');
    if (plan.type !== 'plan') return;
    expect(plan.steps).toEqual([
      { id: 'item_1-0', step: 'Step A', status: 'completed' },
      { id: 'item_1-1', step: 'Step B', status: 'in_progress' },
      { id: 'item_1-2', step: 'Step C', status: 'pending' },
    ]);
  });

  it('dedupes the identical started/completed re-send within a turn', () => {
    const events = collectCodex([CODEX_TODO_STARTED, CODEX_TODO_COMPLETED]);
    expect(events.filter((e) => e.type === 'plan')).toHaveLength(1);
  });

  it('emits a fresh snapshot when the list content changes', () => {
    const updated = CODEX_TODO_COMPLETED.replace('"text":"Step B","completed":false', '"text":"Step B","completed":true');
    const events = collectCodex([CODEX_TODO_STARTED, updated]);
    const plans = events.filter((e) => e.type === 'plan');
    expect(plans).toHaveLength(2);
    if (plans[1].type !== 'plan') return;
    expect(plans[1].steps[1]).toEqual({ id: 'item_1-1', step: 'Step B', status: 'completed' });
    expect(plans[1].steps[2]).toEqual({ id: 'item_1-2', step: 'Step C', status: 'in_progress' });
  });

  it('a fresh turn state re-emits an identical plan (dedupe is per-turn)', () => {
    const first = collectCodex([CODEX_TODO_STARTED]);
    const second = collectCodex([CODEX_TODO_STARTED]);
    expect(first.filter((e) => e.type === 'plan')).toHaveLength(1);
    expect(second.filter((e) => e.type === 'plan')).toHaveLength(1);
  });
});

describe('claude TodoWrite → plan snapshots', () => {
  it('emits plan alongside the preserved tool_use from the assistant replay', () => {
    const events: OrchestratorEvent[] = [];
    const tracker = createToolCallTracker();
    processStreamEvent(
      {
        type: 'assistant',
        message: {
          content: [{
            type: 'tool_use',
            id: 'tu-1',
            name: 'TodoWrite',
            input: {
              todos: [
                { content: 'Inspect the implementation', status: 'completed', activeForm: 'Inspecting' },
                { content: 'Apply the changes', status: 'in_progress', activeForm: 'Applying' },
              ],
            },
          }],
        },
      },
      (e) => events.push(e),
      () => {},
      () => {},
      tracker,
    );
    expect(events.map((e) => e.type)).toEqual(['tool_use', 'plan']);
    const plan = events[1];
    if (plan.type !== 'plan') return;
    expect(plan.steps).toEqual([
      { id: 'step-0', step: 'Inspect the implementation', status: 'completed' },
      { id: 'step-1', step: 'Apply the changes', status: 'in_progress' },
    ]);
  });

  it('non-plan tools emit no plan event', () => {
    const events: OrchestratorEvent[] = [];
    const tracker = createToolCallTracker();
    processStreamEvent(
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu-2', name: 'Bash', input: { command: 'ls' } }] } },
      (e) => events.push(e),
      () => {},
      () => {},
      tracker,
    );
    expect(events.map((e) => e.type)).toEqual(['tool_use']);
  });
});

describe('update_plan dialect', () => {
  it('normalizes { explanation, plan: [{ step, status }] }', () => {
    const plan = planFromToolInput('update_plan', {
      explanation: 'Two-phase fix',
      plan: [
        { step: 'Find the bug', status: 'completed' },
        { step: 'Fix it', status: 'in_progress' },
      ],
    });
    expect(plan).toEqual({
      explanation: 'Two-phase fix',
      steps: [
        { id: 'step-0', step: 'Find the bug', status: 'completed' },
        { id: 'step-1', step: 'Fix it', status: 'in_progress' },
      ],
    });
  });
});
