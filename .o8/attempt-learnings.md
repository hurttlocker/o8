# Attempt Learnings

Latest bounded learnings captured from failed retry attempts.

## Packet pkt-814c9cd5-8cb3-48fa-a193-3c5a7f69cf3c attempt 1

```json
{
  "packetId": "pkt-814c9cd5-8cb3-48fa-a193-3c5a7f69cf3c",
  "attempt": 1,
  "timestamp": "2026-04-18T01:00:43.557Z",
  "typecheckOutput": "Post-completion rule check failed. These are mechanical invariants — every violation is a user-visible bug waiting to ship.\n\nViolations (9) across 2 file(s):\n\n**src/components/desktop/thoughts/mission-panel/PacketReviewPanel.tsx**\n- L157 [css-shorthand] Use longhand paddingTop / paddingLeft instead of padding: '10px 11px'. React 19 warns on mixed shorthand/longhand.\n- L174 [css-shorthand] Use longhand paddingTop / paddingLeft instead of padding: '3px 8px'. React 19 warns on mixed shorthand/longhand.\n- L199 [css-shorthand] Use longhand paddingTop / paddingLeft instead of padding: '7px 8px'. React 19 warns on mixed shorthand/longhand.\n- L202 [rgba-white] Use var(--t-panel) / var(--t-bg-card) / var(--t-input-bg) instead of hardcoded rgba white values. Midnight theme turns these into gray blobs — see commit 929ffdf.\n- L229 [css-shorthand] Use longhand paddingTop / paddingLeft instead of padding: '6px 10px'. React 19 warns on mixed shorthand/longhand.\n- L247 [css-shorthand] Use longhand paddingTop / paddingLeft instead of padding: '6px 10px'. React 19 warns on mixed shorthand/longhand.\n- L268 [css-shorthand] Use longhand paddingTop / paddingLeft instead of padding: '7px 9px'. React 19 warns on mixed shorthand/longhand.\n- L274 [css-shorthand] Use longhand paddingTop / paddingLeft instead of padding: '7px 9px'. React 19 warns on mixed shorthand/longhand.\n\n**src/lib/orchestrator/operator-mission-service.ts**\n- L986 [file-ceiling] File grew to 986 lines (was 939, max 800). Decompose before shipping — extract hooks, subcomponents, or types first.\n\nFix each violation, re-verify locally (`npm run rule-check`), then report completion again.\n\nThe platform enforces these rules mechanically because multi-constraint holding is where weaker models drop rules — CLAUDE.md invariants are not optional.",
  "selfReviewSummary": "Agent completion did not include the required self-review block.",
  "filesChanged": [
    "src/components/desktop/thoughts/mission-panel/PacketReviewPanel.ts",
    "src/lib/orchestrator/operator-mission-service.ts",
    "CLAUDE.md"
  ],
  "summary": "Self-review: Agent completion did not include the required self-review block."
}
```

## Packet pkt-f5a3163d-f91b-413b-b86c-94cb2fd73123 attempt 1

```json
{
  "packetId": "pkt-f5a3163d-f91b-413b-b86c-94cb2fd73123",
  "attempt": 1,
  "timestamp": "2026-05-12T22:08:15.663Z",
  "typecheckOutput": "Post-completion rule check failed. These are mechanical invariants — every violation is a user-visible bug waiting to ship.\n\nViolations (2) across 2 file(s):\n\n**src/lib/lane/registry.ts**\n- L809 [file-ceiling] File grew to 809 lines (was 808, max 800). Decompose before shipping — extract hooks, subcomponents, or types first.\n\n**src/lib/orchestrator/store.ts**\n- L892 [file-ceiling] File grew to 892 lines (was 880, max 800). Decompose before shipping — extract hooks, subcomponents, or types first.\n\nFix each violation, re-verify locally (`npm run rule-check`), then report completion again.\n\nThe platform enforces these rules mechanically because multi-constraint holding is where weaker models drop rules — CLAUDE.md invariants are not optional.",
  "selfReviewSummary": "Agent completion did not include the required self-review block.",
  "filesChanged": [
    "src/lib/lane/registry.ts",
    "src/lib/orchestrator/store.ts",
    "CLAUDE.md"
  ],
  "summary": "Self-review: Agent completion did not include the required self-review block."
}
```

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
