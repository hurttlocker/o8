# Self-tuning harness

The harness gives long-running agent work durable inputs, explicit execution contracts, and evidence that survives a process restart. It complements missions and packets: missions organize work, while the harness records what the repository needs, what one sprint agreed to do, how it was verified, and whether an optional harness component helps a specific model.

All commands return JSON by default. The same operations are available from the full operator MCP profile, and both surfaces use the authenticated `/api/harness` route.

## Grounded execution loop

1. Add repository features and choose the highest-priority failing entry.

   ```sh
   o8 feature add --title "Preserve packet review evidence" --priority 10 --command-json '["npm","test"]'
   o8 feature next
   ```

2. Ground the task against tracked paths and symbols, then read the complete restart-safe boot envelope.

   ```sh
   o8 ground --task "Preserve packet review evidence" --accept "The persisted review survives restart"
   o8 boot --task "Preserve packet review evidence"
   ```

3. Propose generator and evaluator terms. A worker may propose a contract, but an operator must accept it before a sprint can start.

   ```sh
   o8 contract propose \
     --feature feature-id \
     --generator "Change only the persisted review seam and focused tests." \
     --evaluator "Reject in-memory-only state or unrelated changes." \
     --accept "The persisted review survives restart"
   o8 contract accept contract-id
   ```

4. Start a one-feature sprint and record computational evidence. A sprint advances only after its current feature passes; failing and blocked features remain visible.

   ```sh
   o8 sprint start contract-id
   o8 verify feature-id --passed --evidence "Focused and restart tests passed" --exit-code 0 --sprint sprint-id
   ```

Feature checks are append-only. The feature's current state is a projection of the latest non-skipped check, so the evidence history remains available when a later check fails.

## Model-keyed lift

Lift measurements compare paired baseline and enabled scores for one component and model. Recording a measurement produces a recommendation but never changes the component lifecycle.

```sh
o8 harness measure \
  --component blind-second-pass \
  --model gpt-5 \
  --baseline 0.81 \
  --enabled 0.84 \
  --samples 20 \
  --evidence-json '{"suite":"packet-review-v1"}'
o8 harness status --component blind-second-pass --model gpt-5
```

Lifecycle mutation is explicit and ordered: `retained` to `candidate` to `shadow_only` to `retired`. An operator can re-arm a retired component to `retained`. Retirement is rejected unless shadow evidence has at least ten paired samples and non-positive weighted lift.

```sh
o8 harness transition \
  --component blind-second-pass \
  --model gpt-5 \
  --to candidate \
  --reason "Paired evidence is below the retention threshold."
```

## Skeptical review and CI

`o8 evaluate-diff` sends only the task, acceptance criteria, and unified diff to the active reviewer backend. It does not include the generator transcript, plan, self-review, or claimed test results. Invalid reviewer output fails closed as `inconclusive`.

```sh
o8 evaluate-diff \
  --task "Preserve packet review evidence" \
  --accept "The persisted review survives restart" \
  --base main
```

`o8 ci` reads `o8.ci.json` by default. Commands are argument arrays and run without a shell. Checks with a `featureId` append their result to the feature ledger; the optional skeptic runs only after every computational check passes.

```json
{
  "schema": "o8/ci/v1",
  "repoPath": ".",
  "sprintId": "sprint-id",
  "checks": [
    {
      "name": "focused tests",
      "command": ["npx", "vitest", "run", "tests/review-persistence.test.ts"],
      "featureId": "feature-id",
      "timeoutMs": 600000
    }
  ],
  "skeptic": {
    "task": "Preserve packet review evidence",
    "base": "main",
    "acceptanceCriteria": ["The persisted review survives restart"]
  }
}
```

The process exits nonzero when a computational check fails or the skeptic does not approve.

## Capabilities and portability

`o8 capabilities --model <id>` returns the versioned artifact catalog, recommended call order, limits, and model-specific lifecycle guidance. Use it instead of assuming which harness surfaces an installation supports.

HarnessBundle moves non-secret feature, contract, grounding, measurement, and component state between installations:

```sh
o8 harness export --out harness-bundle.json
o8 harness import --file harness-bundle.json --repo /path/to/target
```

Bundle import validates the version and bounds, remaps repository-scoped identifiers, and preserves measurement provenance. Tokens, credentials, lane sessions, and sprint ownership are not exported.

## Authority boundaries

Operators may mutate the feature ledger, accept contracts, start sprints, change component lifecycle, invoke the reviewer, and import bundles. Packet-bound workers are restricted to their registered repository; they may read artifacts, ground work, propose contracts, record evidence, and tick only their own sprint. Anonymous and device credentials cannot call the harness route.
