/**
 * Session tile tree — recursive split layout for orchestrator transcripts.
 *
 * This is a self-contained mini-system that mirrors the dashboard tile
 * primitives in `lib/tiles/operations.ts` but stays separate so we don't
 * pollute `TileContent` with orchestrator-only kinds. The dashboard tile
 * layout (TILE_LAYOUT_VERSION 4) is untouched by this module.
 *
 * Each leaf carries either the orchestrator chat or a session transcript.
 * Splits are 'vertical' (children side-by-side, "open in split right") or
 * 'horizontal' (stacked, "open in split below").
 *
 * Persisted per OrchestratorTab id under `o8:orchestrator:session-tiles:tab:<id>`.
 */
export type SessionTileSplitDirection = 'horizontal' | 'vertical';

export type SessionTileLeafKind = 'chat' | 'session' | 'thread';

export interface SessionTileLeaf {
  type: 'leaf';
  id: string;
  kind: SessionTileLeafKind;
  /** Required when kind === 'session'. Identifies the agent transcript. */
  sessionKey?: string;
  /** Required when kind === 'thread'. Chat-history tabId of the thread the
   *  pane hosts — a full independent chat (drag-to-split, #1571 parity). */
  threadId?: string;
  /** Display title for a thread pane header. */
  title?: string;
  /** Chat mode for a thread pane: orchestrator thread vs casual chat. */
  mode?: 'orchestrator' | 'chat';
  /** Origin repo of the dragged thread. The Chats rail lists history across
   *  repos, so a pane must run against ITS thread's repo — not the host
   *  tab's — or sends/dispatch from the pane mis-scope silently. */
  repoPath?: string;
}

export interface SessionTileSplit {
  type: 'split';
  id: string;
  direction: SessionTileSplitDirection;
  ratio: number;
  children: [SessionTileNode, SessionTileNode];
}

export type SessionTileNode = SessionTileLeaf | SessionTileSplit;

export interface SessionTileLayout {
  version: number;
  root: SessionTileNode;
}

export const SESSION_TILE_LAYOUT_VERSION = 1;
const MIN_RATIO = 0.2;
const MAX_RATIO = 0.8;

function makeId(prefix: 'leaf' | 'split'): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function clampRatio(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.min(MAX_RATIO, Math.max(MIN_RATIO, value));
}

export function isSessionTileLeaf(node: SessionTileNode): node is SessionTileLeaf {
  return node.type === 'leaf';
}

export function isSessionTileSplit(node: SessionTileNode): node is SessionTileSplit {
  return node.type === 'split';
}

export function createDefaultSessionTileLayout(): SessionTileLayout {
  return {
    version: SESSION_TILE_LAYOUT_VERSION,
    root: { type: 'leaf', id: 'chat-root', kind: 'chat' },
  };
}

export function findSessionLeafByKey(
  node: SessionTileNode,
  sessionKey: string,
): SessionTileLeaf | null {
  if (isSessionTileLeaf(node)) {
    return node.kind === 'session' && node.sessionKey === sessionKey ? node : null;
  }
  return findSessionLeafByKey(node.children[0], sessionKey)
    ?? findSessionLeafByKey(node.children[1], sessionKey);
}

export function collectSessionLeaves(node: SessionTileNode): SessionTileLeaf[] {
  if (isSessionTileLeaf(node)) {
    return node.kind === 'session' ? [node] : [];
  }
  return [
    ...collectSessionLeaves(node.children[0]),
    ...collectSessionLeaves(node.children[1]),
  ];
}

export function collectSessionKeys(node: SessionTileNode): string[] {
  return collectSessionLeaves(node)
    .map((leaf) => leaf.sessionKey)
    .filter((key): key is string => Boolean(key));
}

export function findChatLeaf(node: SessionTileNode): SessionTileLeaf | null {
  if (isSessionTileLeaf(node)) {
    return node.kind === 'chat' ? node : null;
  }
  return findChatLeaf(node.children[0]) ?? findChatLeaf(node.children[1]);
}

/**
 * Add a session pane by splitting the chat leaf. If the chat is already
 * split or the session is already in the tree, no-op.
 */
export function splitChatWithSession(
  layout: SessionTileLayout,
  sessionKey: string,
  direction: SessionTileSplitDirection,
  ratio = 0.5,
): SessionTileLayout {
  if (findSessionLeafByKey(layout.root, sessionKey)) {
    return layout;
  }
  const chatLeaf = findChatLeaf(layout.root);
  if (!chatLeaf) {
    // Shouldn't happen — chat is always present — but guard anyway.
    return layout;
  }

  function walk(node: SessionTileNode): SessionTileNode {
    if (isSessionTileLeaf(node)) {
      if (node.id !== chatLeaf!.id) return node;
      const sessionLeaf: SessionTileLeaf = {
        type: 'leaf',
        id: makeId('leaf'),
        kind: 'session',
        sessionKey,
      };
      return {
        type: 'split',
        id: makeId('split'),
        direction,
        ratio: clampRatio(ratio),
        // For "split right" (vertical) and "split below" (horizontal) the
        // chat stays in the first slot (left/top), session goes second.
        children: [node, sessionLeaf],
      };
    }
    const next0 = walk(node.children[0]);
    const next1 = walk(node.children[1]);
    if (next0 === node.children[0] && next1 === node.children[1]) return node;
    return { ...node, children: [next0, next1] };
  }

  return { ...layout, root: walk(layout.root) };
}

/**
 * Add a second session pane by splitting an existing session leaf — used
 * when the user right-clicks a pill while the chat is already split out.
 */
export function splitSessionWithSession(
  layout: SessionTileLayout,
  targetLeafId: string,
  newSessionKey: string,
  direction: SessionTileSplitDirection,
  ratio = 0.5,
): SessionTileLayout {
  if (findSessionLeafByKey(layout.root, newSessionKey)) {
    return layout;
  }

  function walk(node: SessionTileNode): SessionTileNode {
    if (isSessionTileLeaf(node)) {
      if (node.id !== targetLeafId) return node;
      const newLeaf: SessionTileLeaf = {
        type: 'leaf',
        id: makeId('leaf'),
        kind: 'session',
        sessionKey: newSessionKey,
      };
      return {
        type: 'split',
        id: makeId('split'),
        direction,
        ratio: clampRatio(ratio),
        children: [node, newLeaf],
      };
    }
    const next0 = walk(node.children[0]);
    const next1 = walk(node.children[1]);
    if (next0 === node.children[0] && next1 === node.children[1]) return node;
    return { ...node, children: [next0, next1] };
  }

  return { ...layout, root: walk(layout.root) };
}

export function findThreadLeafByThreadId(
  node: SessionTileNode,
  threadId: string,
): SessionTileLeaf | null {
  if (isSessionTileLeaf(node)) {
    return node.kind === 'thread' && node.threadId === threadId ? node : null;
  }
  return findThreadLeafByThreadId(node.children[0], threadId)
    ?? findThreadLeafByThreadId(node.children[1], threadId);
}

export function collectThreadLeaves(node: SessionTileNode): SessionTileLeaf[] {
  if (isSessionTileLeaf(node)) {
    return node.kind === 'thread' ? [node] : [];
  }
  return [
    ...collectThreadLeaves(node.children[0]),
    ...collectThreadLeaves(node.children[1]),
  ];
}

export interface ThreadPanePayload {
  threadId: string;
  title: string;
  mode: 'orchestrator' | 'chat';
  /** Origin repo of the thread (null/undefined = unknown; pane falls back
   *  to the host tab's repo). */
  repoPath?: string | null;
}

/**
 * Split ANY leaf with a new thread pane (drag-to-split). The target leaf
 * keeps the first slot (left/top); the thread pane lands second. No-op if
 * the thread is already open in the tree.
 */
export function splitLeafWithThread(
  layout: SessionTileLayout,
  targetLeafId: string,
  thread: ThreadPanePayload,
  direction: SessionTileSplitDirection,
  ratio = 0.5,
): SessionTileLayout {
  if (findThreadLeafByThreadId(layout.root, thread.threadId)) {
    return layout;
  }

  function walk(node: SessionTileNode): SessionTileNode {
    if (isSessionTileLeaf(node)) {
      if (node.id !== targetLeafId) return node;
      const threadLeaf: SessionTileLeaf = {
        type: 'leaf',
        id: makeId('leaf'),
        kind: 'thread',
        threadId: thread.threadId,
        title: thread.title,
        mode: thread.mode,
        ...(thread.repoPath ? { repoPath: thread.repoPath } : {}),
      };
      return {
        type: 'split',
        id: makeId('split'),
        direction,
        ratio: clampRatio(ratio),
        children: [node, threadLeaf],
      };
    }
    const next0 = walk(node.children[0]);
    const next1 = walk(node.children[1]);
    if (next0 === node.children[0] && next1 === node.children[1]) return node;
    return { ...node, children: [next0, next1] };
  }

  return { ...layout, root: walk(layout.root) };
}

/**
 * Replace a leaf's content with a thread pane (drop on a pane header —
 * "Open here"). Replacing the chat leaf is NOT handled here: callers route
 * that to the main chat's loadThread instead so the orchestrator chat pane
 * never leaves the tree. A fresh leaf id is minted so React fully remounts
 * the pane (a thread pane's chat state must never bleed across threads).
 */
export function replaceLeafWithThread(
  layout: SessionTileLayout,
  targetLeafId: string,
  thread: ThreadPanePayload,
): SessionTileLayout {
  if (findThreadLeafByThreadId(layout.root, thread.threadId)) {
    return layout;
  }

  function walk(node: SessionTileNode): SessionTileNode {
    if (isSessionTileLeaf(node)) {
      if (node.id !== targetLeafId || node.kind === 'chat') return node;
      return {
        type: 'leaf',
        id: makeId('leaf'),
        kind: 'thread',
        threadId: thread.threadId,
        title: thread.title,
        mode: thread.mode,
        ...(thread.repoPath ? { repoPath: thread.repoPath } : {}),
      };
    }
    const next0 = walk(node.children[0]);
    const next1 = walk(node.children[1]);
    if (next0 === node.children[0] && next1 === node.children[1]) return node;
    return { ...node, children: [next0, next1] };
  }

  return { ...layout, root: walk(layout.root) };
}

/** Remove the leaf identified by leafId. Closing the chat leaf is a no-op. */
export function closeSessionLeaf(
  layout: SessionTileLayout,
  leafId: string,
): SessionTileLayout {
  function walk(node: SessionTileNode): { next: SessionTileNode; closed: boolean } {
    if (isSessionTileLeaf(node)) {
      return { next: node, closed: false };
    }
    const [first, second] = node.children;
    if (isSessionTileLeaf(first) && first.id === leafId && first.kind !== 'chat') {
      return { next: second, closed: true };
    }
    if (isSessionTileLeaf(second) && second.id === leafId && second.kind !== 'chat') {
      return { next: first, closed: true };
    }
    const left = walk(first);
    if (left.closed) {
      return {
        next: { ...node, children: [left.next, second] },
        closed: true,
      };
    }
    const right = walk(second);
    if (right.closed) {
      return {
        next: { ...node, children: [first, right.next] },
        closed: true,
      };
    }
    return { next: node, closed: false };
  }

  const result = walk(layout.root);
  return result.closed ? { ...layout, root: result.next } : layout;
}

/**
 * Drop every session leaf whose sessionKey is no longer in the active
 * agents set. The chat leaf is preserved. If the tree collapses to a
 * single chat leaf, returns the default layout.
 */
export function pruneStaleSessions(
  layout: SessionTileLayout,
  liveSessionKeys: Set<string>,
): SessionTileLayout {
  const stale = collectSessionLeaves(layout.root)
    .filter((leaf) => !leaf.sessionKey || !liveSessionKeys.has(leaf.sessionKey));
  if (stale.length === 0) return layout;

  let next = layout;
  for (const leaf of stale) {
    next = closeSessionLeaf(next, leaf.id);
  }
  return next;
}

export function resizeSessionSplit(
  layout: SessionTileLayout,
  splitId: string,
  ratio: number,
): SessionTileLayout {
  function walk(node: SessionTileNode): SessionTileNode {
    if (isSessionTileLeaf(node)) return node;
    if (node.id === splitId) {
      return { ...node, ratio: clampRatio(ratio) };
    }
    const next0 = walk(node.children[0]);
    const next1 = walk(node.children[1]);
    if (next0 === node.children[0] && next1 === node.children[1]) return node;
    return { ...node, children: [next0, next1] };
  }
  return { ...layout, root: walk(layout.root) };
}

export function clearSessionTiles(layout: SessionTileLayout): SessionTileLayout {
  if (isSessionTileLeaf(layout.root) && layout.root.kind === 'chat') {
    return layout;
  }
  return createDefaultSessionTileLayout();
}

export function hasAnySessionLeaf(layout: SessionTileLayout): boolean {
  return collectSessionLeaves(layout.root).length > 0;
}

/** True when the tree holds anything beyond the bare chat leaf — session
 *  transcripts OR thread panes. Drives surface mount + persistence. */
export function hasAnyAuxLeaf(layout: SessionTileLayout): boolean {
  return collectSessionLeaves(layout.root).length > 0
    || collectThreadLeaves(layout.root).length > 0;
}

const MAX_VISIBLE_SESSIONS = 8;

/**
 * Add a session to the layout following the outside-worker claim rules:
 * - First session splits the chat leaf vertically.
 * - Later sessions split the existing session leaf with the largest computed
 *   area (stable reading-order tie-break: first leaf wins ties).
 * - Direction follows the selected leaf: vertical when it is at least as wide
 *   as it is tall, horizontal otherwise.
 * - Duplicate session keys and requests that would exceed MAX_VISIBLE_SESSIONS
 *   are no-ops.
 * - Preserves existing split ratios.
 *
 * viewport defaults to { width: 1, height: 1 } so callers without a DOM rect
 * (e.g. the outside-worker claim loop) get sensible default area weights.
 */
export function addSessionToLayout(
  layout: SessionTileLayout,
  sessionKey: string,
  viewport: SessionTileRect = { left: 0, top: 0, width: 1, height: 1 },
): SessionTileLayout {
  if (findSessionLeafByKey(layout.root, sessionKey)) return layout;
  const existingLeaves = collectSessionLeaves(layout.root);
  if (existingLeaves.length >= MAX_VISIBLE_SESSIONS) return layout;

  if (existingLeaves.length === 0) {
    return splitChatWithSession(layout, sessionKey, 'vertical');
  }

  const { leafRects } = computeSessionTileLayout(layout.root, viewport);

  let bestLeaf: SessionTileLeaf | null = null;
  let bestRect: SessionTileRect | null = null;
  let bestArea = -1;
  for (const leaf of existingLeaves) {
    const rect = leafRects.get(leaf.id);
    if (!rect) continue;
    const area = rect.width * rect.height;
    if (area > bestArea) {
      bestArea = area;
      bestLeaf = leaf;
      bestRect = rect;
    }
  }

  const targetLeaf = bestLeaf ?? existingLeaves[0]!;
  const direction: SessionTileSplitDirection = bestRect && bestRect.width < bestRect.height
    ? 'horizontal'
    : 'vertical';
  return splitSessionWithSession(layout, targetLeaf.id, sessionKey, direction);
}

// --- Persistence ---

function isPlainSessionLeaf(value: unknown): value is SessionTileLeaf {
  if (!value || typeof value !== 'object') return false;
  const v = value as {
    type?: unknown;
    id?: unknown;
    kind?: unknown;
    sessionKey?: unknown;
    threadId?: unknown;
    mode?: unknown;
    repoPath?: unknown;
  };
  if (v.type !== 'leaf' || typeof v.id !== 'string') return false;
  if (v.kind !== 'chat' && v.kind !== 'session' && v.kind !== 'thread') return false;
  if (v.kind === 'session' && typeof v.sessionKey !== 'string') return false;
  if (v.kind === 'thread') {
    if (typeof v.threadId !== 'string') return false;
    if (v.mode !== 'orchestrator' && v.mode !== 'chat') return false;
    if (v.repoPath !== undefined && typeof v.repoPath !== 'string') return false;
  }
  return true;
}

function isPlainSessionNode(value: unknown): value is SessionTileNode {
  if (!value || typeof value !== 'object') return false;
  const v = value as {
    type?: unknown;
    id?: unknown;
    direction?: unknown;
    ratio?: unknown;
    children?: unknown;
  };
  if (v.type === 'leaf') return isPlainSessionLeaf(value);
  if (v.type !== 'split') return false;
  return typeof v.id === 'string'
    && (v.direction === 'horizontal' || v.direction === 'vertical')
    && typeof v.ratio === 'number'
    && Array.isArray(v.children)
    && v.children.length === 2
    && isPlainSessionNode(v.children[0])
    && isPlainSessionNode(v.children[1]);
}

export function serializeSessionTileLayout(layout: SessionTileLayout): string {
  return JSON.stringify({
    version: SESSION_TILE_LAYOUT_VERSION,
    root: layout.root,
  });
}

/**
 * Migrate a parsed layout from a prior version to the current one.
 *
 * Add a `case` for every old version that can be salvaged. Return `null`
 * when the version is too old or unknown to migrate safely — the caller
 * will fall back to the default layout instead of silently resetting state.
 *
 * Currently a no-op because SESSION_TILE_LAYOUT_VERSION === 1 has no
 * prior versions. The scaffold ensures future bumps don't silently destroy
 * user data (issue #818 audit finding #3).
 */
function migrateSessionTileLayout(
  parsed: { version?: unknown; root?: unknown },
): SessionTileLayout | null {
  switch (parsed.version) {
    // v1 is current — caller should never reach here for current version,
    // but handle it safely as a no-op fallback.
    case 1: {
      if (!isPlainSessionNode(parsed.root)) return null;
      return { version: SESSION_TILE_LAYOUT_VERSION, root: parsed.root };
    }
    // Add future cases here:
    // case 2: { /* migrate v2 → v3 */ }
    default:
      return null;
  }
}

export function deserializeSessionTileLayout(
  raw: string | null | undefined,
): SessionTileLayout | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { version?: unknown; root?: unknown };
    if (parsed.version === SESSION_TILE_LAYOUT_VERSION) {
      // Fast path: current version, validate shape directly.
      if (!isPlainSessionNode(parsed.root)) return null;
      return { version: SESSION_TILE_LAYOUT_VERSION, root: parsed.root };
    }
    // Older version — attempt migration rather than silently returning null.
    return migrateSessionTileLayout(parsed);
  } catch {
    return null;
  }
}

// --- Layout computation (mirrors lib/tiles/operations.ts) ---

export interface SessionTileRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface SessionTileSplitFrame {
  id: string;
  direction: SessionTileSplitDirection;
  container: SessionTileRect;
  boundary: SessionTileRect;
}

export function computeSessionTileLayout(
  root: SessionTileNode,
  viewport: SessionTileRect = { left: 0, top: 0, width: 1, height: 1 },
): {
  leafRects: Map<string, SessionTileRect>;
  splitFrames: SessionTileSplitFrame[];
} {
  const leafRects = new Map<string, SessionTileRect>();
  const splitFrames: SessionTileSplitFrame[] = [];

  function walk(node: SessionTileNode, rect: SessionTileRect): void {
    if (isSessionTileLeaf(node)) {
      leafRects.set(node.id, rect);
      return;
    }
    if (node.direction === 'vertical') {
      const leftWidth = rect.width * node.ratio;
      const first: SessionTileRect = { ...rect, width: leftWidth };
      const second: SessionTileRect = {
        ...rect,
        left: rect.left + leftWidth,
        width: rect.width - leftWidth,
      };
      splitFrames.push({
        id: node.id,
        direction: node.direction,
        container: rect,
        boundary: { left: rect.left + leftWidth, top: rect.top, width: 0, height: rect.height },
      });
      walk(node.children[0], first);
      walk(node.children[1], second);
      return;
    }
    const topHeight = rect.height * node.ratio;
    const first: SessionTileRect = { ...rect, height: topHeight };
    const second: SessionTileRect = {
      ...rect,
      top: rect.top + topHeight,
      height: rect.height - topHeight,
    };
    splitFrames.push({
      id: node.id,
      direction: node.direction,
      container: rect,
      boundary: { left: rect.left, top: rect.top + topHeight, width: rect.width, height: 0 },
    });
    walk(node.children[0], first);
    walk(node.children[1], second);
  }

  walk(root, viewport);
  return { leafRects, splitFrames };
}

export function collectAllLeaves(node: SessionTileNode): SessionTileLeaf[] {
  if (isSessionTileLeaf(node)) return [node];
  return [
    ...collectAllLeaves(node.children[0]),
    ...collectAllLeaves(node.children[1]),
  ];
}
