import { BAR_SPACING, MAX_HEIGHT } from './config';
import type { ClusterData, Particle, TerrainCell, TerrainState } from './types';

export function hexToRgbStr(hex: string): string {
  const m = hex.match(/^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i);
  return m ? `${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)}` : '200, 200, 200';
}

export function heightColor(t: number, baseColor: string): string {
  const m = baseColor.match(/^#([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i);
  if (!m) return baseColor;
  const br = parseInt(m[1], 16);
  const bg = parseInt(m[2], 16);
  const bb = parseInt(m[3], 16);

  if (t < 0.3) {
    const s = t / 0.3;
    return `rgb(${Math.floor(br * 0.3 + br * 0.5 * s)},${Math.floor(bg * 0.3 + bg * 0.5 * s)},${Math.floor(bb * 0.3 + bb * 0.5 * s)})`;
  }
  if (t < 0.7) {
    const s = (t - 0.3) / 0.4;
    return `rgb(${Math.floor(br * 0.8 + (255 - br) * 0.3 * s)},${Math.floor(bg * 0.8 + (255 - bg) * 0.3 * s)},${Math.floor(bb * 0.8 + (255 - bb) * 0.3 * s)})`;
  }
  const s = (t - 0.7) / 0.3;
  return `rgb(${Math.floor(br + (255 - br) * s * 0.6)},${Math.floor(bg + (255 - bg) * s * 0.6)},${Math.floor(bb + (255 - bb) * s * 0.6)})`;
}

export function generateTerrain(clusters: ClusterData[]): TerrainState {
  if (clusters.length === 0) return { grid: [], gridX: 0, gridZ: 0 };

  const totalFacts = clusters.reduce((s, c) => s + c.factCount, 0);
  const gridX = Math.min(140, Math.max(60, Math.floor(Math.sqrt(totalFacts) * 0.8)));
  const gridZ = Math.min(80, Math.max(40, Math.floor(gridX * 0.6)));

  const peaks = clusters.map((c, i) => {
    const angle = (i / clusters.length) * Math.PI * 2 + 0.3;
    const radius = 0.15 + (i % 3) * 0.1;
    return {
      cx: 0.5 + Math.cos(angle) * radius,
      cz: 0.5 + Math.sin(angle) * radius,
      sigma: 0.06 + (c.factCount / totalFacts) * 0.12,
      amp: Math.min(1.0, (c.factCount / totalFacts) * 5),
      cluster: c,
    };
  });

  const grid: TerrainCell[][] = [];
  for (let ix = 0; ix < gridX; ix++) {
    const row: TerrainCell[] = [];
    for (let iz = 0; iz < gridZ; iz++) {
      const nx = ix / gridX;
      const nz = iz / gridZ;

      let maxVal = 0;
      let bestPeak = peaks[0];

      for (const peak of peaks) {
        const dx = nx - peak.cx;
        const dz = nz - peak.cz;
        const dist = Math.sqrt(dx * dx + dz * dz);
        const val = peak.amp * Math.exp(-(dist * dist) / (2 * peak.sigma * peak.sigma));
        if (val > maxVal) { maxVal = val; bestPeak = peak; }
      }

      const noise = (Math.sin(ix * 0.8 + iz * 0.5) * 0.5 + Math.cos(ix * 0.3 + iz * 1.2) * 0.3 + Math.sin(ix * 2.1 + iz * 0.7) * 0.2) * 0.12;
      const height = Math.max(0, Math.min(1, maxVal + noise * maxVal + Math.random() * 0.06 * maxVal));
      const rawHeight = height * MAX_HEIGHT;
      const color = heightColor(height, bestPeak.cluster.color);

      row.push({
        gx: ix, gz: iz,
        height, rawHeight, color,
        cluster: bestPeak.cluster,
        glowIntensity: height > 0.6 ? (height - 0.6) / 0.4 : 0,
        highlight: 1,
      });
    }
    grid.push(row);
  }
  return { grid, gridX, gridZ };
}

export function project3D(
  x: number, y: number, z: number,
  rotY: number, rotX: number,
  cx: number, cy: number, scale: number,
  gridX: number, gridZ: number,
): { sx: number; sy: number; depth: number } {
  const halfW = (gridX * BAR_SPACING) / 2;
  const halfD = (gridZ * BAR_SPACING) / 2;
  const px = x - halfW, py = y, pz = z - halfD;

  const cosY = Math.cos(rotY), sinY = Math.sin(rotY);
  const rx = px * cosY - pz * sinY;
  const rz = px * sinY + pz * cosY;

  const cosX = Math.cos(rotX), sinX = Math.sin(rotX);
  const ry = py * cosX - rz * sinX;
  const rz2 = py * sinX + rz * cosX;

  const perspective = 1200;
  const s = perspective / (perspective + rz2 + 600);
  return { sx: cx + rx * s * scale, sy: cy + ry * s * scale, depth: rz2 };
}

export function spawnParticles(grid: TerrainCell[][], gridX: number, gridZ: number, count: number): Particle[] {
  const particles: Particle[] = [];
  for (let i = 0; i < count; i++) {
    const ix = Math.floor(Math.random() * gridX);
    const iz = Math.floor(Math.random() * gridZ);
    if (!grid[ix]?.[iz]) continue;
    const cell = grid[ix][iz];
    if (cell.height < 0.25 || cell.highlight < 0.5) continue;
    particles.push({
      x: ix * BAR_SPACING + (Math.random() - 0.5) * BAR_SPACING,
      y: -cell.rawHeight - Math.random() * 15,
      z: iz * BAR_SPACING + (Math.random() - 0.5) * BAR_SPACING,
      vy: -(0.3 + Math.random() * 0.8),
      life: 0, maxLife: 50 + Math.random() * 100,
      color: cell.color, size: 1 + Math.random() * 2,
    });
  }
  return particles;
}
