'use client';
/* eslint-disable @typescript-eslint/no-unused-vars, react-hooks/exhaustive-deps, react-hooks/immutability -- terrain refs are mutated intentionally for imperative animation/highlighting */

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
import { runGraphAnimation } from './graph-explorer/animation';
import { BAR_SPACING } from './graph-explorer/config';
import { ClusterInspectPanel } from './graph-explorer/ClusterInspectPanel';
import { HudOverlays } from './graph-explorer/HudOverlays';
import { SearchOverlay } from './graph-explorer/SearchOverlay';
import { generateTerrain, project3D } from './graph-explorer/terrain';
import type { ClusterData, Particle, SearchResult, TerrainCell } from './graph-explorer/types';

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
  const focusProgressRef = useRef(0);
  const savedCameraRef = useRef({ rotY: -0.6, rotX: -0.55, zoom: 1.0 });
  const factRevealRef = useRef(0);
  const focusedClusterRef = useRef<ClusterData | null>(null);
  const focusFactsRef = useRef<SearchResult[]>([]);
  const clustersRef = useRef<ClusterData[]>([]);

  useEffect(() => { focusedClusterRef.current = focusedCluster; }, [focusedCluster]);
  useEffect(() => { focusFactsRef.current = focusFacts; }, [focusFacts]);
  useEffect(() => { clustersRef.current = clusters; }, [clusters]);

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
  }, []);

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

    const curClusters = clustersRef.current;
    const cluster = curClusters.find(c => c.type === result.type);
    if (!cluster) return;

    savedCameraRef.current = {
      rotY: targetRotRef.current.y,
      rotX: targetRotRef.current.x,
      zoom: targetZoomRef.current,
    };

    const idx = curClusters.indexOf(cluster);
    const angle = (idx / curClusters.length) * Math.PI * 2 + 0.3;
    targetRotRef.current.y = -angle - 0.5;
    targetRotRef.current.x = -0.45;
    targetZoomRef.current = 2.2;

    for (const row of terrainRef.current.grid) {
      for (const cell of row) {
        cell.highlight = cell.cluster.type === cluster.type ? 1.0 : 0.08;
      }
    }

    focusProgressRef.current = 0;
    factRevealRef.current = 0;

    const filteredFacts = searchResults.filter(r => r.type === result.type).slice(0, 12);
    setFocusFacts(filteredFacts);
    setFocusedCluster(cluster);
    setSelectedCluster(null);
  }, [searchResults]);

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

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    targetZoomRef.current = Math.max(0.4, Math.min(3.0, targetZoomRef.current - e.deltaY * 0.001));
  }, []);

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

  const exitFocus = useCallback(() => {
    targetRotRef.current.y = savedCameraRef.current.rotY;
    targetRotRef.current.x = savedCameraRef.current.rotX;
    targetZoomRef.current = savedCameraRef.current.zoom;

    for (const row of terrainRef.current.grid) {
      for (const cell of row) cell.highlight = 1.0;
    }

    focusProgressRef.current = 0;
    factRevealRef.current = 0;
    setFocusedCluster(null);
    setFocusFacts([]);
  }, []);

  const handleCanvasClick = useCallback((e: React.MouseEvent) => {
    if (draggingRef.current) return;
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const cluster = findClusterAtPoint(e.clientX - rect.left, e.clientY - rect.top);
    setSelectedCluster(cluster);
  }, [findClusterAtPoint]);

  const handleDoubleClick = useCallback(async (e: React.MouseEvent) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const cluster = findClusterAtPoint(e.clientX - rect.left, e.clientY - rect.top);
    if (!cluster) return;

    if (focusedClusterRef.current?.type === cluster.type) {
      exitFocus();
      return;
    }

    savedCameraRef.current = {
      rotY: targetRotRef.current.y,
      rotX: targetRotRef.current.x,
      zoom: targetZoomRef.current,
    };

    const curClusters = clustersRef.current;
    const idx = curClusters.indexOf(cluster);
    const angle = (idx / Math.max(curClusters.length, 1)) * Math.PI * 2 + 0.3;

    targetRotRef.current.y = -angle - 0.5;
    targetRotRef.current.x = -0.45;
    targetZoomRef.current = 2.2;

    for (const row of terrainRef.current.grid) {
      for (const cell of row) {
        cell.highlight = cell.cluster.type === cluster.type ? 1.0 : 0.08;
      }
    }

    focusProgressRef.current = 0;
    factRevealRef.current = 0;
    setFocusedCluster(cluster);
    setSelectedCluster(null);

    try {
      const res = await fetch(`/api/panel/cortex-graph?q=${encodeURIComponent(cluster.label)}`);
      const data = await res.json();
      const facts = (data.searchResults ?? []).slice(0, 12);
      setFocusFacts(facts);
    } catch {
      setFocusFacts([]);
    }
  }, [exitFocus, findClusterAtPoint]);

  // Animation loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return;

    return runGraphAnimation(
      canvas,
      ctx,
      {
        terrainRef, particlesRef, rotRef, targetRotRef, zoomRef, targetZoomRef,
        draggingRef, timeRef, focusedClusterRef, focusFactsRef, clustersRef,
        focusProgressRef, factRevealRef, frameRef,
      },
      { clusters, searchResults, loading },
    );
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

      <SearchOverlay
        searchQuery={searchQuery}
        searchResults={searchResults}
        searchOpen={searchOpen}
        clusters={clusters}
        onSearchInput={handleSearchInput}
        onSearchFocus={() => { setSearchFocused(true); if (searchResults.length > 0) setSearchOpen(true); }}
        onSearchBlur={() => { setSearchFocused(false); setTimeout(() => setSearchOpen(false), 400); }}
        onResultClick={handleResultClick}
      />

      <HudOverlays
        stats={stats}
        clusters={clusters}
        selectedCluster={selectedCluster}
        focusedCluster={focusedCluster}
        focusFactsCount={focusFacts.length}
        onSelectCluster={setSelectedCluster}
        onExitFocus={exitFocus}
      />

      {selectedCluster && !focusedCluster && (
        <ClusterInspectPanel
          cluster={selectedCluster}
          searchResults={searchResults}
          onClose={() => setSelectedCluster(null)}
        />
      )}
    </div>
  );
});
