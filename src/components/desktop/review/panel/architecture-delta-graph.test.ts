import { describe, expect, it } from 'vitest';

import type { ArchitectureDeltaResult } from '@/lib/review/architecture-delta-types';
import {
  buildArchitectureGraph,
  filterArchitectureResult,
  initialArchitecturePrefix,
} from './architecture-delta-graph';

const result: ArchitectureDeltaResult = {
  ok: true,
  status: 'ready',
  reason: null,
  nodes: [
    { path: 'src/app/route.ts', state: 'changed', focusPath: 'src/app/route.ts' },
    { path: 'src/lib/service.ts', state: 'changed', focusPath: 'src/lib/service.ts' },
    { path: 'src/lib/store.ts', state: 'context', focusPath: null },
    { path: 'tests/route.test.ts', state: 'changed', focusPath: 'tests/route.test.ts' },
  ],
  edges: [
    { from: 'src/app/route.ts', to: 'src/lib/service.ts', state: 'added', focusPath: 'src/app/route.ts' },
    { from: 'src/lib/service.ts', to: 'src/lib/store.ts', state: 'context', focusPath: 'src/lib/service.ts' },
    { from: 'src/lib/store.ts', to: 'src/lib/service.ts', state: 'context', focusPath: 'src/lib/service.ts' },
  ],
  summary: { changedModules: 3, addedEdges: 1, removedEdges: 0, contextEdges: 2 },
  unsupportedPaths: [],
  omittedPaths: [],
  resolutionWarnings: [],
  truncated: false,
  generatedAt: '2026-09-21T00:00:00.000Z',
};

describe('architecture delta graph model', () => {
  it('starts at the repository boundary when changed modules span source and tests', () => {
    expect(initialArchitecturePrefix(result.nodes)).toEqual([]);
    const graph = buildArchitectureGraph(result.nodes, result.edges, []);

    expect(graph.nodes.map((node) => node.id)).toEqual(expect.arrayContaining(['src', 'tests']));
    expect(graph.nodes.find((node) => node.id === 'src')).toMatchObject({ directory: true });
  });

  it('drills into real directories, aggregates relationships, and surfaces cycles', () => {
    const graph = buildArchitectureGraph(result.nodes, result.edges, ['src']);

    expect(graph.nodes.map((node) => node.id)).toEqual(expect.arrayContaining(['src/app', 'src/lib']));
    expect(graph.edges).toContainEqual(expect.objectContaining({ from: 'src/app', to: 'src/lib', state: 'added' }));

    const libGraph = buildArchitectureGraph(result.nodes, result.edges, ['src', 'lib']);
    expect(libGraph.nodes.filter((node) => node.cyclic).map((node) => node.id)).toEqual([
      'src/lib/service.ts',
      'src/lib/store.ts',
    ]);
  });

  it('does not report a cycle that the change removes', () => {
    const withoutLiveReverse = {
      ...result,
      edges: result.edges.map((edge) => (
        edge.from === 'src/lib/store.ts' ? { ...edge, state: 'removed' as const } : edge
      )),
    };
    const graph = buildArchitectureGraph(withoutLiveReverse.nodes, withoutLiveReverse.edges, ['src', 'lib']);

    expect(graph.nodes.every((node) => !node.cyclic)).toBe(true);
    const service = graph.nodes.find((node) => node.id === 'src/lib/service.ts');
    const store = graph.nodes.find((node) => node.id === 'src/lib/store.ts');
    expect(service?.x).toBeLessThan(store?.x ?? 0);
  });

  it('keeps the graph aligned to the selected Review scope with its dependency context', () => {
    const scoped = filterArchitectureResult(result, ['src/app/route.ts']);

    expect(scoped.nodes.map((node) => node.path)).toEqual([
      'src/app/route.ts',
      'src/lib/service.ts',
    ]);
    expect(scoped.nodes.find((node) => node.path === 'src/lib/service.ts')).toMatchObject({
      state: 'context',
      focusPath: null,
    });
    expect(scoped.edges).toEqual([
      expect.objectContaining({ from: 'src/app/route.ts', to: 'src/lib/service.ts' }),
    ]);
  });
});
