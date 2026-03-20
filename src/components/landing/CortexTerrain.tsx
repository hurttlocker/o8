"use client";

import { useRef, useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";

/* ─────────────────────── CONFIG ─────────────────────── */

const GRID_X = 160;
const GRID_Z = 90;
const BAR_SPACING = 4.5;
const MAX_HEIGHT = 300;
const BASE_BAR_WIDTH = 3.0;

// Color stops tuned for the cream page background: cream/lilac base → coral/orange → green peak
function heightColor(t: number): string {
  if (t < 0.18) {
    const s = t / 0.18;
    const r = Math.floor(239 - s * 42);
    const g = Math.floor(231 - s * 62);
    const b = Math.floor(211 + s * 24);
    return `rgb(${r},${g},${b})`;
  }
  if (t < 0.4) {
    const s = (t - 0.18) / 0.22;
    const r = Math.floor(197 + s * 40);
    const g = Math.floor(169 - s * 28);
    const b = Math.floor(235 - s * 31);
    return `rgb(${r},${g},${b})`;
  }
  if (t < 0.62) {
    const s = (t - 0.4) / 0.22;
    const r = Math.floor(237 + s * 18);
    const g = Math.floor(141 + s * 55);
    const b = Math.floor(204 - s * 112);
    return `rgb(${r},${g},${b})`;
  }
  if (t < 0.82) {
    const s = (t - 0.62) / 0.2;
    const r = Math.floor(255 - s * 58);
    const g = Math.floor(196 + s * 41);
    const b = Math.floor(92 + s * 74);
    return `rgb(${r},${g},${b})`;
  }
  const s = (t - 0.82) / 0.18;
  const r = Math.floor(197 + s * 42);
  const g = Math.floor(237 + s * 18);
  const b = Math.floor(166 + s * 45);
  return `rgb(${r},${g},${b})`;
}

/* ─────────────────────── TERRAIN GENERATION ─────────────────────── */

interface TerrainCell {
  x: number;
  z: number;
  height: number;          // 0..1 normalized
  rawHeight: number;       // pixel height
  category: string;
  label: string;
  color: string;
  glowIntensity: number;
}

function generateTerrain(): TerrainCell[][] {
  const grid: TerrainCell[][] = [];

  // Create multiple gaussian peaks to simulate data clusters
  const peaks = [
    { cx: 0.45, cz: 0.5, sigma: 0.12, amp: 1.0, cat: "memory", label: "Cortex Memory" },
    { cx: 0.3, cz: 0.35, sigma: 0.09, amp: 0.75, cat: "agent", label: "Agent Fleet" },
    { cx: 0.65, cz: 0.6, sigma: 0.1, amp: 0.85, cat: "decision", label: "Decisions" },
    { cx: 0.2, cz: 0.65, sigma: 0.08, amp: 0.6, cat: "tool", label: "Tools" },
    { cx: 0.75, cz: 0.3, sigma: 0.07, amp: 0.55, cat: "project", label: "Projects" },
    { cx: 0.55, cz: 0.25, sigma: 0.06, amp: 0.45, cat: "identity", label: "Identity" },
    { cx: 0.15, cz: 0.45, sigma: 0.065, amp: 0.4, cat: "config", label: "Config" },
    { cx: 0.8, cz: 0.7, sigma: 0.08, amp: 0.5, cat: "knowledge", label: "Knowledge Graph" },
  ];

  for (let ix = 0; ix < GRID_X; ix++) {
    const row: TerrainCell[] = [];
    for (let iz = 0; iz < GRID_Z; iz++) {
      const nx = ix / GRID_X;
      const nz = iz / GRID_Z;

      let maxVal = 0;
      let bestPeak = peaks[0];

      for (const peak of peaks) {
        const dx = nx - peak.cx;
        const dz = nz - peak.cz;
        const dist = Math.sqrt(dx * dx + dz * dz);
        const val = peak.amp * Math.exp(-(dist * dist) / (2 * peak.sigma * peak.sigma));
        if (val > maxVal) {
          maxVal = val;
          bestPeak = peak;
        }
      }

      // Add perlin-like noise for organic texture
      const noise = (Math.sin(ix * 0.8 + iz * 0.5) * 0.5 + Math.cos(ix * 0.3 + iz * 1.2) * 0.3 + Math.sin(ix * 2.1 + iz * 0.7) * 0.2) * 0.15;
      const jitter = Math.random() * 0.08;
      const height = Math.max(0, Math.min(1, maxVal + noise * maxVal + jitter * maxVal));

      const rawHeight = height * MAX_HEIGHT;
      const color = heightColor(height);

      row.push({
        x: ix,
        z: iz,
        height,
        rawHeight,
        category: bestPeak.cat,
        label: bestPeak.label,
        color,
        glowIntensity: height > 0.7 ? (height - 0.7) / 0.3 : 0,
      });
    }
    grid.push(row);
  }

  return grid;
}

/* ─────────────────────── PARTICLE STREAMS ─────────────────────── */

interface Particle {
  x: number;
  y: number;
  z: number;
  vy: number;
  life: number;
  maxLife: number;
  color: string;
  size: number;
}

function spawnParticles(terrain: TerrainCell[][], count: number): Particle[] {
  const particles: Particle[] = [];
  for (let i = 0; i < count; i++) {
    const ix = Math.floor(Math.random() * GRID_X);
    const iz = Math.floor(Math.random() * GRID_Z);
    const cell = terrain[ix][iz];
    if (cell.height < 0.3) continue; // Only emit from active regions

    particles.push({
      x: ix * BAR_SPACING + (Math.random() - 0.5) * BAR_SPACING,
      y: -cell.rawHeight - Math.random() * 20,
      z: iz * BAR_SPACING + (Math.random() - 0.5) * BAR_SPACING,
      vy: -(0.3 + Math.random() * 0.8),
      life: 0,
      maxLife: 60 + Math.random() * 120,
      color: cell.color,
      size: 1 + Math.random() * 2,
    });
  }
  return particles;
}

/* ─────────────────────── ISOMETRIC PROJECTION ─────────────────────── */

function project3D(
  x: number, y: number, z: number,
  rotY: number, rotX: number,
  cx: number, cy: number, scale: number
): { sx: number; sy: number; depth: number } {
  // Center the grid
  const halfW = (GRID_X * BAR_SPACING) / 2;
  const halfD = (GRID_Z * BAR_SPACING) / 2;
  const px = x - halfW;
  const py = y;
  const pz = z - halfD;

  // Rotate Y (horizontal orbit)
  const cosY = Math.cos(rotY);
  const sinY = Math.sin(rotY);
  const rx = px * cosY - pz * sinY;
  const rz = px * sinY + pz * cosY;

  // Rotate X (vertical tilt)
  const cosX = Math.cos(rotX);
  const sinX = Math.sin(rotX);
  const ry = py * cosX - rz * sinX;
  const rz2 = py * sinX + rz * cosX;

  // Perspective
  const perspective = 1200;
  const s = perspective / (perspective + rz2 + 600);

  return {
    sx: cx + rx * s * scale,
    sy: cy + ry * s * scale,
    depth: rz2,
  };
}

/* ─────────────────────── HOVER INFO ─────────────────────── */

interface HoverInfo {
  label: string;
  category: string;
  height: number;
  color: string;
  screenX: number;
  screenY: number;
}

/* ─────────────────────── MAIN COMPONENT ─────────────────────── */

export default function CortexTerrain() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const terrainRef = useRef<TerrainCell[][]>(generateTerrain());
  const particlesRef = useRef<Particle[]>([]);
  const mouseRef = useRef({ x: 0, y: 0, active: false });
  const rotRef = useRef({ y: -0.6, x: -0.55 });
  const targetRotRef = useRef({ y: -0.6, x: -0.55 });
  const frameRef = useRef<number>(0);
  const timeRef = useRef<number>(0);
  const [hoverInfo, setHoverInfo] = useState<HoverInfo | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return;

    let animating = true;
    let lastParticleSpawn = 0;

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      // Force canvas to fill parent — getBoundingClientRect can return 0 if parent isn't sized yet
      const parent = canvas.parentElement;
      const w = parent ? parent.clientWidth : window.innerWidth;
      const h = parent ? parent.clientHeight : window.innerHeight;
      canvas.style.width = w + "px";
      canvas.style.height = h + "px";
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    // Delay first resize to let layout settle
    requestAnimationFrame(resize);
    window.addEventListener("resize", resize);

    const handleMouse = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      mouseRef.current = { x, y, active: true };

      // Subtle rotation influence from mouse position
      targetRotRef.current.y = -0.6 + (x / rect.width - 0.5) * 0.4;
      targetRotRef.current.x = -0.55 + (y / rect.height - 0.5) * 0.2;
    };

    const handleLeave = () => {
      mouseRef.current.active = false;
      targetRotRef.current.y = -0.6;
      targetRotRef.current.x = -0.55;
      setHoverInfo(null);
    };

    canvas.addEventListener("mousemove", handleMouse);
    canvas.addEventListener("mouseleave", handleLeave);

    function animate() {
      if (!animating || !ctx || !canvas) return;
      timeRef.current++;
      const t = timeRef.current;

      const rect = canvas.getBoundingClientRect();
      const w = rect.width;
      const h = rect.height;
      const cx = w / 2;
      const cy = h * 0.72;
      const scale = Math.max(w, h) / 580; // Scale to largest dimension — fills widescreen

      // Smooth rotation lerp
      rotRef.current.y += (targetRotRef.current.y - rotRef.current.y) * 0.03;
      rotRef.current.x += (targetRotRef.current.x - rotRef.current.x) * 0.03;

      // Gentle auto-orbit
      if (!mouseRef.current.active) {
        targetRotRef.current.y = -0.6 + Math.sin(t * 0.003) * 0.15;
      }

      // Keep the canvas transparent so the page background shows through.
      ctx.clearRect(0, 0, w, h);

      const terrain = terrainRef.current;
      const rotY = rotRef.current.y;
      const rotX = rotRef.current.x;

      // Collect all bars with projected positions for depth sorting
      const bars: {
        sx: number; sy: number; depth: number;
        barH: number; barW: number;
        color: string; cell: TerrainCell;
        topY: number;
      }[] = [];

      for (let ix = 0; ix < GRID_X; ix++) {
        for (let iz = 0; iz < GRID_Z; iz++) {
          const cell = terrain[ix][iz];
          if (cell.rawHeight < 12 || cell.height < 0.18) continue;

          const worldX = ix * BAR_SPACING;
          const worldZ = iz * BAR_SPACING;

          // Breathing animation on tall bars
          const breathe = cell.height > 0.5 ?
            Math.sin(t * 0.02 + ix * 0.1 + iz * 0.15) * 3 * cell.height : 0;
          const animHeight = cell.rawHeight + breathe;

          const base = project3D(worldX, 0, worldZ, rotY, rotX, cx, cy, scale);
          const top = project3D(worldX, -animHeight, worldZ, rotY, rotX, cx, cy, scale);

          const barH = base.sy - top.sy;
          if (barH < 0.5) continue;

          const perspective = 1200 / (1200 + base.depth + 600);
          const barW = BASE_BAR_WIDTH * perspective * scale;

          bars.push({
            sx: base.sx, sy: base.sy, depth: base.depth,
            barH, barW,
            color: cell.color, cell,
            topY: top.sy,
          });
        }
      }

      // Depth sort (back to front)
      bars.sort((a, b) => b.depth - a.depth);

      // Draw bars
      let closestHover: typeof bars[0] | null = null;
      let closestDist = 20;

      for (const bar of bars) {
        const barAlpha = Math.max(0, (bar.cell.height - 0.18) / 0.82);
        if (barAlpha <= 0.01) continue;

        // Bar body
        ctx.fillStyle = bar.color;
        ctx.globalAlpha = 0.18 + barAlpha * 0.74;
        ctx.fillRect(
          bar.sx - bar.barW / 2,
          bar.topY,
          bar.barW,
          bar.barH
        );

        // Top cap (brighter)
        ctx.globalAlpha = 0.3 + barAlpha * 0.7;
        ctx.fillStyle = bar.color;
        ctx.fillRect(
          bar.sx - bar.barW / 2,
          bar.topY,
          bar.barW,
          Math.max(1, bar.barW * 0.6)
        );

        // Peak glow for tall bars
        if (bar.cell.glowIntensity > 0) {
          const glowR = 8 + bar.cell.glowIntensity * 15;
          const grad = ctx.createRadialGradient(
            bar.sx, bar.topY, 0,
            bar.sx, bar.topY, glowR * scale
          );
          grad.addColorStop(0, bar.color.replace("rgb", "rgba").replace(")", `,${0.4 * bar.cell.glowIntensity})`));
          grad.addColorStop(1, "transparent");
          ctx.fillStyle = grad;
          ctx.beginPath();
          ctx.arc(bar.sx, bar.topY, glowR * scale, 0, Math.PI * 2);
          ctx.fill();
        }

        // Hover detection
        if (mouseRef.current.active) {
          const dx = mouseRef.current.x - bar.sx;
          const dy = mouseRef.current.y - bar.topY;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < closestDist && bar.cell.height > 0.15) {
            closestDist = dist;
            closestHover = bar;
          }
        }
      }

      ctx.globalAlpha = 1;

      // Vertical light lines from peaks (like image 1)
      for (const bar of bars) {
        if (bar.cell.height > 0.6) {
          const lineAlpha = (bar.cell.height - 0.6) * 0.15;
          ctx.strokeStyle = bar.color.replace("rgb", "rgba").replace(")", `,${lineAlpha})`);
          ctx.lineWidth = 0.5;
          ctx.beginPath();
          ctx.moveTo(bar.sx, bar.topY);
          ctx.lineTo(bar.sx, bar.topY - 40 - bar.cell.height * 80);
          ctx.stroke();
        }
      }

      // Spawn and draw particles (ascending streams like image 2)
      if (t - lastParticleSpawn > 3) {
        const newParticles = spawnParticles(terrain, 8);
        particlesRef.current.push(...newParticles);
        lastParticleSpawn = t;
      }

      const aliveParticles: Particle[] = [];
      for (const p of particlesRef.current) {
        p.life++;
        p.y += p.vy;
        p.x += Math.sin(p.life * 0.05 + p.x * 0.01) * 0.3;

        if (p.life > p.maxLife) continue;

        const proj = project3D(p.x, p.y, p.z, rotY, rotX, cx, cy, scale);
        const lifeRatio = p.life / p.maxLife;
        const alpha = lifeRatio < 0.1 ? lifeRatio * 10 : lifeRatio > 0.7 ? (1 - lifeRatio) / 0.3 : 1;

        ctx.globalAlpha = alpha * 0.6;
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(proj.sx, proj.sy, p.size * (1200 / (1200 + proj.depth + 600)), 0, Math.PI * 2);
        ctx.fill();

        aliveParticles.push(p);
      }
      particlesRef.current = aliveParticles;
      ctx.globalAlpha = 1;

      // Update hover state
      if (closestHover) {
        setHoverInfo({
          label: closestHover.cell.label,
          category: closestHover.cell.category,
          height: closestHover.cell.height,
          color: closestHover.cell.color,
          screenX: closestHover.sx,
          screenY: closestHover.topY,
        });
      } else if (mouseRef.current.active) {
        setHoverInfo(null);
      }

      frameRef.current = requestAnimationFrame(animate);
    }

    frameRef.current = requestAnimationFrame(animate);

    return () => {
      animating = false;
      cancelAnimationFrame(frameRef.current);
      window.removeEventListener("resize", resize);
      canvas.removeEventListener("mousemove", handleMouse);
      canvas.removeEventListener("mouseleave", handleLeave);
    };
  }, []);

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      <canvas
        ref={canvasRef}
        style={{ display: "block", width: "100%", height: "100%", cursor: "crosshair" }}
      />

      {/* Hover tooltip */}
      <AnimatePresence>
        {hoverInfo && (
          <motion.div
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.9 }}
            style={{
              position: "absolute",
              zIndex: 20,
              pointerEvents: "none",
              borderRadius: 10,
              border: `1px solid ${hoverInfo.color}40`,
              padding: "8px 14px",
              left: Math.min(hoverInfo.screenX + 16, (typeof window !== 'undefined' ? window.innerWidth - 220 : 400)),
              top: hoverInfo.screenY - 10,
              background: "rgba(239, 231, 211, 0.92)",
              backdropFilter: "blur(10px)",
              boxShadow: `0 0 24px ${hoverInfo.color}15`,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div style={{ width: 8, height: 8, borderRadius: "50%", background: hoverInfo.color, boxShadow: `0 0 8px ${hoverInfo.color}` }} />
              <span style={{ fontSize: 13, fontWeight: 600, color: "#1A0089" }}>{hoverInfo.label}</span>
            </div>
            <div style={{ marginTop: 2, fontSize: 11, color: "rgba(26, 0, 137, 0.62)" }}>
              {hoverInfo.category} · density {Math.round(hoverInfo.height * 100)}%
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
