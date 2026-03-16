'use client';

/**
 * GraphExplorer3D — Interactive 3D Knowledge Graph Explorer
 *
 * Canvas 2D isometric visualization of Cortex memory clusters.
 * Forked from CortexTerrain.tsx, wired to real Cortex data.
 *
 * Features:
 * - Full 360° drag rotation + scroll zoom
 * - Search → matching bars light up, camera lerps, non-matches dim
 * - Click-to-inspect → slide-in panel with facts, confidence, actions
 * - Cluster labels floating above peaks
 * - Breathing animation + particle streams from peaks
 */

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Search, X, RefreshCw, Trash2, ArrowUp } from 'lucide-react';

/* ─── Types ─── */

interface ClusterData {
  label: string;
  type: string;
  factCount: number;
  avgConfidence: number;
  color: string;
}

interface SearchResult {
  text: string;
  confidence: number;
  source: string;
  type: string;
}

interface TerrainCell {
  gx: number; gz: number;
  height: number; rawHeight: number;
  color: string; cluster: ClusterData;
  glowIntensity: number;
  highlight: number; // 0-1, 1 = search match highlighted
}

interface Particle {
  x: number; y: number; z: number;
  vy: number; life: number; maxLife: number;
  color: string; size: number;
}

/* ─── Config ─── */

const MAX_HEIGHT = 280;
const BAR_SPACING = 4.5;
const BASE_BAR_WIDTH = 3.2;

/* ─── Constants ─── */

const CATEGORY_COLORS: Record<string, string> = {
  state: '#ef4444', kv: '#f59e0b', relationship: '#3b82f6', temporal: '#06b6d4',
  decision: '#8b5cf6', identity: '#ec4899', config: '#22c55e', preference: '#f97316',
  location: '#14b8a6',
};

/* ─── Helpers ─── */

function hexToRgbStr(hex: string): string {
  const m = hex.match(/^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i);
  return m ? `${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)}` : '200, 200, 200';
}

/* ─── Color from height ─── */

function heightColor(t: number, baseColor: string): string {
  // Parse base color
  const m = baseColor.match(/^#([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i);
  if (!m) return baseColor;
  const br = parseInt(m[1], 16);
  const bg = parseInt(m[2], 16);
  const bb = parseInt(m[3], 16);

  // Blend from dark version to bright to white-hot
  if (t < 0.3) {
    const s = t / 0.3;
    return `rgb(${Math.floor(br * 0.3 + br * 0.5 * s)},${Math.floor(bg * 0.3 + bg * 0.5 * s)},${Math.floor(bb * 0.3 + bb * 0.5 * s)})`;
  }
  if (t < 0.7) {
    const s = (t - 0.3) / 0.4;
    return `rgb(${Math.floor(br * 0.8 + (255 - br) * 0.3 * s)},${Math.floor(bg * 0.8 + (255 - bg) * 0.3 * s)},${Math.floor(bb * 0.8 + (255 - bb) * 0.3 * s)})`;
  }
  // White-hot peak
  const s = (t - 0.7) / 0.3;
  return `rgb(${Math.floor(br + (255 - br) * s * 0.6)},${Math.floor(bg + (255 - bg) * s * 0.6)},${Math.floor(bb + (255 - bb) * s * 0.6)})`;
}

/* ─── Terrain Generation from Clusters ─── */

function generateTerrain(clusters: ClusterData[]): { grid: TerrainCell[][]; gridX: number; gridZ: number } {
  if (clusters.length === 0) return { grid: [], gridX: 0, gridZ: 0 };

  const totalFacts = clusters.reduce((s, c) => s + c.factCount, 0);
  // Grid size scales with data
  const gridX = Math.min(140, Math.max(60, Math.floor(Math.sqrt(totalFacts) * 0.8)));
  const gridZ = Math.min(80, Math.max(40, Math.floor(gridX * 0.6)));

  // Place clusters as gaussian peaks
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

      // Organic noise
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

/* ─── 3D Projection ─── */

function project3D(
  x: number, y: number, z: number,
  rotY: number, rotX: number,
  cx: number, cy: number, scale: number,
  gridX: number, gridZ: number,
): { sx: number; sy: number; depth: number } {
  const halfW = (gridX * BAR_SPACING) / 2;
  const halfD = (gridZ * BAR_SPACING) / 2;
  let px = x - halfW, py = y, pz = z - halfD;

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

/* ─── Spawn Particles ─── */

function spawnParticles(grid: TerrainCell[][], gridX: number, gridZ: number, count: number): Particle[] {
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

/* ─── Main Component ─── */

export const GraphExplorer3D = memo(function GraphExplorer3D() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const terrainRef = useRef<{ grid: TerrainCell[][]; gridX: number; gridZ: number }>({ grid: [], gridX: 0, gridZ: 0 });
  const particlesRef = useRef<Particle[]>([]);
  const rotRef = useRef({ y: -0.6, x: -0.55 });
  const targetRotRef = useRef({ y: -0.6, x: -0.55 });
  const zoomRef = useRef(1.0);
  const targetZoomRef = useRef(1.0);
  const draggingRef = useRef(false);
  const lastMouseRef = useRef({ x: 0, y: 0 });
  const frameRef = useRef<number>(0);
  const timeRef = useRef(0);

  const [clusters, setClusters] = useState<ClusterData[]>([]);
  const [stats, setStats] = useState<Record<string, unknown>>({});
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchFocused, setSearchFocused] = useState(false);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [selectedCluster, setSelectedCluster] = useState<ClusterData | null>(null);
  const [loading, setLoading] = useState(true);

  // ── Focus Mode (fly-in to cluster) ──
  const [focusedCluster, setFocusedCluster] = useState<ClusterData | null>(null);
  const [focusFacts, setFocusFacts] = useState<SearchResult[]>([]);
  const focusProgressRef = useRef(0); // 0 = overview, 1 = fully focused
  const savedCameraRef = useRef({ rotY: -0.6, rotX: -0.55, zoom: 1.0 });
  const factRevealRef = useRef(0); // counts up for staggered fact reveal

  // Fetch data (initial + auto-refresh every 60s)
  useEffect(() => {
    let cancelled = false;

    const fetchData = () => {
      const q = searchQuery ? `?q=${encodeURIComponent(searchQuery)}` : '';
      fetch(`/api/panel/cortex-graph${q}`)
        .then(r => r.json())
        .then(data => {
          if (cancelled) return;
          const c: ClusterData[] = data.clusters ?? [];
          setClusters(c);
          setStats(data.stats ?? {});
          if (searchQuery) {
            setSearchResults(data.searchResults ?? []);
          }
          // Only regenerate terrain if cluster data actually changed
          const newKey = c.map(cl => `${cl.type}:${cl.factCount}`).join(',');
          const oldKey = terrainRef.current.grid.length > 0
            ? clusters.map(cl => `${cl.type}:${cl.factCount}`).join(',')
            : '';
          if (newKey !== oldKey) {
            terrainRef.current = generateTerrain(c);
          }
          setLoading(false);
        })
        .catch(() => { if (!cancelled) setLoading(false); });
    };

    fetchData();
    const interval = setInterval(fetchData, 60000);
    return () => { cancelled = true; clearInterval(interval); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Canvas sizing
  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = container.clientWidth;
      const h = container.clientHeight;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      const ctx = canvas.getContext('2d');
      if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    requestAnimationFrame(resize);
    const ro = new ResizeObserver(resize);
    ro.observe(container);
    return () => ro.disconnect();
  }, []);

  // Search handler (debounced 300ms)
  const executeSearch = useCallback(async (q: string) => {
    if (!q.trim()) {
      for (const row of terrainRef.current.grid) {
        for (const cell of row) cell.highlight = 1;
      }
      setSearchResults([]);
      setSearchOpen(false);
      return;
    }

    try {
      const res = await fetch(`/api/panel/cortex-graph?q=${encodeURIComponent(q)}`);
      const data = await res.json();
      const results: SearchResult[] = data.searchResults ?? [];
      setSearchResults(results);
      setSearchOpen(results.length > 0);

      const matchingTypes = new Set(results.map((r: SearchResult) => r.type));

      for (const row of terrainRef.current.grid) {
        for (const cell of row) {
          cell.highlight = matchingTypes.has(cell.cluster.type) ? 1.0 : 0.15;
        }
      }

      if (clusters.length > 0 && matchingTypes.size > 0) {
        const matchCluster = clusters.find(c => matchingTypes.has(c.type));
        if (matchCluster) {
          const idx = clusters.indexOf(matchCluster);
          const angle = (idx / clusters.length) * Math.PI * 2 + 0.3;
          targetRotRef.current.y = -angle - 0.3;
          targetZoomRef.current = 1.3;
        }
      }
    } catch { /* silent */ }
  }, [clusters]);

  const handleSearchInput = useCallback((q: string) => {
    setSearchQuery(q);
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    if (!q.trim()) {
      executeSearch('');
      return;
    }
    searchTimerRef.current = setTimeout(() => executeSearch(q), 300);
  }, [executeSearch]);

  // Click a search result → fly into its cluster
  const handleResultClick = useCallback((result: SearchResult) => {
    setSearchOpen(false);
    const cluster = clusters.find(c => c.type === result.type);
    if (!cluster) return;

    // Save camera
    savedCameraRef.current = {
      rotY: targetRotRef.current.y,
      rotX: targetRotRef.current.x,
      zoom: targetZoomRef.current,
    };

    const idx = clusters.indexOf(cluster);
    const angle = (idx / clusters.length) * Math.PI * 2 + 0.3;
    targetRotRef.current.y = -angle - 0.5;
    targetRotRef.current.x = -0.45;
    targetZoomRef.current = 2.2;

    for (const row of terrainRef.current.grid) {
      for (const cell of row) {
        cell.highlight = cell.cluster.type === cluster.type ? 1.0 : 0.08;
      }
    }

    factRevealRef.current = 0;
    setFocusedCluster(cluster);
    setSelectedCluster(null);
    // Use the search results as focus facts, filtered to this type
    setFocusFacts(searchResults.filter(r => r.type === result.type).slice(0, 12));
  }, [clusters, searchResults]);

  // Mouse drag rotation
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    draggingRef.current = true;
    lastMouseRef.current = { x: e.clientX, y: e.clientY };
  }, []);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!draggingRef.current) return;
    const dx = e.clientX - lastMouseRef.current.x;
    const dy = e.clientY - lastMouseRef.current.y;
    targetRotRef.current.y += dx * 0.005;
    targetRotRef.current.x = Math.max(-1.2, Math.min(-0.15, targetRotRef.current.x + dy * 0.003));
    lastMouseRef.current = { x: e.clientX, y: e.clientY };
  }, []);

  const handleMouseUp = useCallback(() => { draggingRef.current = false; }, []);

  // Scroll zoom
  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    targetZoomRef.current = Math.max(0.4, Math.min(3.0, targetZoomRef.current - e.deltaY * 0.001));
  }, []);

  // Find cluster at screen position
  const findClusterAtPoint = useCallback((mx: number, my: number): ClusterData | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const { grid, gridX, gridZ } = terrainRef.current;
    const w = rect.width, h = rect.height;
    const cxp = w / 2, cyp = h * 0.6;
    const sc = Math.max(w, h) / 580 * zoomRef.current;

    let closest: ClusterData | null = null;
    let closestDist = 30;
    for (const row of grid) {
      for (const cell of row) {
        if (cell.rawHeight < 2 || cell.highlight < 0.5) continue;
        const top = project3D(cell.gx * BAR_SPACING, -cell.rawHeight, cell.gz * BAR_SPACING, rotRef.current.y, rotRef.current.x, cxp, cyp, sc, gridX, gridZ);
        const dx = mx - top.sx, dy = my - top.sy;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < closestDist && cell.height > 0.2) { closestDist = dist; closest = cell.cluster; }
      }
    }
    return closest;
  }, []);

  // Single click → select cluster (show side panel)
  const handleCanvasClick = useCallback((e: React.MouseEvent) => {
    if (draggingRef.current) return;
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const cluster = findClusterAtPoint(e.clientX - rect.left, e.clientY - rect.top);
    setSelectedCluster(cluster);
  }, [findClusterAtPoint]);

  // Double-click → fly into cluster
  const handleDoubleClick = useCallback(async (e: React.MouseEvent) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const cluster = findClusterAtPoint(e.clientX - rect.left, e.clientY - rect.top);
    if (!cluster) return;

    // If already focused on this cluster, exit focus
    if (focusedCluster?.type === cluster.type) {
      exitFocus();
      return;
    }

    // Save camera
    savedCameraRef.current = {
      rotY: targetRotRef.current.y,
      rotX: targetRotRef.current.x,
      zoom: targetZoomRef.current,
    };

    // Find cluster's world position for camera target
    const idx = clusters.indexOf(cluster);
    const angle = (idx / clusters.length) * Math.PI * 2 + 0.3;

    // Fly camera to face this cluster
    targetRotRef.current.y = -angle - 0.5;
    targetRotRef.current.x = -0.45;
    targetZoomRef.current = 2.2;

    // Dim non-focused bars
    for (const row of terrainRef.current.grid) {
      for (const cell of row) {
        cell.highlight = cell.cluster.type === cluster.type ? 1.0 : 0.08;
      }
    }

    // Reset reveal counter
    factRevealRef.current = 0;
    setFocusedCluster(cluster);
    setSelectedCluster(null);

    // Fetch facts for this cluster
    try {
      const res = await fetch(`/api/panel/cortex-graph?q=${encodeURIComponent(cluster.label)}`);
      const data = await res.json();
      setFocusFacts((data.searchResults ?? []).slice(0, 12));
    } catch {
      setFocusFacts([]);
    }
  }, [clusters, focusedCluster]);

  // Exit focus mode
  const exitFocus = useCallback(() => {
    // Restore camera
    targetRotRef.current.y = savedCameraRef.current.rotY;
    targetRotRef.current.x = savedCameraRef.current.rotX;
    targetZoomRef.current = savedCameraRef.current.zoom;

    // Restore all highlights
    for (const row of terrainRef.current.grid) {
      for (const cell of row) cell.highlight = 1.0;
    }

    focusProgressRef.current = 0;
    factRevealRef.current = 0;
    setFocusedCluster(null);
    setFocusFacts([]);
  }, []);

  // Animation loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return;

    let animating = true;
    let lastSpawn = 0;

    function animate() {
      if (!animating || !ctx || !canvas) return;
      timeRef.current++;
      const t = timeRef.current;

      const rect = canvas.getBoundingClientRect();
      const w = rect.width, h = rect.height;
      const cx = w / 2, cy = h * 0.6;

      // Smooth lerp
      rotRef.current.y += (targetRotRef.current.y - rotRef.current.y) * 0.04;
      rotRef.current.x += (targetRotRef.current.x - rotRef.current.x) * 0.04;
      zoomRef.current += (targetZoomRef.current - zoomRef.current) * 0.06;

      // Auto-orbit when not dragging (slower in focus mode)
      if (!draggingRef.current && !focusedCluster) {
        targetRotRef.current.y += 0.0008;
      }

      // Focus mode progress
      if (focusedCluster) {
        focusProgressRef.current = Math.min(1, focusProgressRef.current + 0.025); // ~40 frames to fully focus
        factRevealRef.current += 0.016; // reveal timer
      } else {
        focusProgressRef.current = Math.max(0, focusProgressRef.current - 0.04); // faster exit
      }
      const fp = focusProgressRef.current; // shorthand

      const scale = Math.max(w, h) / 580 * zoomRef.current;
      const rotY = rotRef.current.y;
      const rotX = rotRef.current.x;
      const { grid, gridX, gridZ } = terrainRef.current;

      // Background
      ctx.fillStyle = '#09090b';
      ctx.fillRect(0, 0, w, h);

      // Floor glow
      const floorGlow = ctx.createRadialGradient(cx, cy + 60, 0, cx, cy + 60, w * 0.5);
      floorGlow.addColorStop(0, 'rgba(239, 68, 68, 0.03)');
      floorGlow.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = floorGlow;
      ctx.fillRect(0, 0, w, h);

      if (grid.length === 0) {
        ctx.fillStyle = '#94a3b8';
        ctx.font = '13px -apple-system, system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(loading ? 'Loading Cortex knowledge graph…' : 'No data', cx, cy);
        frameRef.current = requestAnimationFrame(animate);
        return;
      }

      // ── Holographic Grid Floor ──
      const gridLines = 20;
      const gridSpan = Math.max(gridX, gridZ) * BAR_SPACING;
      const gridStep = gridSpan / gridLines;
      ctx.lineWidth = 0.5;

      for (let i = 0; i <= gridLines; i++) {
        const pos = i * gridStep;

        // Lines along X axis
        const x1 = project3D(pos, 0, 0, rotY, rotX, cx, cy, scale, gridX, gridZ);
        const x2 = project3D(pos, 0, gridSpan, rotY, rotX, cx, cy, scale, gridX, gridZ);
        // Fade based on distance from center
        const distFromCenter = Math.abs(i / gridLines - 0.5) * 2;
        const lineAlpha = 0.08 * (1 - distFromCenter * 0.6);
        ctx.strokeStyle = `rgba(148, 163, 184, ${lineAlpha})`;
        ctx.beginPath();
        ctx.moveTo(x1.sx, x1.sy);
        ctx.lineTo(x2.sx, x2.sy);
        ctx.stroke();

        // Lines along Z axis
        const z1 = project3D(0, 0, pos, rotY, rotX, cx, cy, scale, gridX, gridZ);
        const z2 = project3D(gridSpan, 0, pos, rotY, rotX, cx, cy, scale, gridX, gridZ);
        ctx.strokeStyle = `rgba(148, 163, 184, ${lineAlpha})`;
        ctx.beginPath();
        ctx.moveTo(z1.sx, z1.sy);
        ctx.lineTo(z2.sx, z2.sy);
        ctx.stroke();
      }

      // Grid floor glow at intersection points
      for (let i = 0; i <= gridLines; i += 4) {
        for (let j = 0; j <= gridLines; j += 4) {
          const pos = project3D(i * gridStep, 0, j * gridStep, rotY, rotX, cx, cy, scale, gridX, gridZ);
          ctx.fillStyle = 'rgba(148, 163, 184, 0.12)';
          ctx.beginPath();
          ctx.arc(pos.sx, pos.sy, 1.5, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // Collect bars
      const bars: {
        sx: number; sy: number; depth: number;
        barH: number; barW: number;
        color: string; cell: TerrainCell; topY: number;
      }[] = [];

      for (let ix = 0; ix < gridX; ix++) {
        for (let iz = 0; iz < gridZ; iz++) {
          const cell = grid[ix]?.[iz];
          if (!cell || cell.rawHeight < 1) continue;

          let worldX = ix * BAR_SPACING;
          let worldZ = iz * BAR_SPACING;

          // Spread effect: focused cluster bars push outward from cluster center
          if (fp > 0 && focusedCluster && cell.cluster.type === focusedCluster.type) {
            const clusterIdx = clusters.indexOf(focusedCluster);
            const clusterAngle = (clusterIdx / clusters.length) * Math.PI * 2 + 0.3;
            const clusterCX = (0.5 + Math.cos(clusterAngle) * (0.15 + (clusterIdx % 3) * 0.1)) * gridX * BAR_SPACING;
            const clusterCZ = (0.5 + Math.sin(clusterAngle) * (0.15 + (clusterIdx % 3) * 0.1)) * gridZ * BAR_SPACING;
            const dx = worldX - clusterCX;
            const dz = worldZ - clusterCZ;
            const dist = Math.sqrt(dx * dx + dz * dz);
            if (dist > 0.1) {
              const spreadAmount = fp * 2.5; // spread multiplier
              worldX += (dx / dist) * dist * spreadAmount;
              worldZ += (dz / dist) * dist * spreadAmount;
            }
          }

          const breathe = cell.height > 0.4 ? Math.sin(t * 0.02 + ix * 0.1 + iz * 0.15) * 3 * cell.height : 0;
          const animHeight = cell.rawHeight * cell.highlight + breathe;
          if (animHeight < 1) continue;

          const base = project3D(worldX, 0, worldZ, rotY, rotX, cx, cy, scale, gridX, gridZ);
          const top = project3D(worldX, -animHeight, worldZ, rotY, rotX, cx, cy, scale, gridX, gridZ);

          const barH = base.sy - top.sy;
          if (barH < 0.5) continue;

          const persp = 1200 / (1200 + base.depth + 600);
          const barW = BASE_BAR_WIDTH * persp * scale;

          bars.push({ sx: base.sx, sy: base.sy, depth: base.depth, barH, barW, color: cell.color, cell, topY: top.sy });
        }
      }

      bars.sort((a, b) => b.depth - a.depth);

      // ── Floor Reflections (drawn before bars so they're underneath) ──
      for (const bar of bars) {
        if (bar.barH < 3 || bar.cell.height < 0.15) continue;
        const reflH = bar.barH * 0.35; // reflection is 35% of bar height
        const rgb = hexToRgbStr(bar.cell.cluster.color);
        const reflAlpha = 0.08 * bar.cell.highlight * bar.cell.height;

        // Reflected gradient (fades downward)
        const reflGrad = ctx.createLinearGradient(
          bar.sx, bar.sy,
          bar.sx, bar.sy + reflH,
        );
        reflGrad.addColorStop(0, `rgba(${rgb}, ${reflAlpha})`);
        reflGrad.addColorStop(1, `rgba(${rgb}, 0)`);
        ctx.fillStyle = reflGrad;
        ctx.fillRect(bar.sx - bar.barW / 2, bar.sy, bar.barW, reflH);
      }

      // ── Draw Bars (with vertical gradient + depth fog) ──
      // Compute depth range for fog
      const depths = bars.map(b => b.depth);
      const minDepth = Math.min(...depths);
      const maxDepth = Math.max(...depths);
      const depthRange = Math.max(maxDepth - minDepth, 1);

      for (const bar of bars) {
        // Depth fog: far bars fade out
        const depthNorm = (bar.depth - minDepth) / depthRange; // 0 = near, 1 = far
        const fogFactor = 1 - depthNorm * 0.55; // far bars retain 45% visibility
        const alpha = (0.85 + bar.cell.height * 0.15) * fogFactor;
        const rgb = hexToRgbStr(bar.cell.cluster.color);

        // Vertical gradient: dark base → category color → bright tip
        const barGrad = ctx.createLinearGradient(bar.sx, bar.sy, bar.sx, bar.topY);
        barGrad.addColorStop(0, `rgba(${rgb}, ${0.25 * alpha * bar.cell.highlight})`);
        barGrad.addColorStop(0.35, `rgba(${rgb}, ${0.65 * alpha * bar.cell.highlight})`);
        barGrad.addColorStop(0.75, `rgba(${rgb}, ${alpha * bar.cell.highlight})`);
        barGrad.addColorStop(1, `rgba(${rgb}, ${alpha * bar.cell.highlight})`);

        ctx.fillStyle = barGrad;
        ctx.fillRect(bar.sx - bar.barW / 2, bar.topY, bar.barW, bar.barH);

        // White-hot top cap
        const capRgb = rgb.split(', ').map(v => Math.min(parseInt(v) + 80, 255)).join(', ');
        ctx.globalAlpha = bar.cell.highlight * fogFactor;
        ctx.fillStyle = `rgba(${capRgb}, 0.95)`;
        ctx.fillRect(bar.sx - bar.barW / 2, bar.topY, bar.barW, Math.max(1, bar.barW * 0.5));
        ctx.globalAlpha = 1;

        // Peak glow
        if (bar.cell.glowIntensity > 0 && bar.cell.highlight > 0.5) {
          const glowR = 8 + bar.cell.glowIntensity * 15;
          const grad = ctx.createRadialGradient(bar.sx, bar.topY, 0, bar.sx, bar.topY, glowR * scale);
          grad.addColorStop(0, `rgba(${capRgb}, ${0.5 * bar.cell.glowIntensity * fogFactor})`);
          grad.addColorStop(0.5, `rgba(${rgb}, ${0.15 * bar.cell.glowIntensity * fogFactor})`);
          grad.addColorStop(1, 'transparent');
          ctx.fillStyle = grad;
          ctx.beginPath();
          ctx.arc(bar.sx, bar.topY, glowR * scale, 0, Math.PI * 2);
          ctx.fill();
        }

        // Light lines from peaks
        if (bar.cell.height > 0.55 && bar.cell.highlight > 0.5) {
          const lineAlpha = (bar.cell.height - 0.55) * 0.15 * fogFactor;
          ctx.strokeStyle = `rgba(${capRgb}, ${lineAlpha})`;
          ctx.lineWidth = 0.5;
          ctx.beginPath();
          ctx.moveTo(bar.sx, bar.topY);
          ctx.lineTo(bar.sx, bar.topY - 30 - bar.cell.height * 60);
          ctx.stroke();
        }
      }

      ctx.globalAlpha = 1;

      // ── Connection Arcs Between Clusters ──
      // Find peak screen positions for each cluster type first
      const clusterPeaks = new Map<string, { sx: number; sy: number; height: number; color: string }>();
      for (const bar of bars) {
        const key = bar.cell.cluster.type;
        const existing = clusterPeaks.get(key);
        if (!existing || bar.cell.height > existing.height) {
          clusterPeaks.set(key, { sx: bar.sx, sy: bar.topY, height: bar.cell.height, color: bar.cell.cluster.color });
        }
      }

      // Define semantic connections between cluster types
      const connections: [string, string][] = [
        ['state', 'kv'],              // state facts reference key-value pairs
        ['decision', 'identity'],     // decisions shape identity
        ['decision', 'preference'],   // decisions reflect preferences
        ['config', 'state'],          // config drives state
        ['relationship', 'identity'], // relationships define identity
        ['temporal', 'state'],        // temporal events create state
        ['location', 'config'],       // locations inform config
        ['preference', 'identity'],   // preferences express identity
      ];

      for (const [typeA, typeB] of connections) {
        const peakA = clusterPeaks.get(typeA);
        const peakB = clusterPeaks.get(typeB);
        if (!peakA || !peakB) continue;
        if (peakA.height < 0.2 || peakB.height < 0.2) continue;

        // Bezier control point — arc upward
        const midX = (peakA.sx + peakB.sx) / 2;
        const midY = Math.min(peakA.sy, peakB.sy) - 40 - Math.min(peakA.height, peakB.height) * 30;

        // Pulsing alpha
        const pulse = 0.5 + Math.sin(t * 0.015 + (typeA.length + typeB.length)) * 0.5;
        const arcAlpha = 0.06 + pulse * 0.06;

        // Draw arc with gradient
        ctx.lineWidth = 1.2;
        ctx.strokeStyle = `rgba(148, 163, 184, ${arcAlpha})`;
        ctx.beginPath();
        ctx.moveTo(peakA.sx, peakA.sy);
        ctx.quadraticCurveTo(midX, midY, peakB.sx, peakB.sy);
        ctx.stroke();

        // Colored glow on each end
        const glowSize = 4;
        ctx.fillStyle = `rgba(${hexToRgbStr(peakA.color)}, ${arcAlpha * 1.5})`;
        ctx.beginPath();
        ctx.arc(peakA.sx, peakA.sy, glowSize, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = `rgba(${hexToRgbStr(peakB.color)}, ${arcAlpha * 1.5})`;
        ctx.beginPath();
        ctx.arc(peakB.sx, peakB.sy, glowSize, 0, Math.PI * 2);
        ctx.fill();

        // Traveling dot along the arc
        const dotT = (Math.sin(t * 0.02 + typeA.length * 2) + 1) / 2;
        const dotX = (1 - dotT) * (1 - dotT) * peakA.sx + 2 * (1 - dotT) * dotT * midX + dotT * dotT * peakB.sx;
        const dotY = (1 - dotT) * (1 - dotT) * peakA.sy + 2 * (1 - dotT) * dotT * midY + dotT * dotT * peakB.sy;
        ctx.fillStyle = `rgba(255, 255, 255, ${arcAlpha * 2.5})`;
        ctx.beginPath();
        ctx.arc(dotX, dotY, 2, 0, Math.PI * 2);
        ctx.fill();
      }

      // ── Floating Cluster Labels (fade out when zoomed out) ──
      const zoom = zoomRef.current;
      // Labels start fading below zoom 0.8, fully gone below 0.55
      const labelZoomAlpha = zoom > 0.8 ? 1 : zoom < 0.55 ? 0 : (zoom - 0.55) / 0.25;
      if (labelZoomAlpha > 0) for (const [type, pos] of clusterPeaks) {
        const cluster = clusters.find(c => c.type === type);
        if (!cluster) continue;

        const labelAlpha = Math.max(0.5, 0.9 - (pos.height < 0.15 ? 0.3 : 0)) * labelZoomAlpha;
        const labelY = pos.sy - 18;

        // Subtle backdrop behind label for readability
        const labelText = cluster.label;
        ctx.font = '600 11px -apple-system, system-ui, sans-serif';
        ctx.textAlign = 'center';
        const textWidth = ctx.measureText(labelText).width;

        ctx.globalAlpha = labelAlpha * 0.4;
        ctx.fillStyle = 'rgba(9, 9, 11, 0.7)';
        const padH = 4, padW = 6;
        ctx.fillRect(pos.sx - textWidth / 2 - padW, labelY - 10 - padH, textWidth + padW * 2, 24 + padH * 2);

        // Label name
        ctx.globalAlpha = labelAlpha;
        ctx.fillStyle = '#ffffff';
        ctx.fillText(labelText, pos.sx, labelY);

        // Fact count
        ctx.fillStyle = `rgba(${hexToRgbStr(cluster.color)}, 0.85)`;
        ctx.font = '500 10px "SF Mono", ui-monospace, monospace';
        ctx.fillText(`${cluster.factCount.toLocaleString()} facts`, pos.sx, labelY + 13);
        ctx.globalAlpha = 1;
      }

      // ── Fact Cards (visible in focus mode) ──
      if (fp > 0.3 && focusFacts.length > 0 && focusedCluster) {
        const focusPeak = clusterPeaks.get(focusedCluster.type);
        if (focusPeak) {
          const cardAlpha = Math.min(1, (fp - 0.3) / 0.4); // fade in after 30% progress
          const revealTime = factRevealRef.current;
          const maxCards = Math.min(focusFacts.length, 12);

          for (let i = 0; i < maxCards; i++) {
            // Stagger: each card appears 0.12s after the previous
            const cardDelay = i * 0.12;
            const cardProgress = Math.min(1, Math.max(0, (revealTime - cardDelay) / 0.3));
            if (cardProgress <= 0) continue;

            const fact = focusFacts[i];
            const rgb = hexToRgbStr(focusedCluster.color);

            // Position: fan out from the peak, alternating left/right
            const side = i % 2 === 0 ? -1 : 1;
            const row = Math.floor(i / 2);
            const cardX = focusPeak.sx + side * (130 + row * 15) * cardProgress;
            const cardY = focusPeak.sy - 50 + row * 42;

            // Card dimensions
            const cardW = 220;
            const cardH = 34;
            const cornerR = 8;

            // Ease-out slide
            const slideOffset = (1 - cardProgress) * 30 * side;
            const finalX = cardX + slideOffset;

            // Card background
            ctx.globalAlpha = cardAlpha * cardProgress * 0.92;
            ctx.fillStyle = `rgba(9, 9, 11, 0.88)`;
            ctx.beginPath();
            ctx.roundRect(finalX - cardW / 2, cardY - cardH / 2, cardW, cardH, cornerR);
            ctx.fill();

            // Left accent bar
            ctx.fillStyle = `rgba(${rgb}, ${cardAlpha * cardProgress * 0.9})`;
            ctx.beginPath();
            ctx.roundRect(finalX - cardW / 2, cardY - cardH / 2, 3, cardH, [cornerR, 0, 0, cornerR]);
            ctx.fill();

            // Confidence dot
            const dotRadius = 3;
            const confColor = fact.confidence > 70 ? `rgba(34, 197, 94, ${cardAlpha * cardProgress})` // green
              : fact.confidence > 40 ? `rgba(245, 158, 11, ${cardAlpha * cardProgress})` // amber
              : `rgba(148, 163, 184, ${cardAlpha * cardProgress})`; // gray
            ctx.fillStyle = confColor;
            ctx.beginPath();
            ctx.arc(finalX - cardW / 2 + 14, cardY, dotRadius, 0, Math.PI * 2);
            ctx.fill();

            // Fact text (truncated)
            ctx.globalAlpha = cardAlpha * cardProgress;
            ctx.fillStyle = '#e2e8f0';
            ctx.font = '11px -apple-system, system-ui, sans-serif';
            ctx.textAlign = 'left';
            const maxTextW = cardW - 50;
            let text = fact.text;
            while (ctx.measureText(text).width > maxTextW && text.length > 10) {
              text = text.slice(0, -4) + '…';
            }
            ctx.fillText(text, finalX - cardW / 2 + 24, cardY + 4);

            // Confidence % on right
            ctx.fillStyle = '#64748b';
            ctx.font = '9px "SF Mono", ui-monospace, monospace';
            ctx.textAlign = 'right';
            ctx.fillText(`${fact.confidence.toFixed(0)}%`, finalX + cardW / 2 - 8, cardY + 3);

            // Connection line from card to peak
            ctx.globalAlpha = cardAlpha * cardProgress * 0.15;
            ctx.strokeStyle = `rgba(${rgb}, 0.5)`;
            ctx.lineWidth = 0.8;
            ctx.beginPath();
            ctx.moveTo(finalX - cardW / 2 + (side < 0 ? cardW : 0), cardY);
            ctx.lineTo(focusPeak.sx, focusPeak.sy);
            ctx.stroke();
          }

          ctx.globalAlpha = 1;
          ctx.textAlign = 'center';
        }
      }

      // ── Search Result Nodes (visible when searching, outside focus mode) ──
      if (!focusedCluster && searchResults.length > 0) {
        const maxVisible = Math.min(searchResults.length, 8);
        for (let i = 0; i < maxVisible; i++) {
          const r = searchResults[i];
          const matchPeak = clusterPeaks.get(r.type);
          if (!matchPeak) continue;

          const rgb = hexToRgbStr(CATEGORY_COLORS[r.type] ?? '#94a3b8');
          const nodeY = matchPeak.sy - 30 - i * 22;
          const nodeX = matchPeak.sx;

          // Small pill
          ctx.globalAlpha = 0.85;
          ctx.fillStyle = 'rgba(9, 9, 11, 0.8)';
          const pillW = 150, pillH = 18;
          ctx.beginPath();
          ctx.roundRect(nodeX - pillW / 2, nodeY - pillH / 2, pillW, pillH, 5);
          ctx.fill();

          // Accent dot
          ctx.fillStyle = `rgba(${rgb}, 0.9)`;
          ctx.beginPath();
          ctx.arc(nodeX - pillW / 2 + 8, nodeY, 2.5, 0, Math.PI * 2);
          ctx.fill();

          // Text
          ctx.fillStyle = '#cbd5e1';
          ctx.font = '9px -apple-system, system-ui, sans-serif';
          ctx.textAlign = 'left';
          let pillText = r.text;
          while (ctx.measureText(pillText).width > pillW - 30 && pillText.length > 8) {
            pillText = pillText.slice(0, -4) + '…';
          }
          ctx.fillText(pillText, nodeX - pillW / 2 + 16, nodeY + 3);
          ctx.textAlign = 'center';
        }
        ctx.globalAlpha = 1;
      }

      // Particles
      if (t - lastSpawn > 4 && grid.length > 0) {
        particlesRef.current.push(...spawnParticles(grid, gridX, gridZ, 6));
        lastSpawn = t;
      }
      const alive: Particle[] = [];
      for (const p of particlesRef.current) {
        p.life++;
        p.y += p.vy;
        p.x += Math.sin(p.life * 0.05 + p.x * 0.01) * 0.3;
        if (p.life > p.maxLife) continue;

        const proj = project3D(p.x, p.y, p.z, rotY, rotX, cx, cy, scale, gridX, gridZ);
        const lifeRatio = p.life / p.maxLife;
        const a = lifeRatio < 0.1 ? lifeRatio * 10 : lifeRatio > 0.7 ? (1 - lifeRatio) / 0.3 : 1;

        ctx.globalAlpha = a * 0.5;
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(proj.sx, proj.sy, p.size * (1200 / (1200 + proj.depth + 600)), 0, Math.PI * 2);
        ctx.fill();
        alive.push(p);
      }
      particlesRef.current = alive;
      ctx.globalAlpha = 1;

      frameRef.current = requestAnimationFrame(animate);
    }

    frameRef.current = requestAnimationFrame(animate);
    return () => { animating = false; cancelAnimationFrame(frameRef.current); };
  }, [loading, clusters]);

  return (
    <div ref={containerRef} style={{ position: 'relative', width: '100%', height: '100%', background: '#09090b', overflow: 'hidden' }}>
      <canvas
        ref={canvasRef}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onClick={handleCanvasClick}
        onDoubleClick={handleDoubleClick}
        onWheel={handleWheel}
        style={{ width: '100%', height: '100%', cursor: draggingRef.current ? 'grabbing' : 'grab' }}
      />

      {/* Search bar + dropdown — top center */}
      <div style={{
        position: 'absolute',
        top: 14,
        left: '50%',
        transform: 'translateX(-50%)',
        width: 400,
        maxWidth: '65%',
        zIndex: 30,
      }}>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          paddingTop: 8,
          paddingRight: 14,
          paddingBottom: 8,
          paddingLeft: 14,
          borderRadius: searchOpen ? '12px 12px 0 0' : 12,
          background: 'rgba(9, 9, 11, 0.92)',
          backdropFilter: 'blur(20px)',
          WebkitBackdropFilter: 'blur(20px)',
          border: '1px solid rgba(148, 163, 184, 0.12)',
          borderBottom: searchOpen ? '1px solid rgba(148, 163, 184, 0.06)' : undefined,
          boxShadow: '0 4px 24px rgba(0,0,0,0.4)',
        }}>
          <Search size={14} style={{ color: '#64748b', flexShrink: 0 }} />
          <input
            type="text"
            placeholder="Search memories…"
            value={searchQuery}
            onChange={(e) => handleSearchInput(e.target.value)}
            onFocus={() => { setSearchFocused(true); if (searchResults.length > 0) setSearchOpen(true); }}
            onBlur={() => { setSearchFocused(false); setTimeout(() => setSearchOpen(false), 200); }}
            style={{
              flex: 1,
              border: 'none',
              background: 'transparent',
              outline: 'none',
              fontSize: 13,
              color: '#e2e8f0',
              fontFamily: '-apple-system, system-ui, sans-serif',
            }}
          />
          {searchQuery && (
            <>
              <span style={{ fontSize: 10, color: '#64748b', fontFamily: '"SF Mono", monospace', whiteSpace: 'nowrap' }}>
                {searchResults.length} results
              </span>
              <button type="button" onClick={() => handleSearchInput('')} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#64748b', padding: 0, flexShrink: 0 }}>
                <X size={14} />
              </button>
            </>
          )}
        </div>

        {/* Search results dropdown */}
        {searchOpen && searchResults.length > 0 && (
          <div style={{
            background: 'rgba(9, 9, 11, 0.95)',
            backdropFilter: 'blur(20px)',
            WebkitBackdropFilter: 'blur(20px)',
            border: '1px solid rgba(148, 163, 184, 0.10)',
            borderTop: 'none',
            borderRadius: '0 0 12px 12px',
            maxHeight: 320,
            overflowY: 'auto',
            boxShadow: '0 12px 40px rgba(0,0,0,0.5)',
          }}>
            {/* Group results by cluster type */}
            {(() => {
              const grouped = new Map<string, SearchResult[]>();
              for (const r of searchResults) {
                const arr = grouped.get(r.type) ?? [];
                arr.push(r);
                grouped.set(r.type, arr);
              }
              return Array.from(grouped.entries()).map(([type, results]) => {
                const cluster = clusters.find(c => c.type === type);
                const color = CATEGORY_COLORS[type] ?? '#94a3b8';
                return (
                  <div key={type}>
                    {/* Type header */}
                    <div style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 7,
                      paddingTop: 8,
                      paddingRight: 14,
                      paddingBottom: 4,
                      paddingLeft: 14,
                    }}>
                      <div style={{ width: 6, height: 6, borderRadius: 3, background: color, boxShadow: `0 0 6px ${color}50`, flexShrink: 0 }} />
                      <span style={{ fontSize: 10, fontWeight: 700, color, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                        {cluster?.label ?? type}
                      </span>
                      <span style={{ fontSize: 10, color: '#475569', marginLeft: 'auto' }}>
                        {results.length}
                      </span>
                    </div>
                    {/* Results */}
                    {results.slice(0, 5).map((r, i) => (
                      <div
                        key={i}
                        onMouseDown={(e) => { e.preventDefault(); handleResultClick(r); }}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 10,
                          paddingTop: 7,
                          paddingRight: 14,
                          paddingBottom: 7,
                          paddingLeft: 28,
                          cursor: 'pointer',
                          borderBottom: '1px solid rgba(148, 163, 184, 0.04)',
                          transition: 'background 120ms',
                        }}
                        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'rgba(148, 163, 184, 0.06)'; }}
                        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
                      >
                        {/* Confidence indicator */}
                        <div style={{
                          width: 4,
                          height: 4,
                          borderRadius: 2,
                          background: r.confidence > 70 ? '#22c55e' : r.confidence > 40 ? '#f59e0b' : '#64748b',
                          flexShrink: 0,
                        }} />
                        {/* Fact text */}
                        <span style={{
                          fontSize: 12,
                          color: '#cbd5e1',
                          lineHeight: 1.4,
                          flex: 1,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}>
                          {r.text}
                        </span>
                        {/* Confidence + source */}
                        <span style={{
                          fontSize: 10,
                          color: '#475569',
                          fontFamily: '"SF Mono", monospace',
                          whiteSpace: 'nowrap',
                          flexShrink: 0,
                        }}>
                          {r.confidence.toFixed(0)}%
                        </span>
                      </div>
                    ))}
                  </div>
                );
              });
            })()}
            {/* Footer */}
            <div style={{
              paddingTop: 6,
              paddingRight: 14,
              paddingBottom: 8,
              paddingLeft: 14,
              fontSize: 10,
              color: '#475569',
              textAlign: 'center',
              borderTop: '1px solid rgba(148, 163, 184, 0.06)',
            }}>
              Click a result to explore its cluster
            </div>
          </div>
        )}
      </div>

      {/* Stats — bottom left */}
      <div style={{
        position: 'absolute',
        bottom: 14,
        left: 14,
        display: 'flex',
        gap: 14,
        paddingTop: 8,
        paddingRight: 14,
        paddingBottom: 8,
        paddingLeft: 14,
        borderRadius: 10,
        background: 'rgba(9, 9, 11, 0.85)',
        border: '1px solid rgba(148, 163, 184, 0.08)',
      }}>
        {[
          { label: 'Active', value: (stats.activeFacts as number)?.toLocaleString() ?? '0', color: '#22c55e' },
          { label: 'Retired', value: (stats.retiredFacts as number)?.toLocaleString() ?? '0', color: '#64748b' },
          { label: 'Memories', value: (stats.totalMemories as number)?.toLocaleString() ?? '0', color: '#3b82f6' },
          { label: 'Clusters', value: String(clusters.length), color: '#ef4444' },
        ].map(s => (
          <div key={s.label}>
            <div style={{ fontSize: 15, fontWeight: 700, color: s.color, fontFamily: '"SF Mono", ui-monospace, monospace' }}>{s.value}</div>
            <div style={{ fontSize: 9, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{s.label}</div>
          </div>
        ))}
      </div>

      {/* Cluster legend — top left */}
      <div style={{
        position: 'absolute',
        top: 14,
        left: 14,
        paddingTop: 10,
        paddingRight: 12,
        paddingBottom: 10,
        paddingLeft: 12,
        borderRadius: 10,
        background: 'rgba(9, 9, 11, 0.85)',
        border: '1px solid rgba(148, 163, 184, 0.08)',
      }}>
        <div style={{ fontSize: 9, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>
          Knowledge Clusters
        </div>
        {clusters.map(c => (
          <div
            key={c.type}
            onClick={() => setSelectedCluster(selectedCluster?.type === c.type ? null : c)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 7,
              paddingTop: 3,
              paddingBottom: 3,
              cursor: 'pointer',
            }}
          >
            <div style={{ width: 7, height: 7, borderRadius: 4, background: c.color, boxShadow: `0 0 6px ${c.color}50`, flexShrink: 0 }} />
            <span style={{ fontSize: 11, color: '#cbd5e1' }}>{c.label}</span>
            <span style={{ fontSize: 10, color: '#475569', marginLeft: 'auto', fontFamily: '"SF Mono", monospace' }}>
              {c.factCount.toLocaleString()}
            </span>
          </div>
        ))}
      </div>

      {/* Controls hint — bottom right */}
      <div style={{
        position: 'absolute',
        bottom: 14,
        right: 14,
        fontSize: 10,
        color: '#475569',
        textAlign: 'right',
        lineHeight: 1.6,
      }}>
        {focusedCluster ? 'Drag to orbit · Double-click to exit' : 'Drag to orbit · Scroll to zoom · Double-click peak to explore'}
      </div>

      {/* Focus mode back button */}
      {focusedCluster && (
        <button
          type="button"
          onClick={exitFocus}
          style={{
            position: 'absolute',
            top: 14,
            right: 14,
            paddingTop: 8,
            paddingRight: 16,
            paddingBottom: 8,
            paddingLeft: 16,
            borderRadius: 10,
            border: `1px solid ${focusedCluster.color}30`,
            background: 'rgba(9, 9, 11, 0.9)',
            backdropFilter: 'blur(12px)',
            color: '#e2e8f0',
            fontSize: 12,
            fontWeight: 600,
            cursor: 'pointer',
            fontFamily: '-apple-system, system-ui, sans-serif',
            boxShadow: `0 4px 20px rgba(0,0,0,0.3), 0 0 20px ${focusedCluster.color}10`,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            zIndex: 20,
          }}
        >
          <span style={{ fontSize: 14 }}>←</span>
          <span>Back to Overview</span>
        </button>
      )}

      {/* Focus mode cluster info */}
      {focusedCluster && (
        <div style={{
          position: 'absolute',
          bottom: 60,
          left: '50%',
          transform: 'translateX(-50%)',
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          paddingTop: 10,
          paddingRight: 20,
          paddingBottom: 10,
          paddingLeft: 20,
          borderRadius: 12,
          background: 'rgba(9, 9, 11, 0.9)',
          border: `1px solid ${focusedCluster.color}25`,
          backdropFilter: 'blur(16px)',
          zIndex: 20,
        }}>
          <div style={{ width: 10, height: 10, borderRadius: 5, background: focusedCluster.color, boxShadow: `0 0 10px ${focusedCluster.color}60` }} />
          <span style={{ fontSize: 14, fontWeight: 700, color: '#e2e8f0' }}>{focusedCluster.label}</span>
          <span style={{ fontSize: 12, color: '#64748b', fontFamily: '"SF Mono", monospace' }}>
            {focusedCluster.factCount.toLocaleString()} facts
          </span>
          {focusFacts.length > 0 && (
            <span style={{ fontSize: 11, color: '#94a3b8' }}>
              · Showing {focusFacts.length} samples
            </span>
          )}
        </div>
      )}

      {/* Selected cluster detail panel */}
      {selectedCluster && !focusedCluster && (
        <div
          style={{
            position: 'absolute',
            top: 60,
            right: 14,
            width: 280,
            maxHeight: 'calc(100% - 120px)',
            overflowY: 'auto',
            paddingTop: 16,
            paddingRight: 18,
            paddingBottom: 16,
            paddingLeft: 18,
            borderRadius: 14,
            background: 'rgba(9, 9, 11, 0.95)',
            backdropFilter: 'blur(20px)',
            border: `1px solid ${selectedCluster.color}30`,
            boxShadow: `0 8px 40px rgba(0,0,0,0.4), 0 0 30px ${selectedCluster.color}10`,
          }}
        >
          <button type="button" onClick={() => setSelectedCluster(null)} style={{
            position: 'absolute', top: 10, right: 10, width: 24, height: 24, borderRadius: 12,
            border: '1px solid rgba(148,163,184,0.15)', background: 'rgba(148,163,184,0.08)',
            color: '#94a3b8', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12,
          }}>✕</button>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
            <div style={{ width: 10, height: 10, borderRadius: 5, background: selectedCluster.color, boxShadow: `0 0 10px ${selectedCluster.color}60` }} />
            <span style={{ fontSize: 14, fontWeight: 700, color: '#e2e8f0' }}>{selectedCluster.label}</span>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 14 }}>
            <div style={{ padding: 8, borderRadius: 8, background: 'rgba(148,163,184,0.06)' }}>
              <div style={{ fontSize: 16, fontWeight: 700, color: selectedCluster.color, fontFamily: '"SF Mono", monospace' }}>
                {selectedCluster.factCount.toLocaleString()}
              </div>
              <div style={{ fontSize: 9, color: '#64748b', textTransform: 'uppercase' }}>Facts</div>
            </div>
            <div style={{ padding: 8, borderRadius: 8, background: 'rgba(148,163,184,0.06)' }}>
              <div style={{ fontSize: 16, fontWeight: 700, color: '#e2e8f0', fontFamily: '"SF Mono", monospace' }}>
                {selectedCluster.avgConfidence.toFixed(0)}%
              </div>
              <div style={{ fontSize: 9, color: '#64748b', textTransform: 'uppercase' }}>Avg Confidence</div>
            </div>
          </div>

          <div style={{ fontSize: 10, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>
            Actions
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {[
              { icon: RefreshCw, label: 'Reinforce All', color: '#22c55e' },
              { icon: Trash2, label: 'Retire Stale', color: '#ef4444' },
              { icon: ArrowUp, label: 'Supersede', color: '#f59e0b' },
            ].map(action => (
              <button key={action.label} type="button" style={{
                display: 'flex', alignItems: 'center', gap: 5,
                paddingTop: 6, paddingRight: 10, paddingBottom: 6, paddingLeft: 10,
                borderRadius: 8, border: `1px solid ${action.color}30`,
                background: `${action.color}10`, color: action.color,
                fontSize: 11, fontWeight: 500, cursor: 'pointer',
                fontFamily: '-apple-system, system-ui, sans-serif',
              }}>
                <action.icon size={12} />
                {action.label}
              </button>
            ))}
          </div>

          {/* Search results for this cluster */}
          {searchResults.filter(r => r.type === selectedCluster.type).length > 0 && (
            <div style={{ marginTop: 14 }}>
              <div style={{ fontSize: 10, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>
                Matching Facts
              </div>
              {searchResults.filter(r => r.type === selectedCluster.type).slice(0, 8).map((r, i) => (
                <div key={i} style={{
                  fontSize: 11, color: '#cbd5e1', lineHeight: 1.5,
                  paddingTop: 6, paddingBottom: 6,
                  borderBottom: '1px solid rgba(148,163,184,0.06)',
                }}>
                  {r.text}
                  <div style={{ fontSize: 10, color: '#475569', marginTop: 2 }}>
                    {r.confidence.toFixed(0)}% · {r.source}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
});
