import type {
  ArchitectureDeltaEdge,
  ArchitectureDeltaNode,
  ArchitectureEdgeState,
  ArchitectureModuleState,
} from '@/lib/review/architecture-delta-types';
export { filterArchitectureResult } from '@/lib/review/architecture-scope';

export type ArchitectureGraphState = ArchitectureModuleState | 'mixed';

export interface ArchitectureGraphNode {
  id: string;
  label: string;
  detail: string;
  directory: boolean;
  state: ArchitectureGraphState;
  sourceNodes: ArchitectureDeltaNode[];
  x: number;
  y: number;
  cyclic: boolean;
}

export interface ArchitectureGraphEdge {
  id: string;
  from: string;
  to: string;
  state: ArchitectureEdgeState | 'mixed';
  sourceEdges: ArchitectureDeltaEdge[];
}

export interface ArchitectureGraphModel {
  nodes: ArchitectureGraphNode[];
  edges: ArchitectureGraphEdge[];
  width: number;
  height: number;
  prefix: string[];
}

const STATE_RANK: Record<ArchitectureGraphState, number> = {
  removed: 0,
  added: 1,
  changed: 2,
  mixed: 3,
  context: 4,
};

function nodeState(nodes: ArchitectureDeltaNode[]): ArchitectureGraphState {
  const states = new Set(nodes.map((node) => node.state));
  if (states.size === 1) return nodes[0]?.state ?? 'context';
  const nonContext = [...states].filter((state) => state !== 'context');
  return nonContext.length === 1 ? nonContext[0] : 'mixed';
}

function edgeState(edges: ArchitectureDeltaEdge[]): ArchitectureEdgeState | 'mixed' {
  const states = new Set(edges.map((edge) => edge.state));
  return states.size === 1 ? edges[0]?.state ?? 'context' : 'mixed';
}

function isUnderPrefix(filePath: string, prefix: string[]) {
  const parts = filePath.split('/');
  return prefix.every((part, index) => parts[index] === part);
}

function visibleId(filePath: string, prefix: string[]) {
  if (!isUnderPrefix(filePath, prefix)) return null;
  const parts = filePath.split('/');
  const nextIndex = prefix.length;
  if (parts.length - nextIndex > 1) return [...prefix, parts[nextIndex]].join('/');
  return filePath;
}

export function initialArchitecturePrefix(nodes: ArchitectureDeltaNode[]) {
  if (nodes.length === 0) return [];
  const first = nodes[0].path.split('/')[0];
  if (!first || nodes.some((node) => node.path.split('/')[0] !== first)) return [];
  return nodes.some((node) => node.path.split('/').length > 1) ? [first] : [];
}

function findCyclicNodeIds(nodeIds: string[], edges: ArchitectureGraphEdge[]) {
  const adjacency = new Map(nodeIds.map((id) => [id, [] as string[]]));
  for (const edge of edges) adjacency.get(edge.from)?.push(edge.to);
  let index = 0;
  const stack: string[] = [];
  const onStack = new Set<string>();
  const indices = new Map<string, number>();
  const lowLinks = new Map<string, number>();
  const cyclic = new Set<string>();

  const visit = (id: string) => {
    indices.set(id, index);
    lowLinks.set(id, index);
    index += 1;
    stack.push(id);
    onStack.add(id);
    for (const target of adjacency.get(id) ?? []) {
      if (!indices.has(target)) {
        visit(target);
        lowLinks.set(id, Math.min(lowLinks.get(id) ?? 0, lowLinks.get(target) ?? 0));
      } else if (onStack.has(target)) {
        lowLinks.set(id, Math.min(lowLinks.get(id) ?? 0, indices.get(target) ?? 0));
      }
    }
    if (lowLinks.get(id) !== indices.get(id)) return;
    const component: string[] = [];
    let member: string | undefined;
    do {
      member = stack.pop();
      if (!member) break;
      onStack.delete(member);
      component.push(member);
    } while (member !== id);
    if (component.length > 1 || edges.some((edge) => edge.from === id && edge.to === id)) {
      component.forEach((item) => cyclic.add(item));
    }
  };
  nodeIds.forEach((id) => { if (!indices.has(id)) visit(id); });
  return cyclic;
}

export function buildArchitectureGraph(
  nodes: ArchitectureDeltaNode[],
  rawEdges: ArchitectureDeltaEdge[],
  prefix: string[],
): ArchitectureGraphModel {
  const buckets = new Map<string, ArchitectureDeltaNode[]>();
  for (const node of nodes) {
    const id = visibleId(node.path, prefix);
    if (!id) continue;
    const bucket = buckets.get(id) ?? [];
    bucket.push(node);
    buckets.set(id, bucket);
  }
  const aggregatedEdges = new Map<string, ArchitectureDeltaEdge[]>();
  for (const edge of rawEdges) {
    const from = visibleId(edge.from, prefix);
    const to = visibleId(edge.to, prefix);
    if (!from || !to || from === to || !buckets.has(from) || !buckets.has(to)) continue;
    const key = `${from}\0${to}`;
    const bucket = aggregatedEdges.get(key) ?? [];
    bucket.push(edge);
    aggregatedEdges.set(key, bucket);
  }
  const edges: ArchitectureGraphEdge[] = [...aggregatedEdges.entries()].map(([key, sourceEdges]) => {
    const separator = key.indexOf('\0');
    return {
      id: key,
      from: key.slice(0, separator),
      to: key.slice(separator + 1),
      state: edgeState(sourceEdges),
      sourceEdges,
    };
  });
  const ids = [...buckets.keys()];
  const liveEdges = edges.filter((edge) => edge.state !== 'removed');
  const cyclic = findCyclicNodeIds(ids, liveEdges);
  const incoming = new Map(ids.map((id) => [id, 0]));
  const outgoing = new Map(ids.map((id) => [id, [] as string[]]));
  for (const edge of liveEdges) {
    incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
    outgoing.get(edge.from)?.push(edge.to);
  }
  const ranks = new Map(ids.map((id) => [id, 0]));
  const queue = ids.filter((id) => (incoming.get(id) ?? 0) === 0);
  const visited = new Set<string>();
  while (queue.length) {
    const id = queue.shift();
    if (!id) break;
    visited.add(id);
    for (const target of outgoing.get(id) ?? []) {
      ranks.set(target, Math.max(ranks.get(target) ?? 0, (ranks.get(id) ?? 0) + 1));
      incoming.set(target, (incoming.get(target) ?? 1) - 1);
      if (incoming.get(target) === 0) queue.push(target);
    }
  }
  const maxAcyclicRank = Math.max(0, ...[...ranks.values()]);
  for (const id of ids) {
    if (!visited.has(id) && cyclic.has(id)) ranks.set(id, Math.min(maxAcyclicRank + 1, 3));
  }
  const maxRank = Math.min(3, Math.max(0, ...[...ranks.values()]));
  const columns = new Map<number, string[]>();
  for (const id of ids) {
    const rank = Math.min(3, ranks.get(id) ?? 0);
    const column = columns.get(rank) ?? [];
    column.push(id);
    columns.set(rank, column);
  }
  for (const column of columns.values()) {
    column.sort((left, right) => {
      const leftState = nodeState(buckets.get(left) ?? []);
      const rightState = nodeState(buckets.get(right) ?? []);
      return STATE_RANK[leftState] - STATE_RANK[rightState] || left.localeCompare(right);
    });
  }
  const nodeWidth = 178;
  const nodeHeight = 64;
  const columnGap = 66;
  const rowGap = 26;
  const margin = 34;
  const width = Math.max(420, margin * 2 + (maxRank + 1) * nodeWidth + maxRank * columnGap);
  const maxRows = Math.max(1, ...[...columns.values()].map((column) => column.length));
  const height = Math.max(230, margin * 2 + maxRows * nodeHeight + (maxRows - 1) * rowGap);
  const graphNodes: ArchitectureGraphNode[] = [];
  for (const [rank, column] of columns) {
    const columnHeight = column.length * nodeHeight + Math.max(0, column.length - 1) * rowGap;
    const startY = (height - columnHeight) / 2;
    column.forEach((id, row) => {
      const sourceNodes = buckets.get(id) ?? [];
      const parts = id.split('/');
      const directory = sourceNodes.some((node) => node.path !== id);
      graphNodes.push({
        id,
        label: parts.at(-1) ?? id,
        detail: directory ? `${sourceNodes.length} modules` : parts.slice(0, -1).join('/') || '.',
        directory,
        state: nodeState(sourceNodes),
        sourceNodes,
        x: margin + rank * (nodeWidth + columnGap),
        y: startY + row * (nodeHeight + rowGap),
        cyclic: cyclic.has(id),
      });
    });
  }
  return { nodes: graphNodes, edges, width, height, prefix };
}
