# Attempt Learnings

Latest bounded learnings captured from failed retry attempts.

## Packet pkt-19831fce-2ba0-422f-a70a-a5ed82ce18b6 attempt 1

```json
{
  "packetId": "pkt-19831fce-2ba0-422f-a70a-a5ed82ce18b6",
  "attempt": 1,
  "timestamp": "2026-06-03T01:24:04.922Z",
  "typecheckOutput": "Post-completion rule check failed. These are mechanical invariants — every violation is a user-visible bug waiting to ship.\n\nViolations (4) across 2 file(s):\n\n**src/components/desktop/onboarding/OnboardingRuntimeStep.tsx**\n- L106 [css-shorthand] Use longhand paddingTop / paddingLeft instead of padding: '12px 14px'. React 19 warns on mixed shorthand/longhand.\n- L149 [css-shorthand] Use longhand paddingTop / paddingLeft instead of padding: '10px 12px'. React 19 warns on mixed shorthand/longhand.\n- L163 [css-shorthand] Use longhand paddingTop / paddingLeft instead of padding: '10px 12px'. React 19 warns on mixed shorthand/longhand.\n\n**src/lib/runtimes/shared/owned-session/store.ts**\n- L1089 [file-ceiling] File grew to 1089 lines (was 1059, max 800). Decompose before shipping — extract hooks, subcomponents, or types first.\n\nFix each violation, re-verify locally (`npm run rule-check`), then report completion again.\n\nThe platform enforces these rules mechanically because multi-constraint holding is where weaker models drop rules — CLAUDE.md invariants are not optional.",
  "selfReviewSummary": "Agent completion did not include the required self-review block.",
  "filesChanged": [
    "src/components/desktop/onboarding/OnboardingRuntimeStep.tsx",
    "src/lib/runtimes/shared/owned-session/store.ts",
    "CLAUDE.md"
  ],
  "summary": "Self-review: Agent completion did not include the required self-review block."
}
```

## Packet pkt-3f51e736-bb6d-4b73-b322-2b47c30ced53 attempt 2

```json
{
  "packetId": "pkt-3f51e736-bb6d-4b73-b322-2b47c30ced53",
  "attempt": 2,
  "timestamp": "2026-06-06T23:19:49.181Z",
  "typecheckOutput": "Post-completion rule check failed. These are mechanical invariants — every violation is a user-visible bug waiting to ship.\n\nViolations (2) across 2 file(s):\n\n**src/components/desktop/thoughts/ThoughtsChatPanel.tsx**\n- L2117 [file-ceiling] File grew to 2117 lines (was 2071, max 800). Decompose before shipping — extract hooks, subcomponents, or types first.\n\n**src/components/desktop/thoughts/useOrchestratorStream.ts**\n- L897 [file-ceiling] File grew to 897 lines (was 887, max 800). Decompose before shipping — extract hooks, subcomponents, or types first.\n\nFix each violation, re-verify locally (`npm run rule-check`), then report completion again.\n\nThe platform enforces these rules mechanically because multi-constraint holding is where weaker models drop rules — CLAUDE.md invariants are not optional.",
  "selfReviewSummary": "Agent completion did not include the required self-review block.",
  "filesChanged": [
    "src/components/desktop/thoughts/ThoughtsChatPanel.tsx",
    "src/components/desktop/thoughts/useOrchestratorStream.ts",
    "CLAUDE.md"
  ],
  "summary": "Self-review: Agent completion did not include the required self-review block."
}
```

## Packet pkt-5533f97b-49a6-4ab8-aab6-50fa3b660f65 attempt 1

```json
{
  "packetId": "pkt-5533f97b-49a6-4ab8-aab6-50fa3b660f65",
  "attempt": 1,
  "timestamp": "2026-07-03T18:05:49.234Z",
  "typecheckOutput": "Post-completion rule check failed. These are mechanical invariants — every violation is a user-visible bug waiting to ship.\n\nViolations (2) across 2 file(s):\n\n**src/lib/db/index.ts**\n- L1464 [file-ceiling] File grew to 1464 lines (was 1456, max 800). Decompose before shipping — extract hooks, subcomponents, or types first.\n\n**src/lib/lane/registry.ts**\n- L936 [file-ceiling] File grew to 936 lines (was 933, max 800). Decompose before shipping — extract hooks, subcomponents, or types first.\n\nFix each violation, re-verify locally (`npm run rule-check`), then report completion again.\n\nThe platform enforces these rules mechanically because multi-constraint holding is where weaker models drop rules — CLAUDE.md invariants are not optional.",
  "selfReviewSummary": "Agent completion did not include the required self-review block.",
  "filesChanged": [
    "src/lib/db/index.ts",
    "src/lib/lane/registry.ts",
    "CLAUDE.md"
  ],
  "summary": "Self-review: Agent completion did not include the required self-review block."
}
```
