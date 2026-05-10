/**
 * Smoke test for orchestrator stream dedupe (#693).
 *
 * Claude stream-json can emit text twice for one turn:
 *   1. content_block_delta events stream the visible assistant text.
 *   2. a final assistant event repeats the fully assembled text.
 *
 * The transcript should keep the streamed text and skip the final duplicate.
 *
 * Run:
 *   npx tsx scripts/smoke-orchestrator-stream-dedupe.ts
 */

import process from 'node:process';
import {
  createToolCallTracker,
  processStreamEvent,
  type OrchestratorEvent,
} from '../src/lib/lane/orchestrator-stream-events';

interface StreamRunResult {
  events: OrchestratorEvent[];
  logs: string[];
}

function runStreamEvents(rawEvents: Array<Record<string, unknown>>): StreamRunResult {
  const tracker = createToolCallTracker();
  const events: OrchestratorEvent[] = [];
  const logs: string[] = [];
  const originalLog = console.log;

  console.log = (...args: unknown[]) => {
    logs.push(args.map((arg) => String(arg)).join(' '));
  };

  try {
    for (const rawEvent of rawEvents) {
      processStreamEvent(
        rawEvent,
        (event) => events.push(event),
        () => {},
        () => {},
        tracker,
      );
    }
  } finally {
    console.log = originalLog;
  }

  return { events, logs };
}

let failed = 0;
function assert(condition: unknown, message: string): void {
  if (condition) {
    console.log(`  ok  ${message}`);
    return;
  }
  failed += 1;
  console.error(`  FAIL ${message}`);
}

console.log('Test: streamed delta plus final assistant payload emits text once');
{
  const result = runStreamEvents([
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'OK, still here.' },
    },
    {
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'OK, still here.' },
        ],
      },
    },
  ]);
  const text = result.events
    .filter((event): event is Extract<OrchestratorEvent, { type: 'text' }> => event.type === 'text')
    .map((event) => event.text)
    .join('');

  assert(text === 'OK, still here.', `text emitted once (got ${JSON.stringify(text)})`);
  assert(result.logs.some((line) => line.includes('[stream-dedupe]')), 'dedupe log emitted');
}

console.log('Test: final assistant payload still emits when no deltas streamed');
{
  const result = runStreamEvents([
    {
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Final-only response.' },
        ],
      },
    },
  ]);
  const text = result.events
    .filter((event): event is Extract<OrchestratorEvent, { type: 'text' }> => event.type === 'text')
    .map((event) => event.text)
    .join('');

  assert(text === 'Final-only response.', `final-only text emitted (got ${JSON.stringify(text)})`);
  assert(!result.logs.some((line) => line.includes('[stream-dedupe]')), 'dedupe log not emitted for final-only response');
}

if (failed > 0) {
  console.error(`[smoke-orchestrator-stream-dedupe] ${failed} assertion(s) failed`);
  process.exitCode = 1;
} else {
  console.log('[smoke-orchestrator-stream-dedupe] PASS');
}
