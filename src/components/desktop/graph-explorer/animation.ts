import { BAR_SPACING, BASE_BAR_WIDTH, CATEGORY_COLORS } from './config';
import { hexToRgbStr, project3D, spawnParticles } from './terrain';
import type { ClusterData, Particle, SearchResult, TerrainCell, TerrainState } from './types';

export interface GraphAnimationRefs {
  terrainRef: React.MutableRefObject<TerrainState>;
  particlesRef: React.MutableRefObject<Particle[]>;
  rotRef: React.MutableRefObject<{ y: number; x: number }>;
  targetRotRef: React.MutableRefObject<{ y: number; x: number }>;
  zoomRef: React.MutableRefObject<number>;
  targetZoomRef: React.MutableRefObject<number>;
  draggingRef: React.MutableRefObject<boolean>;
  timeRef: React.MutableRefObject<number>;
  focusedClusterRef: React.MutableRefObject<ClusterData | null>;
  focusFactsRef: React.MutableRefObject<SearchResult[]>;
  clustersRef: React.MutableRefObject<ClusterData[]>;
  focusProgressRef: React.MutableRefObject<number>;
  factRevealRef: React.MutableRefObject<number>;
  frameRef: React.MutableRefObject<number>;
}

export interface GraphAnimationSnapshot {
  clusters: ClusterData[];
  searchResults: SearchResult[];
  loading: boolean;
}

export function runGraphAnimation(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  refs: GraphAnimationRefs,
  snapshot: GraphAnimationSnapshot,
): () => void {
  const {
    terrainRef, particlesRef, rotRef, targetRotRef, zoomRef, targetZoomRef,
    draggingRef, timeRef, focusedClusterRef, focusFactsRef, clustersRef,
    focusProgressRef, factRevealRef, frameRef,
  } = refs;
  const { clusters, searchResults, loading } = snapshot;

  let animating = true;
  let lastSpawn = 0;

  function animate() {
    if (!animating || !ctx || !canvas) return;
    timeRef.current++;
    const t = timeRef.current;

    const rect = canvas.getBoundingClientRect();
    const w = rect.width, h = rect.height;
    const cx = w / 2, cy = h * 0.6;

    rotRef.current.y += (targetRotRef.current.y - rotRef.current.y) * 0.04;
    rotRef.current.x += (targetRotRef.current.x - rotRef.current.x) * 0.04;
    zoomRef.current += (targetZoomRef.current - zoomRef.current) * 0.06;

    const curFocusCluster = focusedClusterRef.current;
    const curFocusFacts = focusFactsRef.current;
    const curClusters = clustersRef.current;

    if (!draggingRef.current && !curFocusCluster) {
      targetRotRef.current.y += 0.0008;
    }

    if (curFocusCluster) {
      focusProgressRef.current = Math.min(1, focusProgressRef.current + 0.025);
      factRevealRef.current += 0.016;
    } else {
      focusProgressRef.current = Math.max(0, focusProgressRef.current - 0.04);
    }
    const fp = focusProgressRef.current;

    const scale = Math.max(w, h) / 580 * zoomRef.current;
    const rotY = rotRef.current.y;
    const rotX = rotRef.current.x;
    const { grid, gridX, gridZ } = terrainRef.current;

    ctx.fillStyle = '#09090b';
    ctx.fillRect(0, 0, w, h);

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
      const x1 = project3D(pos, 0, 0, rotY, rotX, cx, cy, scale, gridX, gridZ);
      const x2 = project3D(pos, 0, gridSpan, rotY, rotX, cx, cy, scale, gridX, gridZ);
      const distFromCenter = Math.abs(i / gridLines - 0.5) * 2;
      const lineAlpha = 0.08 * (1 - distFromCenter * 0.6);
      ctx.strokeStyle = `rgba(148, 163, 184, ${lineAlpha})`;
      ctx.beginPath();
      ctx.moveTo(x1.sx, x1.sy);
      ctx.lineTo(x2.sx, x2.sy);
      ctx.stroke();

      const z1 = project3D(0, 0, pos, rotY, rotX, cx, cy, scale, gridX, gridZ);
      const z2 = project3D(gridSpan, 0, pos, rotY, rotX, cx, cy, scale, gridX, gridZ);
      ctx.strokeStyle = `rgba(148, 163, 184, ${lineAlpha})`;
      ctx.beginPath();
      ctx.moveTo(z1.sx, z1.sy);
      ctx.lineTo(z2.sx, z2.sy);
      ctx.stroke();
    }

    for (let i = 0; i <= gridLines; i += 4) {
      for (let j = 0; j <= gridLines; j += 4) {
        const pos = project3D(i * gridStep, 0, j * gridStep, rotY, rotX, cx, cy, scale, gridX, gridZ);
        ctx.fillStyle = 'rgba(148, 163, 184, 0.12)';
        ctx.beginPath();
        ctx.arc(pos.sx, pos.sy, 1.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // ── Heat Map Mode ──
    const heatAlpha = rotX < -1.15 ? 1 : rotX < -0.9 ? (Math.abs(rotX) - 0.9) / 0.25 : 0;

    if (heatAlpha > 0 && grid.length > 0) {
      const cellW = Math.max(2, (w / gridX) * zoomRef.current * 0.8);
      const cellH = Math.max(1.5, (h / gridZ) * zoomRef.current * 0.5);

      for (let ix = 0; ix < gridX; ix++) {
        for (let iz = 0; iz < gridZ; iz++) {
          const cell = grid[ix]?.[iz];
          if (!cell || cell.rawHeight < 0.5) continue;

          const worldX = ix * BAR_SPACING;
          const worldZ = iz * BAR_SPACING;
          const proj = project3D(worldX, 0, worldZ, rotY, rotX, cx, cy, scale, gridX, gridZ);

          const intensity = cell.height * cell.highlight;
          if (intensity < 0.02) continue;

          const rgb = hexToRgbStr(cell.cluster.color);

          ctx.globalAlpha = intensity * 0.7 * heatAlpha;
          ctx.fillStyle = `rgba(${rgb}, 1)`;
          ctx.fillRect(proj.sx - cellW / 2, proj.sy - cellH / 2, cellW, cellH);

          if (intensity > 0.4) {
            const glowSize = cellW * (1.5 + intensity);
            const heatGlow = ctx.createRadialGradient(proj.sx, proj.sy, 0, proj.sx, proj.sy, glowSize);
            heatGlow.addColorStop(0, `rgba(${rgb}, ${intensity * 0.3 * heatAlpha})`);
            heatGlow.addColorStop(1, 'transparent');
            ctx.fillStyle = heatGlow;
            ctx.beginPath();
            ctx.arc(proj.sx, proj.sy, glowSize, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }

      for (const cluster of curClusters) {
        const idx = curClusters.indexOf(cluster);
        const angle = (idx / curClusters.length) * Math.PI * 2 + 0.3;
        const radius = 0.15 + (idx % 3) * 0.1;
        const peakNX = 0.5 + Math.cos(angle) * radius;
        const peakNZ = 0.5 + Math.sin(angle) * radius;
        const peakWorldX = peakNX * gridX * BAR_SPACING;
        const peakWorldZ = peakNZ * gridZ * BAR_SPACING;
        const peakProj = project3D(peakWorldX, 0, peakWorldZ, rotY, rotX, cx, cy, scale, gridX, gridZ);

        const rgb = hexToRgbStr(cluster.color);

        for (let ring = 1; ring <= 3; ring++) {
          const ringR = ring * 25 * zoomRef.current;
          ctx.globalAlpha = (0.2 - ring * 0.05) * heatAlpha * (cluster.factCount > 200 ? 1 : 0.5);
          ctx.strokeStyle = `rgba(${rgb}, 0.6)`;
          ctx.lineWidth = ring === 1 ? 1.2 : 0.6;
          ctx.setLineDash(ring > 1 ? [4, 4] : []);
          ctx.beginPath();
          ctx.ellipse(peakProj.sx, peakProj.sy, ringR, ringR * 0.5, 0, 0, Math.PI * 2);
          ctx.stroke();
        }
        ctx.setLineDash([]);

        ctx.globalAlpha = 0.9 * heatAlpha;
        ctx.fillStyle = '#ffffff';
        ctx.font = '700 12px -apple-system, system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(cluster.label, peakProj.sx, peakProj.sy - 4);
        ctx.fillStyle = `rgba(${rgb}, 0.85)`;
        ctx.font = '500 10px "SF Mono", monospace';
        ctx.fillText(`${cluster.factCount.toLocaleString()}`, peakProj.sx, peakProj.sy + 10);
      }

      ctx.globalAlpha = 1;
    }

    const barOpacity = 1 - heatAlpha;

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

        if (fp > 0 && curFocusCluster && cell.cluster.type === curFocusCluster.type) {
          const clusterIdx = curClusters.indexOf(curFocusCluster);
          const clusterAngle = (clusterIdx / curClusters.length) * Math.PI * 2 + 0.3;
          const clusterCX = (0.5 + Math.cos(clusterAngle) * (0.15 + (clusterIdx % 3) * 0.1)) * gridX * BAR_SPACING;
          const clusterCZ = (0.5 + Math.sin(clusterAngle) * (0.15 + (clusterIdx % 3) * 0.1)) * gridZ * BAR_SPACING;
          const dx = worldX - clusterCX;
          const dz = worldZ - clusterCZ;
          const dist = Math.sqrt(dx * dx + dz * dz);
          if (dist > 0.1) {
            const spreadAmount = fp * 2.5;
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

    if (barOpacity >= 0.01) {
      for (const bar of bars) {
        if (bar.barH < 3 || bar.cell.height < 0.15) continue;
        const reflH = bar.barH * 0.35;
        const rgb = hexToRgbStr(bar.cell.cluster.color);
        const reflAlpha = 0.08 * bar.cell.highlight * bar.cell.height;

        const reflGrad = ctx.createLinearGradient(
          bar.sx, bar.sy,
          bar.sx, bar.sy + reflH,
        );
        reflGrad.addColorStop(0, `rgba(${rgb}, ${reflAlpha})`);
        reflGrad.addColorStop(1, `rgba(${rgb}, 0)`);
        ctx.fillStyle = reflGrad;
        ctx.fillRect(bar.sx - bar.barW / 2, bar.sy, bar.barW, reflH);
      }

      const depths = bars.map(b => b.depth);
      const minDepth = Math.min(...depths);
      const maxDepth = Math.max(...depths);
      const depthRange = Math.max(maxDepth - minDepth, 1);

      for (const bar of bars) {
        const depthNorm = (bar.depth - minDepth) / depthRange;
        const fogFactor = 1 - depthNorm * 0.55;
        const alpha = (0.85 + bar.cell.height * 0.15) * fogFactor * barOpacity;
        const rgb = hexToRgbStr(bar.cell.cluster.color);

        const barGrad = ctx.createLinearGradient(bar.sx, bar.sy, bar.sx, bar.topY);
        barGrad.addColorStop(0, `rgba(${rgb}, ${0.25 * alpha * bar.cell.highlight})`);
        barGrad.addColorStop(0.35, `rgba(${rgb}, ${0.65 * alpha * bar.cell.highlight})`);
        barGrad.addColorStop(0.75, `rgba(${rgb}, ${alpha * bar.cell.highlight})`);
        barGrad.addColorStop(1, `rgba(${rgb}, ${alpha * bar.cell.highlight})`);

        ctx.fillStyle = barGrad;
        ctx.fillRect(bar.sx - bar.barW / 2, bar.topY, bar.barW, bar.barH);

        const capRgb = rgb.split(', ').map(v => Math.min(parseInt(v) + 80, 255)).join(', ');
        ctx.globalAlpha = bar.cell.highlight * fogFactor;
        ctx.fillStyle = `rgba(${capRgb}, 0.95)`;
        ctx.fillRect(bar.sx - bar.barW / 2, bar.topY, bar.barW, Math.max(1, bar.barW * 0.5));
        ctx.globalAlpha = 1;

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
    }

    // ── Connection Arcs Between Clusters ──
    const clusterPeaks = new Map<string, { sx: number; sy: number; height: number; color: string }>();
    for (const bar of bars) {
      const key = bar.cell.cluster.type;
      const existing = clusterPeaks.get(key);
      if (!existing || bar.cell.height > existing.height) {
        clusterPeaks.set(key, { sx: bar.sx, sy: bar.topY, height: bar.cell.height, color: bar.cell.cluster.color });
      }
    }

    const connections: [string, string][] = [
      ['state', 'kv'],
      ['decision', 'identity'],
      ['decision', 'preference'],
      ['config', 'state'],
      ['relationship', 'identity'],
      ['temporal', 'state'],
      ['location', 'config'],
      ['preference', 'identity'],
    ];

    for (const [typeA, typeB] of connections) {
      const peakA = clusterPeaks.get(typeA);
      const peakB = clusterPeaks.get(typeB);
      if (!peakA || !peakB) continue;
      if (peakA.height < 0.2 || peakB.height < 0.2) continue;

      const midX = (peakA.sx + peakB.sx) / 2;
      const midY = Math.min(peakA.sy, peakB.sy) - 40 - Math.min(peakA.height, peakB.height) * 30;

      const pulse = 0.5 + Math.sin(t * 0.015 + (typeA.length + typeB.length)) * 0.5;
      const arcAlpha = 0.06 + pulse * 0.06;

      ctx.lineWidth = 1.2;
      ctx.strokeStyle = `rgba(148, 163, 184, ${arcAlpha})`;
      ctx.beginPath();
      ctx.moveTo(peakA.sx, peakA.sy);
      ctx.quadraticCurveTo(midX, midY, peakB.sx, peakB.sy);
      ctx.stroke();

      const glowSize = 4;
      ctx.fillStyle = `rgba(${hexToRgbStr(peakA.color)}, ${arcAlpha * 1.5})`;
      ctx.beginPath();
      ctx.arc(peakA.sx, peakA.sy, glowSize, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = `rgba(${hexToRgbStr(peakB.color)}, ${arcAlpha * 1.5})`;
      ctx.beginPath();
      ctx.arc(peakB.sx, peakB.sy, glowSize, 0, Math.PI * 2);
      ctx.fill();

      const dotT = (Math.sin(t * 0.02 + typeA.length * 2) + 1) / 2;
      const dotX = (1 - dotT) * (1 - dotT) * peakA.sx + 2 * (1 - dotT) * dotT * midX + dotT * dotT * peakB.sx;
      const dotY = (1 - dotT) * (1 - dotT) * peakA.sy + 2 * (1 - dotT) * dotT * midY + dotT * dotT * peakB.sy;
      ctx.fillStyle = `rgba(255, 255, 255, ${arcAlpha * 2.5})`;
      ctx.beginPath();
      ctx.arc(dotX, dotY, 2, 0, Math.PI * 2);
      ctx.fill();
    }

    // ── Floating Cluster Labels ──
    const zoom = zoomRef.current;
    const labelZoomAlpha = zoom > 0.8 ? 1 : zoom < 0.55 ? 0 : (zoom - 0.55) / 0.25;
    if (labelZoomAlpha > 0) for (const [type, pos] of clusterPeaks) {
      const cluster = clusters.find(c => c.type === type);
      if (!cluster) continue;

      const labelAlpha = Math.max(0.5, 0.9 - (pos.height < 0.15 ? 0.3 : 0)) * labelZoomAlpha;
      const labelY = pos.sy - 18;

      const labelText = cluster.label;
      ctx.font = '600 11px -apple-system, system-ui, sans-serif';
      ctx.textAlign = 'center';
      const textWidth = ctx.measureText(labelText).width;

      ctx.globalAlpha = labelAlpha * 0.4;
      ctx.fillStyle = 'rgba(9, 9, 11, 0.7)';
      const padH = 4, padW = 6;
      ctx.fillRect(pos.sx - textWidth / 2 - padW, labelY - 10 - padH, textWidth + padW * 2, 24 + padH * 2);

      ctx.globalAlpha = labelAlpha;
      ctx.fillStyle = '#ffffff';
      ctx.fillText(labelText, pos.sx, labelY);

      ctx.fillStyle = `rgba(${hexToRgbStr(cluster.color)}, 0.85)`;
      ctx.font = '500 10px "SF Mono", ui-monospace, monospace';
      ctx.fillText(`${cluster.factCount.toLocaleString()} facts`, pos.sx, labelY + 13);
      ctx.globalAlpha = 1;
    }

    // ── Fact Cards (visible in focus mode) ──
    if (fp > 0.3 && curFocusFacts.length > 0 && curFocusCluster) {
      const focusPeak = clusterPeaks.get(curFocusCluster.type);
      if (focusPeak) {
        const cardAlpha = Math.min(1, (fp - 0.3) / 0.4);
        const revealTime = factRevealRef.current;
        const maxCards = Math.min(curFocusFacts.length, 12);

        for (let i = 0; i < maxCards; i++) {
          const cardDelay = i * 0.12;
          const cardProgress = Math.min(1, Math.max(0, (revealTime - cardDelay) / 0.3));
          if (cardProgress <= 0) continue;

          const fact = curFocusFacts[i];
          const rgb = hexToRgbStr(curFocusCluster.color);

          const side = i % 2 === 0 ? -1 : 1;
          const row = Math.floor(i / 2);
          const cardX = focusPeak.sx + side * (130 + row * 15) * cardProgress;
          const cardY = focusPeak.sy - 50 + row * 42;

          const cardW = 220;
          const cardH = 34;
          const cornerR = 8;

          const slideOffset = (1 - cardProgress) * 30 * side;
          const finalX = cardX + slideOffset;

          ctx.globalAlpha = cardAlpha * cardProgress * 0.92;
          ctx.fillStyle = `rgba(9, 9, 11, 0.88)`;
          ctx.beginPath();
          ctx.roundRect(finalX - cardW / 2, cardY - cardH / 2, cardW, cardH, cornerR);
          ctx.fill();

          ctx.fillStyle = `rgba(${rgb}, ${cardAlpha * cardProgress * 0.9})`;
          ctx.beginPath();
          ctx.roundRect(finalX - cardW / 2, cardY - cardH / 2, 3, cardH, [cornerR, 0, 0, cornerR]);
          ctx.fill();

          const dotRadius = 3;
          const confColor = fact.confidence > 70 ? `rgba(34, 197, 94, ${cardAlpha * cardProgress})`
            : fact.confidence > 40 ? `rgba(245, 158, 11, ${cardAlpha * cardProgress})`
            : `rgba(148, 163, 184, ${cardAlpha * cardProgress})`;
          ctx.fillStyle = confColor;
          ctx.beginPath();
          ctx.arc(finalX - cardW / 2 + 14, cardY, dotRadius, 0, Math.PI * 2);
          ctx.fill();

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

          ctx.fillStyle = '#64748b';
          ctx.font = '9px "SF Mono", ui-monospace, monospace';
          ctx.textAlign = 'right';
          ctx.fillText(`${fact.confidence.toFixed(0)}%`, finalX + cardW / 2 - 8, cardY + 3);

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

    // ── Search Result Nodes ──
    if (!curFocusCluster && searchResults.length > 0) {
      const maxVisible = Math.min(searchResults.length, 8);
      for (let i = 0; i < maxVisible; i++) {
        const r = searchResults[i];
        const matchPeak = clusterPeaks.get(r.type);
        if (!matchPeak) continue;

        const rgb = hexToRgbStr(CATEGORY_COLORS[r.type] ?? '#94a3b8');
        const nodeY = matchPeak.sy - 30 - i * 22;
        const nodeX = matchPeak.sx;

        ctx.globalAlpha = 0.85;
        ctx.fillStyle = 'rgba(9, 9, 11, 0.8)';
        const pillW = 150, pillH = 18;
        ctx.beginPath();
        ctx.roundRect(nodeX - pillW / 2, nodeY - pillH / 2, pillW, pillH, 5);
        ctx.fill();

        ctx.fillStyle = `rgba(${rgb}, 0.9)`;
        ctx.beginPath();
        ctx.arc(nodeX - pillW / 2 + 8, nodeY, 2.5, 0, Math.PI * 2);
        ctx.fill();

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
}
