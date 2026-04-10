'use client';

/**
 * OrchestratorTileBus — cross-tile communication for the three orchestrator
 * surfaces (chat, mission control, history).
 *
 * These tiles are independent and splittable — users can arrange them in
 * any order. But they need to talk:
 *
 *   - History tile click → chat tile loads that thread
 *   - Mission tile dispatch → chat tile echoes a system message (deferred
 *     to a follow-up; the imperative append-message API doesn't exist yet)
 *   - Cmd+Shift+O (or any launcher) → open the chat tile if it isn't in
 *     the layout yet, then focus it
 *
 * Rather than dragging callbacks through the tile registry deps on every
 * orchestrator interaction, the chat tile registers its imperative handle
 * on mount. Siblings look up the handle through the context — if present,
 * they invoke it; if absent, they call `ensureChatTile()` first, which
 * opens a chat tile via the tile layout helper, then waits for the new
 * tile to register and replays the pending action.
 *
 * The provider lives at the dashboard page level because that's where
 * `toggleThoughtsTile` (from `useTileLayout`) is available.
 */

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { ThoughtsChatPanelHandle } from './thoughts/ThoughtsChatPanel';

interface OrchestratorTileBus {
  /** Called by OrchestratorChatTile on mount/unmount to publish its handle. */
  registerChatHandle: (handle: ThoughtsChatPanelHandle | null) => void;
  /** Load a past thread into the chat tile. Opens one if not present. */
  loadThreadInChat: (tabId: string) => void;
  /** Ensure a chat tile exists in the layout and focus it. */
  ensureChatTile: () => void;
  /** True when a chat tile is currently mounted and registered. */
  chatTileReady: boolean;
}

const OrchestratorTileBusContext = createContext<OrchestratorTileBus | null>(null);

interface OrchestratorTileBusProviderProps {
  children: ReactNode;
  /**
   * Open the orchestrator chat tile in the layout. Called when a sibling
   * (history, mission) wants to interact with the chat but no chat tile
   * is mounted yet. Should be idempotent — if a chat tile is already
   * present, just focus it.
   */
  ensureChatTile: () => void;
}

export function OrchestratorTileBusProvider({
  children,
  ensureChatTile,
}: OrchestratorTileBusProviderProps) {
  const chatHandleRef = useRef<ThoughtsChatPanelHandle | null>(null);
  const pendingThreadRef = useRef<string | null>(null);
  const [chatTileReady, setChatTileReady] = useState(false);

  const registerChatHandle = useCallback((handle: ThoughtsChatPanelHandle | null) => {
    chatHandleRef.current = handle;
    setChatTileReady(Boolean(handle));

    // If the history tile asked for a thread before the chat was ready,
    // replay that load now. Only applies when a handle just came online.
    if (handle && pendingThreadRef.current) {
      const pending = pendingThreadRef.current;
      pendingThreadRef.current = null;
      // Defer one microtask so the chat tile finishes its own mount effects
      // before we ask it to swap threads.
      Promise.resolve().then(() => {
        handle.loadThread(pending);
        handle.focusInput();
      });
    }
  }, []);

  const loadThreadInChat = useCallback(
    (tabId: string) => {
      const handle = chatHandleRef.current;
      if (handle) {
        handle.loadThread(tabId);
        handle.focusInput();
        return;
      }
      // No chat tile is mounted. Stash the request, open a chat tile,
      // and rely on registerChatHandle to replay the load when the tile
      // mounts and registers itself.
      pendingThreadRef.current = tabId;
      ensureChatTile();
    },
    [ensureChatTile],
  );

  const value = useMemo<OrchestratorTileBus>(
    () => ({
      registerChatHandle,
      loadThreadInChat,
      ensureChatTile,
      chatTileReady,
    }),
    [chatTileReady, ensureChatTile, loadThreadInChat, registerChatHandle],
  );

  return (
    <OrchestratorTileBusContext.Provider value={value}>
      {children}
    </OrchestratorTileBusContext.Provider>
  );
}

export function useOrchestratorTileBus(): OrchestratorTileBus {
  const value = useContext(OrchestratorTileBusContext);
  if (!value) {
    // Soft fallback — siblings outside the provider get a no-op bus so
    // the app doesn't crash. This also lets unit tests mount tiles in
    // isolation without having to set up the provider.
    return {
      registerChatHandle: () => undefined,
      loadThreadInChat: () => undefined,
      ensureChatTile: () => undefined,
      chatTileReady: false,
    };
  }
  return value;
}
