import type { ReactNode } from 'react';
import type { OrchestratorMissionState, OrchestratorPacket, OrchestratorRuntime, OrchestratorWorkspaceTarget } from '@/lib/orchestrator/types';
import type { ChatModelId, OrchestrationMode } from '@/components/desktop/orchestrator/ModePicker';
import type { AgentTarget, FleetAgent } from './types';
import type { ThoughtsChatPermissionMode, ThoughtsChatPanelChromeState } from './chat-panel/types';
import type { ContextualConversation } from './chat-panel/contextual-turn';

export interface ThoughtsChatPanelProps {
  open: boolean;
  draftInjection?: { id: string; text: string } | null;
  /** An isolated contextual chat keeps its draft and attaches context on send. */
  contextualConversation?: ContextualConversation;
  imageInjection?: { id: string; dataUri: string; name: string; mimeType: string } | null;
  onImageInjectionConsumed?: () => void;
  agents: FleetAgent[];
  missionState: OrchestratorMissionState;
  preferredRuntime: OrchestratorRuntime;
  sessionTargets: AgentTarget[];
  workspaceTargets: OrchestratorWorkspaceTarget[];
  repoPath?: string | null;
  /** Identity for the outer Project picker, including isolated panels. */
  scopeTabId?: string;
  /** Workspace tab that owns this composer, when rendered in the main workspace. */
  ownerTabId?: string;
  projectId?: string | null;
  thoughtsBodyBackground: string;
  thoughtsElevatedSurface: string;
  thoughtsElevatedBorder: string;
  thoughtsElevatedShadow: string;
  thoughtsMutedGlass: string;
  permissionMode?: ThoughtsChatPermissionMode;
  collideEnabled?: boolean;
  onSetCollide?: (enabled: boolean) => void;
  composerModeStorageId?: string;
  repoLabel?: string | null;
  emptyStateOverride?: ReactNode;
  // First-message controls in the context row beneath the composer.
  composerBelowSlot?: ReactNode;
  // Rail rendered to the RIGHT of the transcript (not the composer), so the
  // composer spans the full panel width even when the rail is up (Q ruling
  // 2026-07-11). The caller owns the rail's own width/animation wrapper.
  transcriptSideRail?: ReactNode;
  showInlineExport?: boolean;
  footerMeterSlot?: ReactNode;
  composerLeadingExtras?: ReactNode;
  // When set, the chooser surface is hidden and the mode is forced to
  // this value for the lifetime of the panel. Used by Single-runtime
  // tabs (lockedMode='single') and Chat tabs (lockedMode='chat').
  lockedMode?: OrchestrationMode;
  // Initial mode/runtime/chatModel sourced from the parent tab record.
  // Overrides the legacy global per-workspace localStorage load when
  // provided. Combine with onModePersist to round-trip changes.
  initialMode?: OrchestrationMode;
  initialSingleRuntime?: OrchestratorRuntime;
  initialChatModelId?: ChatModelId;
  // Optional pinned OpenRouter model for chat-mode requests (e.g.
  // 'openai/gpt-oss-120b:free'). Empty/undefined = use server chain.
  initialChatOpenrouterModel?: string;
  // Called when the operator picks a different mode/runtime/chatModel
  // in the chooser. Lets the parent persist to the tab record instead
  // of relying on global localStorage. When omitted, falls back to the
  // legacy per-workspace localStorage path.
  onModePersist?: (patch: {
    mode?: OrchestrationMode;
    singleRuntime?: OrchestratorRuntime;
    chatModelId?: ChatModelId;
    chatOpenrouterModel?: string | null;
  }) => void;
  // Spawn handlers forwarded to ModePicker so picking Single/Chat opens
  // a new tab instead of flipping the current tab's mode.
  onSpawnSingleTab?: (runtime: OrchestratorRuntime) => void;
  onSpawnChatTab?: () => void;
  onMissionStateChange: (
    next: OrchestratorMissionState | ((current: OrchestratorMissionState) => OrchestratorMissionState)
  ) => void;
  onFocusPacket?: (packet: OrchestratorPacket) => void;
  onFocusSession?: (sessionKey: string) => void;
  onChromeChange: (state: ThoughtsChatPanelChromeState) => void;
  // Called with the latest user message text in chat mode so the parent
  // can stash it on the tab record and the tab strip can show a 3-word
  // summary instead of the generic "Chat" label.
  onChatSummary?: (text: string) => void;
  // Isolated mounts (drag-to-split thread panes) bind to an explicit thread
  // via the imperative handle. The mount-time auto-restore pass must never
  // run for them — it could adopt an unrelated recently-touched thread in
  // the race window before loadThread lands.
  suppressAutoRestore?: boolean; suppressRuntimePrewarm?: boolean;
  /** True when the host tab is bound to a persisted thread whose history
   *  (incl. its backend) hasn't loaded yet. Until the load lands, the
   *  composer chip shows '…' instead of confidently claiming the DEFAULT
   *  backend — a wrong label on every tab right after boot/reload was the
   *  "they all say o8" report (2026-07-16). */
  expectsThreadLoad?: boolean;
}
