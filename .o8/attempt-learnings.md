# Attempt Learnings

Latest bounded learnings captured from failed retry attempts.

## Packet pkt-d397bec5-1b26-44a1-9875-77eda372828d attempt 1

```json
{
  "packetId": "pkt-d397bec5-1b26-44a1-9875-77eda372828d",
  "attempt": 1,
  "timestamp": "2026-05-23T00:01:00.821Z",
  "typecheckOutput": "Command failed: npx tsc --noEmit\n\nsrc/components/desktop/thoughts/ThoughtsChatPanel.tsx(1049,5): error TS2339: Property 'isDismissedForLastAssistant' does not exist on type '{ lastAssistantId: string | null; chipsForLastAssistant: string[]; isPlaceholderVisibleForLastAssistant: boolean; dismissChips: () => void; }'.\nsrc/components/desktop/thoughts/ThoughtsChatPanel.tsx(1052,5): error TS2339: Property 'restoreChips' does not exist on type '{ lastAssistantId: string | null; chipsForLastAssistant: string[]; isPlaceholderVisibleForLastAssistant: boolean; dismissChips: () => void; }'.\nsrc/components/desktop/thoughts/ThoughtsChatPanel.tsx(1695,11): error TS2322: Type '{ ref: RefObject<HTMLDivElement | null>; displayMessages: MobileTranscriptEntry[]; displayWaiting: boolean; repoPath: string | null; ... 16 more ...; onRestoreSuggestions: any; }' is not assignable to type 'IntrinsicAttributes & ChatMessageListProps & RefAttributes<HTMLDivElement>'.\n  Property 'suggestedRepliesCollapsed' does not exist on type 'IntrinsicAttributes & ChatMessageListProps & RefAttributes<HTMLDivElement>'. Did you mean 'suggestedRepliesPending'?\nsrc/components/desktop/workspace-terminal/OrchestratorTab.tsx(783,32): error TS2322: Type '{ visible: boolean; }' is not assignable to type 'IntrinsicAttributes'.\n  Property 'visible' does not exist on type 'IntrinsicAttributes'.",
  "selfReviewSummary": "Agent completion did not include the required self-review block.",
  "filesChanged": [
    "src/components/desktop/thoughts/ThoughtsChatPanel.ts",
    "src/components/desktop/workspace-terminal/OrchestratorTab.ts"
  ],
  "summary": "Self-review: Agent completion did not include the required self-review block. | Key errors: src/components/desktop/thoughts/ThoughtsChatPanel.tsx(1049,5): error TS2339: Property 'isDismissedForLastAssistant' does not exist on type '{ lastAssistantId: string | null; chipsForLastAssistant: string[]; isPlaceholderVisibleForLastAssis… | src/components/desktop/thoughts/ThoughtsChatPanel.tsx(1052,5): error TS2339: Property 'restoreChips' does not exist on type '{ lastAssistantId: string | null; chips…"
}
```

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
