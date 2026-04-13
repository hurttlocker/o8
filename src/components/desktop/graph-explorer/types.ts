export interface ClusterData {
  label: string;
  type: string;
  factCount: number;
  avgConfidence: number;
  color: string;
}

export interface SearchResult {
  text: string;
  confidence: number;
  source: string;
  type: string;
  factId?: number;
  subject?: string;
  predicate?: string;
  object?: string;
}

export interface TerrainCell {
  gx: number;
  gz: number;
  height: number;
  rawHeight: number;
  color: string;
  cluster: ClusterData;
  glowIntensity: number;
  highlight: number;
}

export interface Particle {
  x: number;
  y: number;
  z: number;
  vy: number;
  life: number;
  maxLife: number;
  color: string;
  size: number;
}

export interface TerrainState {
  grid: TerrainCell[][];
  gridX: number;
  gridZ: number;
}
