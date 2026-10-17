import { closeSessionLeaf, collectAllLeaves, findThreadLeafByThreadId, replaceLeafWithThread, splitLeafWithThread,
  type SessionTileLayout, type SessionTileNode, type SessionTileSplitDirection, type ThreadPanePayload } from './session-tiles';

/** Reuse existing leaf identities so moving a chat never remounts its composer. */
export function placeThreadPane(layout: SessionTileLayout, targetId: string, thread: ThreadPanePayload,
  placement: SessionTileSplitDirection | 'replace'): SessionTileLayout {
  const source = findThreadLeafByThreadId(layout.root, thread.threadId);
  if (!source) return placement === 'replace' ? replaceLeafWithThread(layout, targetId, thread)
    : splitLeafWithThread(layout, targetId, thread, placement);
  const target = collectAllLeaves(layout.root).find(leaf => leaf.id === targetId);
  if (!target || source.id === targetId) return layout;
  if (placement === 'replace') {
    const swap = (node: SessionTileNode): SessionTileNode => {
      if (node.type === 'leaf') return node.id === source.id ? target : node.id === targetId ? source : node;
      return { ...node, autoGrid: false, manualOverride: true, children: [swap(node.children[0]), swap(node.children[1])] };
    };
    return { ...layout, root: swap(layout.root) };
  }
  const trimmed = closeSessionLeaf(layout, source.id);
  const insert = (node: SessionTileNode): SessionTileNode => {
    if (node.type === 'leaf') return node.id === targetId ? { type: 'split',
      id: `split-${typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${source.id}`}`,
      direction: placement, ratio: 0.5, manualOverride: true, children: [node, source] } : node;
    return { ...node, autoGrid: false, manualOverride: true, children: [insert(node.children[0]), insert(node.children[1])] };
  };
  return { ...trimmed, root: insert(trimmed.root) };
}
