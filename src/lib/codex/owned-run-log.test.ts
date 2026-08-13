import { describe, expect, it } from 'vitest';

import { parsePacketSelfReview } from '@/lib/orchestrator/self-review';
import type { OwnedRunRecord } from '@/lib/runtimes/shared/owned-session';
import { codexParseRunLog } from './owned';

function run(): OwnedRunRecord {
  return {
    id: 'codex-run-long-receipt',
    mode: 'launch',
    prompt: 'inspect only',
    startedAt: '2026-08-13T22:30:00.000Z',
    finishedAt: '2026-08-13T22:31:00.000Z',
    pid: 123,
    stdoutPath: '/tmp/codex.jsonl',
    stderrPath: '/tmp/codex.stderr.log',
    outcome: 'finished',
  };
}

describe('Codex owned run log', () => {
  it('preserves a final self-review receipt after a long human-readable result', () => {
    const receipt = '<self-review> {"passed":true,"confidence":"high","summary":"Version checked.","issuesFound":[],"outcome":"Version is 0.1.680.","evidence":["package.json returned 0.1.680"],"residual":"none","decision":"finding_ready","recurrenceProtection":"none"} </self-review>';
    const finalText = `Outcome: Version checked.\n\n${'Evidence detail. '.repeat(48)}\n\n${receipt}`;
    const parsed = codexParseRunLog([
      JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }),
      JSON.stringify({
        type: 'item.completed',
        item: { id: 'item-final', type: 'agent_message', text: finalText },
      }),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } }),
    ].join('\n'), run());

    const assistant = parsed.entries.find((entry) => entry.kind === 'message');
    expect(assistant?.text.length).toBeGreaterThan(500);
    expect(parsePacketSelfReview(assistant?.text ?? '')).toMatchObject({
      passed: true,
      decision: 'finding_ready',
      outcome: 'Version is 0.1.680.',
      residual: 'none',
    });
  });
});
