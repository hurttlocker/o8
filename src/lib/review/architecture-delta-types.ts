export type ArchitectureDeltaStatus = 'ready' | 'unsupported' | 'unavailable';
export type ArchitectureModuleState = 'added' | 'removed' | 'changed' | 'context';
export type ArchitectureEdgeState = 'added' | 'removed' | 'context';

export interface ArchitectureDeltaNode {
  path: string;
  state: ArchitectureModuleState;
  focusPath: string | null;
}

export interface ArchitectureDeltaEdge {
  from: string;
  to: string;
  state: ArchitectureEdgeState;
  focusPath: string | null;
}

export interface ArchitectureDeltaSummary {
  changedModules: number;
  addedEdges: number;
  removedEdges: number;
  contextEdges: number;
}

export interface ArchitectureDeltaResult {
  ok: true;
  status: ArchitectureDeltaStatus;
  reason: string | null;
  /** Stable digest of the graph evidence; unlike generatedAt, it changes only when the evidence changes. */
  analysisId?: string;
  nodes: ArchitectureDeltaNode[];
  edges: ArchitectureDeltaEdge[];
  summary: ArchitectureDeltaSummary;
  unsupportedPaths: string[];
  omittedPaths: string[];
  resolutionWarnings: string[];
  truncated: boolean;
  generatedAt: string;
}
