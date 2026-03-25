import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildContextArgs,
  buildFeedbackArgs,
  buildRecallArgs,
  runCortexContext,
  runCortexFeedback,
  runCortexRecall,
} from './fact-backed';

function writeMockCortexBinary() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cortex-fact-backed-'));
  const binaryPath = path.join(dir, 'cortex');
  writeFileSync(binaryPath, `#!/bin/sh
cmd="$1"
shift
case "$cmd" in
  recall)
    cat <<'JSON'
{
  "items": [
    {
      "id": 101,
      "fact_id": 101,
      "memory_id": 55,
      "text": "Payment amounts are stored as integer cents.",
      "fact_type": "decision",
      "fact_state": "active",
      "confidence": 0.94,
      "relevance": 0.91,
      "quality_score": 0.95,
      "source_tier": "canonical",
      "memory_kind": "durable_fact",
      "retrieval_visibility": "primary",
      "evidence_count": 2,
      "evidence": [
        {
          "memory_id": 55,
          "source_file": "docs/decisions.md",
          "source_line": 12,
          "quote": "payment amounts are stored as integer cents"
        }
      ],
      "reasons": ["fact_backed", "source_tier_canonical"],
      "prompt_eligible": true
    }
  ],
  "diagnostics": {
    "searched": 18,
    "fact_backed": 1,
    "journal_only": 0,
    "dropped_by_policy": 0
  }
}
JSON
    ;;
  context)
    cat <<'JSON'
{
  "items": [
    {
      "id": 101,
      "fact_id": 101,
      "memory_id": 55,
      "text": "Payment amounts are stored as integer cents.",
      "fact_type": "decision",
      "fact_state": "active",
      "confidence": 0.94,
      "relevance": 0.91,
      "quality_score": 0.95,
      "source_tier": "canonical",
      "memory_kind": "durable_fact",
      "retrieval_visibility": "primary",
      "evidence_count": 1,
      "evidence": [
        {
          "memory_id": 55,
          "source_file": "docs/decisions.md",
          "source_line": 12,
          "quote": "payment amounts are stored as integer cents"
        }
      ],
      "reasons": ["fact_backed"],
      "prompt_eligible": true
    }
  ],
  "structured_block": "<cortex-facts>\\n<fact id=\\"101\\">Payment amounts are stored as integer cents.</fact>\\n</cortex-facts>",
  "token_count": 42,
  "diagnostics": {
    "searched": 18,
    "fact_backed": 1,
    "journal_only": 0,
    "dropped_by_policy": 0
  }
}
JSON
    ;;
  feedback)
    cat <<'JSON'
{
  "fact_id": 101,
  "action": "dismiss_for_query",
  "status": "ok",
  "query": "payment processing",
  "reason": "stale in this context"
}
JSON
    ;;
  *)
    echo "unknown command" >&2
    exit 1
    ;;
esac
`);
  chmodSync(binaryPath, 0o755);
  return binaryPath;
}

test('build recall/context/feedback args from the new core contract', () => {
  assert.deepEqual(
    buildRecallArgs({ query: 'payment processing', limit: 6, project: 'cortex-ide', includeSuperseded: true }),
    ['recall', 'payment processing', '--limit', '6', '--project', 'cortex-ide', '--include-superseded', '--json'],
  );

  assert.deepEqual(
    buildContextArgs({ query: 'payment processing', limit: 6, maxItems: 4, maxTokens: 320 }),
    ['context', 'payment processing', '--limit', '6', '--json', '--max-items', '4', '--max-tokens', '320'],
  );

  assert.deepEqual(
    buildFeedbackArgs({
      factId: 101,
      action: 'supersede',
      relatedFactId: 202,
      reason: 'policy updated',
    }),
    ['feedback', '101', 'supersede', '--by', '202', '--reason', 'policy updated', '--json'],
  );
});

test('maps recall/context/feedback command output into the IDE fact-backed shapes', () => {
  const binaryPath = writeMockCortexBinary();

  const recall = runCortexRecall({ query: 'payment processing', limit: 6, binaryPath });
  assert.equal(recall.items.length, 1);
  assert.equal(recall.items[0].factId, 101);
  assert.equal(recall.items[0].sourceTier, 'canonical');
  assert.equal(recall.items[0].promptEligible, true);
  assert.equal(recall.items[0].evidenceCount, 2);
  assert.deepEqual(recall.items[0].reasons, ['fact_backed', 'source_tier_canonical']);
  assert.equal(recall.diagnostics.factBacked, 1);

  const context = runCortexContext({ query: 'payment processing', maxItems: 4, maxTokens: 320, binaryPath });
  assert.equal(context.factCount, 1);
  assert.equal(context.tokenCount, 42);
  assert.match(context.contextBlock, /<cortex-facts>/);
  assert.equal(context.facts[0].retrievalVisibility, 'primary');

  const feedback = runCortexFeedback({
    factId: 101,
    action: 'dismiss_for_query',
    query: 'payment processing',
    reason: 'stale in this context',
    binaryPath,
  });
  assert.equal(feedback.action, 'dismiss_for_query');
  assert.equal(feedback.factId, 101);
  assert.equal(feedback.query, 'payment processing');
});
