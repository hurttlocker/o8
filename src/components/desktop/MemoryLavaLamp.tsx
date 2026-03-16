'use client';

/**
 * MemoryLavaLamp — Living particle visualization of Cortex memory.
 *
 * Physics: lava lamp motion where heavy/important facts sink, fresh facts float.
 * Colors match category. Click any node for detail panel. Hover for tooltip.
 * 
 * Inspired by Q's fluid dynamics reference image.
 */

import { memo, useCallback, useEffect, useRef, useState } from 'react';

interface CortexFact {
  text: string;
  confidence: number;
  source: string;
  category: string;
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
  const confidenceNorm = Math.max(0.05, Math.min(fact.confidence / 100, 1));

  // High confidence → bottom (heavy), low confidence → top (light/fresh)
  const targetY = canvasH * (1 - confidenceNorm * 0.8) - canvasH * 0.08;

  // Size: confident = larger (3-8px range)
  const radius = 3 + confidenceNorm * 5;

  // Speed: important = slow, ephemeral = fast
  const speed = 0.2 + (1 - confidenceNorm) * 0.8;

  return {
    x: canvasW * 0.15 + Math.random() * canvasW * 0.7,
    y: targetY + (Math.random() - 0.5) * canvasH * 0.2,
    vx: (Math.random() - 0.5) * speed,
    vy: (Math.random() - 0.5) * speed * 0.3,
    radius,
    color,
    alpha: 0.5 + confidenceNorm * 0.45,
    fact,
    targetY,
    driftPhase: Math.random() * Math.PI * 2,
    driftSpeed: 0.002 + Math.random() * 0.006,
    glowIntensity: confidenceNorm,
  };
}

export const MemoryLavaLamp = memo(function MemoryLavaLamp() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const particlesRef = useRef<Particle[]>([]);
  const animRef = useRef<number>(0);
  const mouseRef = useRef<{ x: number; y: number; active: boolean }>({ x: 0, y: 0, active: false });
  const factsRef = useRef<CortexFact[]>([]);
  const initDoneRef = useRef(false);

  const [categories, setCategories] = useState<CategoryDef[]>([]);
  const [stats, setStats] = useState({ totalFacts: 0, activeFacts: 0, totalMemories: 0 });
  const [hoveredFact, setHoveredFact] = useState<CortexFact | null>(null);
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 });
  const [selectedFact, setSelectedFact] = useState<CortexFact | null>(null);
  const [loading, setLoading] = useState(true);

  // Fetch
  useEffect(() => {
    let cancelled = false;
    fetch('/api/panel/cortex-facts')
      .then(r => r.json())
      .then(data => {
        if (cancelled) return;
        factsRef.current = data.facts ?? [];
        setCategories(data.categories ?? []);
        setStats(data.stats ?? { totalFacts: 0, activeFacts: 0, totalMemories: 0 });
        setLoading(false);
      })
      .catch(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  // Init particles after canvas + data both ready
  useEffect(() => {
    if (loading || initDoneRef.current) return;
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;

    const rect = container.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;

    const dpr = window.devicePixelRatio || 1;
    const w = rect.width * dpr;
    const h = rect.height * dpr;
    canvas.width = w;
    canvas.height = h;
    canvas.style.width = `${rect.width}px`;
    canvas.style.height = `${rect.height}px`;

    particlesRef.current = factsRef.current.map(f => createParticle(f, w, h));
    initDoneRef.current = true;
  }, [loading]);

  // Resize
  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;

    const ro = new ResizeObserver(entries => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        const dpr = window.devicePixelRatio || 1;
        canvas.width = width * dpr;
        canvas.height = height * dpr;
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;
        for (const p of particlesRef.current) {
          const cn = Math.max(0.05, p.fact.confidence / 100);
          p.targetY = canvas.height * (1 - cn * 0.8) - canvas.height * 0.08;
        }
      }
    });
    ro.observe(container);
    return () => ro.disconnect();
  }, []);

  // Mouse
  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const mx = (e.clientX - rect.left) * dpr;
    const my = (e.clientY - rect.top) * dpr;
    mouseRef.current = { x: mx, y: my, active: true };

    let closest: Particle | null = null;
    let closestDist = 25 * dpr;
    for (const p of particlesRef.current) {
      const dx = p.x - mx;
      const dy = p.y - my;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < closestDist) { closest = p; closestDist = dist; }
    }

    if (closest) {
      setHoveredFact(closest.fact);
      setTooltipPos({ x: e.clientX, y: e.clientY });
    } else {
      setHoveredFact(null);
    }
  }, []);

  const handleMouseLeave = useCallback(() => {
    mouseRef.current.active = false;
    setHoveredFact(null);
  }, []);

  const handleClick = useCallback((e: React.MouseEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const mx = (e.clientX - rect.left) * dpr;
    const my = (e.clientY - rect.top) * dpr;

    let closest: Particle | null = null;
    let closestDist = 25 * dpr;
    for (const p of particlesRef.current) {
      const dx = p.x - mx;
      const dy = p.y - my;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < closestDist) { closest = p; closestDist = dist; }
    }

    setSelectedFact(closest ? closest.fact : null);
  }, []);

  // Animation
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    function animate() {
      if (!ctx || !canvas) return;
      const w = canvas.width;
      const h = canvas.height;
      const dpr = window.devicePixelRatio || 1;

      // Dark gradient background
      const bg = ctx.createLinearGradient(0, 0, 0, h);
      bg.addColorStop(0, '#060a14');
      bg.addColorStop(0.5, '#0a0e1a');
      bg.addColorStop(1, '#0d1220');
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, w, h);

      // Subtle heat gradient at bottom (warm glow where heavy facts are)
      const heatGlow = ctx.createRadialGradient(w / 2, h, 0, w / 2, h, h * 0.5);
      heatGlow.addColorStop(0, 'rgba(239, 68, 68, 0.04)');
      heatGlow.addColorStop(1, 'rgba(239, 68, 68, 0)');
      ctx.fillStyle = heatGlow;
      ctx.fillRect(0, h * 0.5, w, h * 0.5);

      // Cool glow at top
      const coolGlow = ctx.createRadialGradient(w / 2, 0, 0, w / 2, 0, h * 0.4);
      coolGlow.addColorStop(0, 'rgba(6, 182, 212, 0.03)');
      coolGlow.addColorStop(1, 'rgba(6, 182, 212, 0)');
      ctx.fillStyle = coolGlow;
      ctx.fillRect(0, 0, w, h * 0.4);

      const particles = particlesRef.current;

      // Update physics
      for (let i = 0; i < particles.length; i++) {
        const p = particles[i];

        // Lava lamp drift
        p.driftPhase += p.driftSpeed;
        const driftX = Math.sin(p.driftPhase) * 1.0;
        const driftY = Math.cos(p.driftPhase * 0.7 + p.x * 0.0005) * 0.4;

        // Gravity toward target Y
        const gravityForce = (p.targetY - p.y) * 0.004;

        // Brownian noise
        const bx = (Math.random() - 0.5) * 0.5;
        const by = (Math.random() - 0.5) * 0.35;

        // Cluster attraction — nearby same-category particles attract gently
        let clusterX = 0, clusterY = 0;
        for (let j = i + 1; j < particles.length && j < i + 20; j++) {
          const other = particles[j];
          if (other.fact.category !== p.fact.category) continue;
          const dx = other.x - p.x;
          const dy = other.y - p.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist > 10 * dpr && dist < 120 * dpr) {
            const attract = 0.0003 / Math.max(dist / dpr, 1);
            clusterX += dx * attract;
            clusterY += dy * attract;
          }
        }

        p.vx += driftX * 0.015 + bx * 0.08 + clusterX;
        p.vy += gravityForce + driftY * 0.015 + by * 0.08 + clusterY;

        // Damping
        p.vx *= 0.965;
        p.vy *= 0.965;

        p.x += p.vx;
        p.y += p.vy;

        // Bounds
        const margin = w * 0.06;
        if (p.x < margin + p.radius) { p.x = margin + p.radius; p.vx *= -0.4; }
        if (p.x > w - margin - p.radius) { p.x = w - margin - p.radius; p.vx *= -0.4; }
        if (p.y < h * 0.02 + p.radius) { p.y = h * 0.02 + p.radius; p.vy *= -0.3; }
        if (p.y > h * 0.98 - p.radius) { p.y = h * 0.98 - p.radius; p.vy *= -0.3; }

        // Mouse repulsion
        if (mouseRef.current.active) {
          const dx = p.x - mouseRef.current.x;
          const dy = p.y - mouseRef.current.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < 80 * dpr && dist > 0) {
            const force = (80 * dpr - dist) / (80 * dpr) * 1.2;
            p.vx += (dx / dist) * force;
            p.vy += (dy / dist) * force;
          }
        }
      }

      // Draw connections between nearby same-category particles
      ctx.lineWidth = 0.5 * dpr;
      for (let i = 0; i < particles.length; i++) {
        const p = particles[i];
        for (let j = i + 1; j < particles.length; j++) {
          const q = particles[j];
          if (p.fact.category !== q.fact.category) continue;
          const dx = p.x - q.x;
          const dy = p.y - q.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < 80 * dpr) {
            const lineAlpha = (1 - dist / (80 * dpr)) * 0.15 * Math.min(p.alpha, q.alpha);
            const rgb = hexToRgb(p.color);
            ctx.strokeStyle = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${lineAlpha})`;
            ctx.beginPath();
            ctx.moveTo(p.x, p.y);
            ctx.lineTo(q.x, q.y);
            ctx.stroke();
          }
        }
      }

      // Draw particles
      for (const p of particles) {
        const rgb = hexToRgb(p.color);
        const r = p.radius * dpr;

        // Outer glow
        if (p.glowIntensity > 0.3) {
          const glow = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r * 5);
          glow.addColorStop(0, `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${p.alpha * 0.25})`);
          glow.addColorStop(0.5, `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${p.alpha * 0.08})`);
          glow.addColorStop(1, `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0)`);
          ctx.fillStyle = glow;
          ctx.beginPath();
          ctx.arc(p.x, p.y, r * 5, 0, Math.PI * 2);
          ctx.fill();
        }

        // Core
        const coreGrad = ctx.createRadialGradient(p.x - r * 0.3, p.y - r * 0.3, 0, p.x, p.y, r);
        coreGrad.addColorStop(0, `rgba(${Math.min(rgb.r + 60, 255)}, ${Math.min(rgb.g + 60, 255)}, ${Math.min(rgb.b + 60, 255)}, ${p.alpha})`);
        coreGrad.addColorStop(1, `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${p.alpha * 0.7})`);
        ctx.fillStyle = coreGrad;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.fill();

        // Specular highlight
        ctx.fillStyle = `rgba(255, 255, 255, ${p.alpha * 0.3})`;
        ctx.beginPath();
        ctx.arc(p.x - r * 0.25, p.y - r * 0.25, r * 0.35, 0, Math.PI * 2);
        ctx.fill();
      }

      animRef.current = requestAnimationFrame(animate);
    }

    animRef.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(animRef.current);
  }, [loading]);

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
      {loading && (
        <div style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#94a3b8',
          fontSize: 13,
          zIndex: 50,
        }}>
          Loading Cortex memory…
        </div>
      )}

      <canvas
        ref={canvasRef}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
        onClick={handleClick}
        style={{
          width: '100%',
          height: '100%',
          cursor: hoveredFact ? 'pointer' : 'default',
        }}
      />

      {/* Legend — top right */}
      <div style={{
        position: 'absolute',
        top: 16,
        right: 16,
        display: 'flex',
        flexDirection: 'column',
        gap: 5,
        paddingTop: 10,
        paddingRight: 12,
        paddingBottom: 10,
        paddingLeft: 12,
        borderRadius: 10,
        background: 'rgba(10, 14, 26, 0.85)',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
        border: '1px solid rgba(148, 163, 184, 0.1)',
      }}>
        <div style={{ fontSize: 9, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 2 }}>
          Categories
        </div>
        {categories.map(cat => (
          <div key={cat.label} style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <div style={{
              width: 7,
              height: 7,
              borderRadius: 4,
              background: cat.color,
              boxShadow: `0 0 6px ${cat.color}60`,
              flexShrink: 0,
            }} />
            <span style={{ fontSize: 11, color: '#cbd5e1', fontWeight: 400 }}>{cat.label}</span>
          </div>
        ))}
      </div>

      {/* Stats — bottom left */}
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
          <div style={{ fontSize: 9, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Facts</div>
        </div>
        <div>
          <div style={{ fontSize: 16, fontWeight: 700, color: '#22c55e', fontFamily: '"SF Mono", ui-monospace, monospace' }}>
            {stats.activeFacts.toLocaleString()}
          </div>
          <div style={{ fontSize: 9, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Active</div>
        </div>
        <div>
          <div style={{ fontSize: 16, fontWeight: 700, color: '#3b82f6', fontFamily: '"SF Mono", ui-monospace, monospace' }}>
            {stats.totalMemories.toLocaleString()}
          </div>
          <div style={{ fontSize: 9, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Memories</div>
        </div>
      </div>

      {/* Title — top left */}
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
          {particlesRef.current.length} particles
        </span>
      </div>

      {/* Confidence scale — bottom right */}
      <div style={{
        position: 'absolute',
        bottom: 16,
        right: 16,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 3,
        paddingTop: 8,
        paddingRight: 10,
        paddingBottom: 8,
        paddingLeft: 10,
        borderRadius: 10,
        background: 'rgba(10, 14, 26, 0.85)',
        border: '1px solid rgba(148, 163, 184, 0.1)',
      }}>
        <span style={{ fontSize: 9, color: '#64748b', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Weight</span>
        <div style={{
          width: 6,
          height: 60,
          borderRadius: 3,
          background: 'linear-gradient(to bottom, rgba(148,163,184,0.15), #06b6d4, #f59e0b, #ef4444)',
        }} />
        <span style={{ fontSize: 8, color: '#64748b' }}>Fresh</span>
        <span style={{ fontSize: 8, color: '#ef4444', fontWeight: 600 }}>Core</span>
      </div>

      {/* Hover tooltip */}
      {hoveredFact && !selectedFact && (
        <div style={{
          position: 'fixed',
          left: tooltipPos.x + 16,
          top: tooltipPos.y - 10,
          maxWidth: 300,
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
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
            <div style={{
              width: 7,
              height: 7,
              borderRadius: 4,
              background: CATEGORY_COLORS[hoveredFact.category] ?? '#94a3b8',
            }} />
            <span style={{ fontSize: 10, fontWeight: 600, color: CATEGORY_COLORS[hoveredFact.category] ?? '#94a3b8' }}>
              {hoveredFact.category}
            </span>
            <span style={{ fontSize: 10, color: '#64748b', marginLeft: 'auto' }}>
              {hoveredFact.confidence.toFixed(0)}%
            </span>
          </div>
          <div style={{ fontSize: 12, color: '#e2e8f0', lineHeight: 1.5 }}>
            {hoveredFact.text}
          </div>
          <div style={{ fontSize: 9, color: '#475569', marginTop: 3, fontStyle: 'italic' }}>
            Click for details
          </div>
        </div>
      )}

      {/* Selected fact detail panel */}
      {selectedFact && (
        <div
          onClick={(e) => e.stopPropagation()}
          style={{
            position: 'absolute',
            left: '50%',
            top: '50%',
            transform: 'translate(-50%, -50%)',
            width: 400,
            maxWidth: '80%',
            paddingTop: 20,
            paddingRight: 24,
            paddingBottom: 20,
            paddingLeft: 24,
            borderRadius: 16,
            background: 'rgba(10, 14, 26, 0.95)',
            backdropFilter: 'blur(24px)',
            WebkitBackdropFilter: 'blur(24px)',
            border: `1px solid ${CATEGORY_COLORS[selectedFact.category] ?? '#94a3b8'}30`,
            boxShadow: `0 16px 64px rgba(0,0,0,0.5), 0 0 40px ${CATEGORY_COLORS[selectedFact.category] ?? '#94a3b8'}15`,
            zIndex: 100,
          }}
        >
          <button
            type="button"
            onClick={() => setSelectedFact(null)}
            style={{
              position: 'absolute',
              top: 12,
              right: 12,
              width: 28,
              height: 28,
              borderRadius: 14,
              border: '1px solid rgba(148,163,184,0.15)',
              background: 'rgba(148,163,184,0.08)',
              color: '#94a3b8',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 14,
            }}
          >
            ✕
          </button>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
            <div style={{
              width: 10,
              height: 10,
              borderRadius: 5,
              background: CATEGORY_COLORS[selectedFact.category] ?? '#94a3b8',
              boxShadow: `0 0 12px ${CATEGORY_COLORS[selectedFact.category] ?? '#94a3b8'}60`,
            }} />
            <span style={{
              fontSize: 12,
              fontWeight: 700,
              color: CATEGORY_COLORS[selectedFact.category] ?? '#94a3b8',
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
            }}>
              {selectedFact.category}
            </span>
            <span style={{
              fontSize: 11,
              color: '#64748b',
              marginLeft: 'auto',
              fontFamily: '"SF Mono", ui-monospace, monospace',
            }}>
              {selectedFact.confidence.toFixed(1)}% confidence
            </span>
          </div>
          <div style={{
            fontSize: 14,
            color: '#e2e8f0',
            lineHeight: 1.7,
            marginBottom: 12,
          }}>
            {selectedFact.text}
          </div>
          <div style={{
            fontSize: 11,
            color: '#475569',
            fontFamily: '"SF Mono", ui-monospace, monospace',
            paddingTop: 8,
            borderTop: '1px solid rgba(148,163,184,0.1)',
          }}>
            Source: {selectedFact.source}
          </div>
        </div>
      )}
    </div>
  );
});
