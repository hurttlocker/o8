import type { ArchitectureDeltaResult } from './architecture-delta-types';

export function filterArchitectureResult(
  result: ArchitectureDeltaResult,
  scopePaths: readonly string[],
): ArchitectureDeltaResult {
  if (result.status !== 'ready' || scopePaths.length === 0) return result;
  const scope = new Set(scopePaths);
  const changedInScope = new Set(result.nodes.filter((node) => (
    node.state !== 'context' && (scope.has(node.path) || (node.focusPath ? scope.has(node.focusPath) : false))
  )).map((node) => node.path));
  const edges = result.edges.filter((edge) => (
    (edge.focusPath ? scope.has(edge.focusPath) : false)
    || changedInScope.has(edge.from)
    || changedInScope.has(edge.to)
  ));
  const included = new Set(changedInScope);
  for (const edge of edges) {
    included.add(edge.from);
    included.add(edge.to);
  }
  const nodes = result.nodes.filter((node) => included.has(node.path)).map((node) => (
    changedInScope.has(node.path) ? node : { ...node, state: 'context' as const, focusPath: null }
  ));
  const nodeByPath = new Map(result.nodes.map((node) => [node.path, node]));
  const scopedEdges = edges.map((edge) => {
    if (edge.focusPath && scope.has(edge.focusPath)) return edge;
    const scopedNode = [nodeByPath.get(edge.from), nodeByPath.get(edge.to)].find((node) => (
      node && changedInScope.has(node.path) && node.focusPath && scope.has(node.focusPath)
    ));
    return { ...edge, focusPath: scopedNode?.focusPath ?? null };
  });
  return {
    ...result,
    nodes,
    edges: scopedEdges,
    summary: {
      changedModules: nodes.filter((node) => node.state !== 'context').length,
      addedEdges: scopedEdges.filter((edge) => edge.state === 'added').length,
      removedEdges: scopedEdges.filter((edge) => edge.state === 'removed').length,
      contextEdges: scopedEdges.filter((edge) => edge.state === 'context').length,
    },
  };
}
