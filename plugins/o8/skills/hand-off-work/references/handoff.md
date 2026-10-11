# Durable handoff contract

The installed CLI is the execution entry point. It resolves the local app's
address and credentials; do not hardcode ports or read or print token files.
Its normal output is JSON, and these calls do not wait for terminal input.

Use this brief shape, with actual task-specific values:

```json
{
  "objective": "The authorized outcome.",
  "scope": ["The repository and bounded files or responsibility."],
  "doneTests": ["The observable acceptance test and required checks."],
  "nonGoals": ["Actions outside the authorized task."],
  "budgets": ["The agreed time, correction, or execution bound."],
  "escalationCriteria": ["The condition that needs the operator's decision."]
}
```

Replace placeholders before execution. Pass shell arguments safely, preferably
as an argument array when the environment provides one.

```sh
o8 lead start --repo <repository-path> --backend <selected-backend> \
  --model <selected-model> --effort <selected-effort> \
  --brief <brief-json-file> --idempotency-key <start-key> --json

o8 lead send <lead-id> --message <follow-up-text> \
  --idempotency-key <message-key> --json

o8 lead status <lead-id> --after <last-cursor> --json

o8 lead wait <lead-id> --turn <admitted-turn-id> \
  --after <last-cursor> --timeout 30s --json

o8 lead stop <lead-id> --reason <operator-stop-reason> --json
```

Reads do not need idempotency keys. `start` and `send` persist their keys;
the same key with different content is a conflict. `stop` operates on an
existing ID and does not accept an idempotency-key flag.

To make an already authorized verification command visible in o8, use
`o8 run -- <executable> <arguments>`. This command needs `tmux` on PATH and
can show the command's output to the operator. Do not use it for secrets,
interactive login, or commands outside the task. Preserve the child command's
exit status as one verification receipt; it is not a completion verdict.
