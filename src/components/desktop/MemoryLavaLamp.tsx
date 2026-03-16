'use client';

/**
 * MemoryLavaLamp — Living particle visualization of Cortex memory.
 *
 * Physics model:
 * - Each particle = one fact from Cortex
 * - Y position = confidence (high confidence = heavy = sinks to bottom)
 * - Color = category (People, Decisions, Code, Projects, etc.)
 * - Movement speed = inverse confidence (important = slow, ephemeral = fast)
 * - Clusters form around related facts
 * - Lava lamp organic motion via Brownian drift + sine waves
 *
 * Inspired by Q's fluid dynamics reference image.
 */

import { memo, useCallback, useEffect, useRef, useState } from 'react';

interface CortexFact {
  text: string;
  confidence: number;
  source: string;
  category: string;
  age: number;
}

interface CategoryDef {
  label: string;
  color: string;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  color: string;
  alpha: number;
  fact: CortexFact;
  targetY: number;
  driftPhase: number;
  driftSpeed: number;
  glowIntensity: number;
}

const CATEGORY_COLORS: Record<string, string> = {
  People: '#3b82f6',
  Decisions: '#f59e0b',
  Code: '#22c55e',
  Projects: '#ef4444',
  Config: '#8b5cf6',
  Identity: '#ec4899',
  Learned: '#06b6d4',
  Tasks: '#f97316',
};

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result
    ? { r: parseInt(result[1], 16), g: parseInt(result[2], 16), b: parseInt(result[3], 16) }
    : { r: 200, g: 200, b: 200 };
}

function createParticle(fact: CortexFact, canvasW: number, canvasH: number): Particle {
  const color = CATEGORY_COLORS[fact.category] ?? '#94a3b8';
  // High confidence = low targetY (bottom). Low confidence = high targetY (top)
  const confidenceNorm = fact.confidence / 100;
  const targetY = canvasH * (1 - confidenceNorm * 0.85) - canvasH * 0.05;

  // Size: more confident = slightly larger
  const radius = 2 + confidenceNorm * 4;

  // Speed: important = slow, ephemeral = fast
  const speed = 0.15 + (1 - confidenceNorm) * 0.6;

  return {
    x: Math.random() * canvasW,
    y: targetY + (Math.random() - 0.5) * canvasH * 0.15,
    vx: (Math.random() - 0.5) * speed,
    vy: (Math.random() - 0.5) * speed * 0.5,
    radius,
    color,
    alpha: 0.4 + confidenceNorm * 0.55,
    fact,
    targetY,
    driftPhase: Math.random() * Math.PI * 2,
    driftSpeed: 0.003 + Math.random() * 0.008,
    glowIntensity: confidenceNorm,
  };
}

export const MemoryLavaLamp = memo(function MemoryLavaLamp() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const particlesRef = useRef<Particle[]>([]);
  const animRef = useRef<number>(0);
  const mouseRef = useRef<{ x: number; y: number; active: boolean }>({ x: 0, y: 0, active: false });
  const tooltipRef = useRef<{ fact: CortexFact | null; x: number; y: number }>({ fact: null, x: 0, y: 0 });

  const [categories, setCategories] = useState<CategoryDef[]>([]);
  const [stats, setStats] = useState({ totalFacts: 0, activeFacts: 0 });
  const [hoveredFact, setHoveredFact] = useState<CortexFact | null>(null);
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 });
  const [loading, setLoading] = useState(true);

  // Fetch data
  useEffect(() => {
    let cancelled = false;
    fetch('/api/panel/cortex-facts')
      .then(r => r.json())
      .then(data => {
        if (cancelled) return;
        const facts: CortexFact[] = data.facts ?? [];
        setCategories(data.categories ?? []);
        setStats(data.stats ?? { totalFacts: 0, activeFacts: 0 });

        const canvas = canvasRef.current;
        if (!canvas) return;
        const w = canvas.width;
        const h = canvas.height;

        particlesRef.current = facts.map(f => createParticle(f, w, h));
        setLoading(false);
      })
      .catch(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  // Resize
  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;

    const ro = new ResizeObserver(entries => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        canvas.width = width * window.devicePixelRatio;
        canvas.height = height * window.devicePixelRatio;
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;

        // Recalculate target positions
        for (const p of particlesRef.current) {
          const confidenceNorm = p.fact.confidence / 100;
          p.targetY = canvas.height * (1 - confidenceNorm * 0.85) - canvas.height * 0.05;
        }
      }
    });
    ro.observe(container);
    return () => ro.disconnect();
  }, []);

  // Mouse interaction
  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio;
    const mx = (e.clientX - rect.left) * dpr;
    const my = (e.clientY - rect.top) * dpr;
    mouseRef.current = { x: mx, y: my, active: true };

    // Find closest particle
    let closest: Particle | null = null;
    let closestDist = 30 * dpr;
    for (const p of particlesRef.current) {
      const dx = p.x - mx;
      const dy = p.y - my;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < closestDist) {
        closest = p;
        closestDist = dist;
      }
    }

    if (closest) {
      tooltipRef.current = { fact: closest.fact, x: e.clientX, y: e.clientY };
      setHoveredFact(closest.fact);
      setTooltipPos({ x: e.clientX, y: e.clientY });
    } else {
      tooltipRef.current = { fact: null, x: 0, y: 0 };
      setHoveredFact(null);
    }
  }, []);

  const handleMouseLeave = useCallback(() => {
    mouseRef.current.active = false;
    setHoveredFact(null);
  }, []);

  // Animation loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let time = 0;

    function animate() {
      if (!ctx || !canvas) return;
      const w = canvas.width;
      const h = canvas.height;
      const dpr = window.devicePixelRatio;

      // Clear with dark background
      ctx.fillStyle = '#0a0e1a';
      ctx.fillRect(0, 0, w, h);

      // Draw cylinder boundary (subtle)
      const cylMargin = w * 0.08;
      const cylTop = h * 0.03;
      const cylBottom = h * 0.97;
      const cylLeft = cylMargin;
      const cylRight = w - cylMargin;

      ctx.strokeStyle = 'rgba(148, 163, 184, 0.08)';
      ctx.lineWidth = 1 * dpr;
      ctx.beginPath();
      ctx.moveTo(cylLeft, cylTop);
      ctx.lineTo(cylLeft, cylBottom);
      ctx.moveTo(cylRight, cylTop);
      ctx.lineTo(cylRight, cylBottom);
      // Top ellipse
      ctx.ellipse((cylLeft + cylRight) / 2, cylTop, (cylRight - cylLeft) / 2, h * 0.025, 0, 0, Math.PI * 2);
      ctx.moveTo(cylRight, cylBottom);
      // Bottom ellipse
      ctx.ellipse((cylLeft + cylRight) / 2, cylBottom, (cylRight - cylLeft) / 2, h * 0.025, 0, 0, Math.PI * 2);
      ctx.stroke();

      const particles = particlesRef.current;
      time += 1;

      // Update particles
      for (const p of particles) {
        // Lava lamp drift — sine wave organic motion
        p.driftPhase += p.driftSpeed;
        const driftX = Math.sin(p.driftPhase) * 0.8;
        const driftY = Math.cos(p.driftPhase * 0.7 + p.x * 0.001) * 0.3;

        // Gravity: pull toward target Y (confidence-based)
        const gravityForce = (p.targetY - p.y) * 0.003;

        // Brownian motion
        const brownX = (Math.random() - 0.5) * 0.4;
        const brownY = (Math.random() - 0.5) * 0.3;

        // Apply forces
        p.vx += driftX * 0.02 + brownX * 0.1;
        p.vy += gravityForce + driftY * 0.02 + brownY * 0.1;

        // Damping
        p.vx *= 0.97;
        p.vy *= 0.97;

        // Move
        p.x += p.vx;
        p.y += p.vy;

        // Cylinder bounds (soft bounce)
        if (p.x < cylLeft + p.radius) { p.x = cylLeft + p.radius; p.vx *= -0.5; }
        if (p.x > cylRight - p.radius) { p.x = cylRight - p.radius; p.vx *= -0.5; }
        if (p.y < cylTop + p.radius) { p.y = cylTop + p.radius; p.vy *= -0.3; }
        if (p.y > cylBottom - p.radius) { p.y = cylBottom - p.radius; p.vy *= -0.3; }

        // Mouse repulsion (gentle push)
        if (mouseRef.current.active) {
          const dx = p.x - mouseRef.current.x;
          const dy = p.y - mouseRef.current.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < 60 * dpr && dist > 0) {
            const force = (60 * dpr - dist) / (60 * dpr) * 0.8;
            p.vx += (dx / dist) * force;
            p.vy += (dy / dist) * force;
          }
        }
      }

      // Draw particles with glow
      for (const p of particles) {
        const rgb = hexToRgb(p.color);
        const r = p.radius * dpr;

        // Glow
        if (p.glowIntensity > 0.5) {
          const gradient = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r * 4);
          gradient.addColorStop(0, `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${p.alpha * 0.3})`);
          gradient.addColorStop(1, `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0)`);
          ctx.fillStyle = gradient;
          ctx.beginPath();
          ctx.arc(p.x, p.y, r * 4, 0, Math.PI * 2);
          ctx.fill();
        }

        // Core particle
        ctx.fillStyle = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${p.alpha})`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.fill();

        // Bright center dot
        ctx.fillStyle = `rgba(${Math.min(rgb.r + 80, 255)}, ${Math.min(rgb.g + 80, 255)}, ${Math.min(rgb.b + 80, 255)}, ${p.alpha * 0.8})`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r * 0.4, 0, Math.PI * 2);
        ctx.fill();
      }

      animRef.current = requestAnimationFrame(animate);
    }

    animRef.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(animRef.current);
  }, [loading]);

  if (loading) {
    return (
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%',
        background: '#0a0e1a',
        color: '#94a3b8',
        fontSize: 13,
      }}>
        Loading Cortex memory…
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      style={{
        position: 'relative',
        width: '100%',
        height: '100%',
        background: '#0a0e1a',
        overflow: 'hidden',
      }}
    >
      <canvas
        ref={canvasRef}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
        style={{
          width: '100%',
          height: '100%',
          cursor: hoveredFact ? 'pointer' : 'default',
        }}
      />

      {/* Legend — right side */}
      <div style={{
        position: 'absolute',
        top: 16,
        right: 16,
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        padding: 12,
        borderRadius: 10,
        background: 'rgba(10, 14, 26, 0.85)',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
        border: '1px solid rgba(148, 163, 184, 0.1)',
      }}>
        <div style={{ fontSize: 10, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 2 }}>
          Memory Categories
        </div>
        {categories.map(cat => (
          <div key={cat.label} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{
              width: 8,
              height: 8,
              borderRadius: 4,
              background: cat.color,
              boxShadow: `0 0 6px ${cat.color}60`,
              flexShrink: 0,
            }} />
            <span style={{ fontSize: 11, color: '#cbd5e1', fontWeight: 400 }}>{cat.label}</span>
          </div>
        ))}
      </div>

      {/* Gravity scale — right side below legend */}
      <div style={{
        position: 'absolute',
        bottom: 16,
        right: 16,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 4,
        padding: 10,
        borderRadius: 10,
        background: 'rgba(10, 14, 26, 0.85)',
        border: '1px solid rgba(148, 163, 184, 0.1)',
      }}>
        <span style={{ fontSize: 9, color: '#64748b', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Confidence</span>
        <div style={{
          width: 8,
          height: 80,
          borderRadius: 4,
          background: 'linear-gradient(to bottom, rgba(148,163,184,0.2), #ef4444, #f59e0b, #22c55e)',
        }} />
        <span style={{ fontSize: 9, color: '#94a3b8' }}>Fresh</span>
        <span style={{ fontSize: 9, color: '#22c55e', fontWeight: 600 }}>Core</span>
      </div>

      {/* Stats */}
      <div style={{
        position: 'absolute',
        bottom: 16,
        left: 16,
        display: 'flex',
        gap: 16,
        paddingTop: 8,
        paddingRight: 14,
        paddingBottom: 8,
        paddingLeft: 14,
        borderRadius: 10,
        background: 'rgba(10, 14, 26, 0.85)',
        border: '1px solid rgba(148, 163, 184, 0.1)',
      }}>
        <div>
          <div style={{ fontSize: 16, fontWeight: 700, color: '#e2e8f0', fontFamily: '"SF Mono", ui-monospace, monospace' }}>
            {stats.totalFacts.toLocaleString()}
          </div>
          <div style={{ fontSize: 9, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Total Facts</div>
        </div>
        <div>
          <div style={{ fontSize: 16, fontWeight: 700, color: '#22c55e', fontFamily: '"SF Mono", ui-monospace, monospace' }}>
            {stats.activeFacts.toLocaleString()}
          </div>
          <div style={{ fontSize: 9, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Active</div>
        </div>
        <div>
          <div style={{ fontSize: 16, fontWeight: 700, color: '#3b82f6', fontFamily: '"SF Mono", ui-monospace, monospace' }}>
            {particlesRef.current.length}
          </div>
          <div style={{ fontSize: 9, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Rendered</div>
        </div>
      </div>

      {/* Title */}
      <div style={{
        position: 'absolute',
        top: 16,
        left: 16,
        fontSize: 13,
        fontWeight: 700,
        color: '#e2e8f0',
        letterSpacing: '-0.01em',
      }}>
        Cortex Memory
        <span style={{ fontSize: 10, fontWeight: 400, color: '#64748b', marginLeft: 8 }}>
          Living Knowledge
        </span>
      </div>

      {/* Hover tooltip */}
      {hoveredFact && (
        <div style={{
          position: 'fixed',
          left: tooltipPos.x + 16,
          top: tooltipPos.y - 10,
          maxWidth: 320,
          paddingTop: 10,
          paddingRight: 14,
          paddingBottom: 10,
          paddingLeft: 14,
          borderRadius: 10,
          background: 'rgba(10, 14, 26, 0.95)',
          backdropFilter: 'blur(16px)',
          WebkitBackdropFilter: 'blur(16px)',
          border: '1px solid rgba(148, 163, 184, 0.15)',
          boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
          zIndex: 99999,
          pointerEvents: 'none',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
            <div style={{
              width: 8,
              height: 8,
              borderRadius: 4,
              background: CATEGORY_COLORS[hoveredFact.category] ?? '#94a3b8',
              boxShadow: `0 0 6px ${CATEGORY_COLORS[hoveredFact.category] ?? '#94a3b8'}60`,
            }} />
            <span style={{ fontSize: 10, fontWeight: 600, color: CATEGORY_COLORS[hoveredFact.category] ?? '#94a3b8' }}>
              {hoveredFact.category}
            </span>
            <span style={{ fontSize: 10, color: '#64748b', marginLeft: 'auto' }}>
              {hoveredFact.confidence.toFixed(0)}% confidence
            </span>
          </div>
          <div style={{ fontSize: 12, color: '#e2e8f0', lineHeight: 1.5 }}>
            {hoveredFact.text}
          </div>
          <div style={{ fontSize: 10, color: '#475569', marginTop: 4, fontFamily: '"SF Mono", ui-monospace, monospace' }}>
            {hoveredFact.source}
          </div>
        </div>
      )}
    </div>
  );
});
