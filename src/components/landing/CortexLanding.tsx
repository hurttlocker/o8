"use client";

import { useRef, useState, useCallback, useEffect } from "react";
import { motion, useScroll, useTransform, AnimatePresence } from "framer-motion";
import CortexTerrain from "./CortexTerrain";

/* ─────────────────────── TYPES ─────────────────────── */

interface GraphNode {
  id: number;
  label: string;
  category: string;
  confidence: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  radius: number;
  color: string;
  connections: number[];
}

interface ExpandedNode {
  node: GraphNode;
  details: string[];
}

/* ─────────────────────── PALETTE ─────────────────────── */

const COLORS = {
  bg: "#09090b",
  panel: "#0f1013",
  border: "#27272a",
  text: "#f4f4f5",
  muted: "#a1a1aa",
  accent: "#a855f7",
  accentDim: "#7c3aed",
  accentGlow: "rgba(168, 85, 247, 0.25)",
  green: "#22c55e",
  greenDim: "#16a34a",
  pink: "#ec4899",
  amber: "#f59e0b",
  cyan: "#06b6d4",
};

const CATEGORY_COLORS: Record<string, string> = {
  agent: COLORS.accent,
  memory: COLORS.cyan,
  decision: COLORS.green,
  identity: COLORS.pink,
  tool: COLORS.amber,
  project: "#8b5cf6",
  person: "#f472b6",
  config: "#64748b",
};

/* ─────────────────────── FAKE GRAPH DATA ─────────────────────── */

function generateGraph(): GraphNode[] {
  const categories = [
    { cat: "agent", labels: ["Mister", "Niot", "Hawk", "Noémie", "Rue", "Agent Fleet", "Heartbeat Loop", "Sub-agent Pool"] },
    { cat: "memory", labels: ["Cortex Memory", "Fact Store", "Belief Lifecycle", "Ebbinghaus Decay", "Hybrid Search", "Content Hash", "Conflict Detection", "Knowledge Graph"] },
    { cat: "decision", labels: ["PR Review Flow", "Worktree Isolation", "Task Assignment", "Approval Gate", "Budget Control", "Cost Governance"] },
    { cat: "tool", labels: ["GitHub", "OpenClaw", "Tauri Shell", "WebSocket", "MCP Server", "Homebrew Tap"] },
    { cat: "project", labels: ["Cortex IDE", "Pretty Little Plays", "Spear", "Trading Engine", "YouTube Pipeline"] },
    { cat: "identity", labels: ["Q", "SB", "Philadelphia", "Operator Mode"] },
    { cat: "config", labels: ["Runtime Adapter", "Session Manager", "Fleet State Model", "Mobile PWA"] },
  ];

  const nodes: GraphNode[] = [];
  let id = 0;

  for (const { cat, labels } of categories) {
    for (const label of labels) {
      const angle = Math.random() * Math.PI * 2;
      const radius = 150 + Math.random() * 250;
      const elevation = (Math.random() - 0.5) * 200;
      nodes.push({
        id: id++,
        label,
        category: cat,
        confidence: 0.4 + Math.random() * 0.6,
        x: Math.cos(angle) * radius,
        y: Math.sin(angle) * radius,
        z: elevation,
        vx: (Math.random() - 0.5) * 0.3,
        vy: (Math.random() - 0.5) * 0.3,
        vz: (Math.random() - 0.5) * 0.15,
        radius: 4 + Math.random() * 6,
        color: CATEGORY_COLORS[cat] ?? COLORS.accent,
        connections: [],
      });
    }
  }

  // Generate connections — same category + some cross-category
  for (let i = 0; i < nodes.length; i++) {
    const sameCat = nodes.filter((n) => n.category === nodes[i].category && n.id !== nodes[i].id);
    const picks = sameCat.sort(() => Math.random() - 0.5).slice(0, 2);
    for (const p of picks) {
      if (!nodes[i].connections.includes(p.id)) nodes[i].connections.push(p.id);
      if (!p.connections.includes(nodes[i].id)) p.connections.push(nodes[i].id);
    }
    // Cross-category link
    if (Math.random() > 0.5) {
      const other = nodes[Math.floor(Math.random() * nodes.length)];
      if (other.id !== nodes[i].id && !nodes[i].connections.includes(other.id)) {
        nodes[i].connections.push(other.id);
        other.connections.push(nodes[i].id);
      }
    }
  }

  return nodes;
}

const NODE_DETAILS: Record<string, string[]> = {
  "Cortex Memory": ["21,170 memories indexed", "38,523 facts extracted", "Ebbinghaus decay curves", "Local-first SQLite"],
  "Mister": ["CEO/Orchestrator agent", "Opus 4.6 · 2h heartbeat", "Runs trading, ops, coordination", "Your direct line"],
  "Niot": ["Cortex feature delivery", "Codex 5.3 · 4h heartbeat", "Builds bounded PR slices", "Pronounced 'knee-yo'"],
  "Hawk": ["QA & release guard", "Codex 5.3 · 3h heartbeat", "PR validation sweeps", "Deterministic test harness"],
  "Cortex IDE": ["31,675 lines TypeScript", "Next.js 16 + React 19", "Tauri v2 desktop shell", "Mobile PWA from day one"],
  "Knowledge Graph": ["Fact → fact connections", "Subject-based traversal", "Confidence-weighted edges", "Interactive 2D/3D explorer"],
  "Hybrid Search": ["BM25 keyword + semantic", "RRF score fusion", "Source-filtered queries", "Sub-50ms latency"],
  "Worktree Isolation": ["One branch per agent", "No merge conflicts", "Parallel PR workflows", "Git-native safety"],
  "Belief Lifecycle": ["active → stale → retired", "Auto-supersede on conflict", "Confidence reinforcement", "Provenance tracking"],
};

/* ─────────────────────── 3D GRAPH CANVAS ─────────────────────── */

function InteractiveGraph({ onNodeClick }: { onNodeClick: (node: GraphNode) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const nodesRef = useRef<GraphNode[]>(generateGraph());
  const mouseRef = useRef({ x: 0, y: 0 });
  const hoveredRef = useRef<number | null>(null);
  const rotationRef = useRef({ x: 0.0003, y: 0.0005 });
  const angleRef = useRef({ x: 0, y: 0 });
  const frameRef = useRef<number>(0);
  const [hovered, setHovered] = useState<GraphNode | null>(null);

  const project = useCallback((node: GraphNode, cx: number, cy: number) => {
    const ax = angleRef.current.x;
    const ay = angleRef.current.y;
    // Rotate Y
    const x1 = node.x * Math.cos(ay) - node.z * Math.sin(ay);
    const z1 = node.x * Math.sin(ay) + node.z * Math.cos(ay);
    // Rotate X
    const y1 = node.y * Math.cos(ax) - z1 * Math.sin(ax);
    const z2 = node.y * Math.sin(ax) + z1 * Math.cos(ax);
    const perspective = 800;
    const scale = perspective / (perspective + z2 + 400);
    return { sx: cx + x1 * scale, sy: cy + y1 * scale, scale, z: z2 };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let animating = true;

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      ctx.scale(dpr, dpr);
    };
    resize();
    window.addEventListener("resize", resize);

    const handleMouse = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      mouseRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };
    canvas.addEventListener("mousemove", handleMouse);

    const handleClick = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const cx = rect.width / 2;
      const cy = rect.height / 2;
      const nodes = nodesRef.current;

      for (const node of nodes) {
        const p = project(node, cx, cy);
        const r = node.radius * p.scale * 1.5;
        if (Math.hypot(mx - p.sx, my - p.sy) < r + 10) {
          onNodeClick(node);
          return;
        }
      }
    };
    canvas.addEventListener("click", handleClick);

    function animate() {
      if (!animating || !ctx || !canvas) return;
      const rect = canvas.getBoundingClientRect();
      const w = rect.width;
      const h = rect.height;
      const cx = w / 2;
      const cy = h / 2;

      ctx.clearRect(0, 0, w, h);

      // Slow auto-rotation
      angleRef.current.x += rotationRef.current.x;
      angleRef.current.y += rotationRef.current.y;

      // Mouse influence on rotation
      const mx = mouseRef.current.x;
      const my = mouseRef.current.y;
      rotationRef.current.y = 0.0005 + (mx - cx) * 0.0000015;
      rotationRef.current.x = 0.0003 + (my - cy) * 0.0000015;

      const nodes = nodesRef.current;

      // Light physics: gentle drift
      for (const node of nodes) {
        node.x += node.vx;
        node.y += node.vy;
        node.z += node.vz;
        // Soft boundary
        const dist = Math.sqrt(node.x * node.x + node.y * node.y + node.z * node.z);
        if (dist > 350) {
          node.vx -= node.x * 0.0001;
          node.vy -= node.y * 0.0001;
          node.vz -= node.z * 0.0001;
        }
        // Damping
        node.vx *= 0.999;
        node.vy *= 0.999;
        node.vz *= 0.999;
      }

      // Project all nodes
      const projected = nodes.map((node) => ({ ...project(node, cx, cy), node }));
      projected.sort((a, b) => a.z - b.z); // back-to-front

      // Draw connections
      let newHovered: number | null = null;
      ctx.lineWidth = 0.5;
      for (const p of projected) {
        for (const connId of p.node.connections) {
          const target = projected.find((pp) => pp.node.id === connId);
          if (!target || target.node.id < p.node.id) continue;
          const alpha = Math.min(p.scale, target.scale) * 0.25;
          ctx.strokeStyle = `rgba(168, 85, 247, ${alpha})`;
          ctx.beginPath();
          ctx.moveTo(p.sx, p.sy);
          ctx.lineTo(target.sx, target.sy);
          ctx.stroke();
        }
      }

      // Draw nodes
      for (const p of projected) {
        const r = p.node.radius * p.scale;
        const dist = Math.hypot(mx - p.sx, my - p.sy);
        const isHovered = dist < r + 12;
        if (isHovered) newHovered = p.node.id;

        // Glow
        if (isHovered || p.node.confidence > 0.8) {
          const glow = ctx.createRadialGradient(p.sx, p.sy, 0, p.sx, p.sy, r * 4);
          glow.addColorStop(0, p.node.color + "40");
          glow.addColorStop(1, "transparent");
          ctx.fillStyle = glow;
          ctx.beginPath();
          ctx.arc(p.sx, p.sy, r * 4, 0, Math.PI * 2);
          ctx.fill();
        }

        // Node circle
        ctx.fillStyle = p.node.color + (isHovered ? "ff" : "cc");
        ctx.beginPath();
        ctx.arc(p.sx, p.sy, isHovered ? r * 1.4 : r, 0, Math.PI * 2);
        ctx.fill();

        // Label on hover
        if (isHovered) {
          ctx.fillStyle = COLORS.text;
          ctx.font = `600 ${Math.max(12, 14 * p.scale)}px "SF Pro Display", system-ui, sans-serif`;
          ctx.textAlign = "center";
          ctx.fillText(p.node.label, p.sx, p.sy - r * 1.8 - 6);

          // Category tag
          ctx.fillStyle = COLORS.muted;
          ctx.font = `500 ${Math.max(9, 10 * p.scale)}px "SF Pro Display", system-ui, sans-serif`;
          ctx.fillText(p.node.category.toUpperCase(), p.sx, p.sy - r * 1.8 + 10);
        }
      }

      if (hoveredRef.current !== newHovered) {
        hoveredRef.current = newHovered;
        canvas.style.cursor = newHovered !== null ? "pointer" : "default";
        setHovered(newHovered !== null ? nodes.find((n) => n.id === newHovered) ?? null : null);
      }

      frameRef.current = requestAnimationFrame(animate);
    }

    frameRef.current = requestAnimationFrame(animate);

    return () => {
      animating = false;
      cancelAnimationFrame(frameRef.current);
      window.removeEventListener("resize", resize);
      canvas.removeEventListener("mousemove", handleMouse);
      canvas.removeEventListener("click", handleClick);
    };
  }, [project, onNodeClick]);

  return (
    <div className="relative h-full w-full">
      <canvas
        ref={canvasRef}
        className="h-full w-full"
        style={{ display: "block" }}
      />
      {/* Floating tooltip */}
      <AnimatePresence>
        {hovered && (
          <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 6 }}
            className="pointer-events-none absolute bottom-6 left-6 rounded-xl border px-4 py-3"
            style={{
              background: "rgba(15, 16, 19, 0.92)",
              borderColor: hovered.color + "40",
              backdropFilter: "blur(12px)",
              boxShadow: `0 0 30px ${hovered.color}20`,
            }}
          >
            <div className="flex items-center gap-2">
              <div className="h-2.5 w-2.5 rounded-full" style={{ background: hovered.color }} />
              <span className="text-sm font-semibold text-white">{hovered.label}</span>
              <span className="text-[10px] uppercase tracking-widest" style={{ color: COLORS.muted }}>
                {hovered.category}
              </span>
            </div>
            <div className="mt-1 text-xs" style={{ color: COLORS.muted }}>
              Confidence: {Math.round(hovered.confidence * 100)}% · {hovered.connections.length} connections
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/* ─────────────────────── NODE DETAIL PANEL ─────────────────────── */

function NodeDetailPanel({ node, onClose }: { node: ExpandedNode; onClose: () => void }) {
  const details = NODE_DETAILS[node.node.label] ?? [
    `Category: ${node.node.category}`,
    `Confidence: ${Math.round(node.node.confidence * 100)}%`,
    `${node.node.connections.length} connections in graph`,
    "Click another node to explore",
  ];

  return (
    <motion.div
      initial={{ opacity: 0, x: 40 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 40 }}
      className="absolute right-6 top-6 z-20 w-80 rounded-2xl border p-5"
      style={{
        background: "rgba(15, 16, 19, 0.95)",
        borderColor: node.node.color + "30",
        backdropFilter: "blur(20px)",
        boxShadow: `0 20px 60px rgba(0,0,0,0.5), 0 0 40px ${node.node.color}15`,
      }}
    >
      <button
        onClick={onClose}
        className="absolute right-3 top-3 text-zinc-500 transition hover:text-white"
      >
        ✕
      </button>
      <div className="flex items-center gap-3 mb-4">
        <div
          className="h-4 w-4 rounded-full"
          style={{ background: node.node.color, boxShadow: `0 0 12px ${node.node.color}60` }}
        />
        <div>
          <h3 className="text-lg font-bold text-white">{node.node.label}</h3>
          <p className="text-[10px] uppercase tracking-[0.2em]" style={{ color: COLORS.muted }}>
            {node.node.category}
          </p>
        </div>
      </div>
      <div className="space-y-2">
        {details.map((d, i) => (
          <motion.div
            key={i}
            initial={{ opacity: 0, x: 10 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: i * 0.08 }}
            className="flex items-start gap-2 text-sm"
          >
            <span style={{ color: node.node.color }}>›</span>
            <span style={{ color: "#d4d4d8" }}>{d}</span>
          </motion.div>
        ))}
      </div>
      <div className="mt-4 flex items-center gap-2 rounded-lg px-3 py-2 text-xs" style={{ background: "rgba(168,85,247,0.08)", color: COLORS.accent }}>
        <span>⚡</span> {node.node.connections.length} edges · {Math.round(node.node.confidence * 100)}% confidence
      </div>
    </motion.div>
  );
}

/* ─────────────────────── STATS BAR ─────────────────────── */

const stats = [
  { label: "Memories", value: "21,170", icon: "🧠" },
  { label: "Facts", value: "38,523", icon: "💎" },
  { label: "Sources", value: "3,493", icon: "📁" },
  { label: "Agents", value: "5", icon: "🤖" },
];

function StatsBar() {
  return (
    <div className="flex flex-wrap justify-center gap-6 sm:gap-10">
      {stats.map((s, i) => (
        <motion.div
          key={s.label}
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.8 + i * 0.1 }}
          className="flex items-center gap-3"
        >
          <span className="text-2xl">{s.icon}</span>
          <div>
            <div className="text-xl font-bold text-white sm:text-2xl">{s.value}</div>
            <div className="text-[11px] uppercase tracking-[0.15em]" style={{ color: COLORS.muted }}>
              {s.label}
            </div>
          </div>
        </motion.div>
      ))}
    </div>
  );
}

/* ─────────────────────── FEATURE CARDS ─────────────────────── */

const features = [
  {
    title: "Memory That Forgets",
    desc: "Ebbinghaus decay curves. Facts reinforce or fade. Your agents remember what matters and forget what doesn't.",
    color: COLORS.cyan,
    icon: "🧬",
  },
  {
    title: "Fleet Command",
    desc: "See every agent. Steer any session. Approve, deny, redirect — from desktop or phone.",
    color: COLORS.accent,
    icon: "🛰️",
  },
  {
    title: "Worktree Isolation",
    desc: "One branch per agent. Parallel PRs. No merge conflicts. Git-native safety for multi-agent work.",
    color: COLORS.green,
    icon: "🌿",
  },
  {
    title: "Runtime Agnostic",
    desc: "Codex. Claude Code. OpenClaw. Gemini. Any ACP runtime. One control plane for all of them.",
    color: COLORS.amber,
    icon: "⚡",
  },
  {
    title: "Knowledge Graph",
    desc: "Facts connect to facts. Traverse by subject. Visualize in 2D/3D. See how your agents think.",
    color: COLORS.pink,
    icon: "🔗",
  },
  {
    title: "Mobile Operator",
    desc: "PWA from day one. Approve PRs from your phone. Monitor agents from anywhere. No VPN needed.",
    color: "#8b5cf6",
    icon: "📱",
  },
];

function FeatureCards() {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {features.map((f, i) => (
        <motion.div
          key={f.title}
          initial={{ opacity: 0, y: 30 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ delay: i * 0.08 }}
          className="group relative overflow-hidden rounded-2xl border p-6 transition-all duration-300 hover:border-opacity-60"
          style={{
            background: "rgba(15, 16, 19, 0.7)",
            borderColor: f.color + "20",
          }}
          whileHover={{
            borderColor: f.color + "50",
            boxShadow: `0 20px 50px ${f.color}10, 0 0 30px ${f.color}08`,
          }}
        >
          <div
            className="absolute -right-8 -top-8 h-32 w-32 rounded-full opacity-[0.04] blur-2xl transition-opacity group-hover:opacity-[0.1]"
            style={{ background: f.color }}
          />
          <div className="relative">
            <span className="text-3xl">{f.icon}</span>
            <h3 className="mt-4 text-lg font-bold text-white">{f.title}</h3>
            <p className="mt-2 text-sm leading-relaxed" style={{ color: COLORS.muted }}>
              {f.desc}
            </p>
          </div>
        </motion.div>
      ))}
    </div>
  );
}

/* ─────────────────────── MAIN LANDING ─────────────────────── */

export default function CortexLanding() {
  const heroRef = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({ target: heroRef, offset: ["start start", "end start"] });
  const heroOpacity = useTransform(scrollYProgress, [0, 0.5], [1, 0]);
  const heroScale = useTransform(scrollYProgress, [0, 0.5], [1, 0.95]);

  return (
    <div style={{ background: COLORS.bg, color: COLORS.text, minHeight: "100vh" }}>
      {/* ──── NAV ──── */}
      <nav
        className="fixed top-0 z-50 flex w-full items-center justify-between px-6 py-4 sm:px-10"
        style={{
          background: "rgba(9, 9, 11, 0.8)",
          backdropFilter: "blur(12px)",
          borderBottom: `1px solid ${COLORS.border}`,
        }}
      >
        <div className="flex items-center gap-3">
          <div
            className="flex h-8 w-8 items-center justify-center rounded-lg text-sm font-black"
            style={{
              background: `linear-gradient(135deg, ${COLORS.accent}, ${COLORS.accentDim})`,
              boxShadow: `0 4px 12px ${COLORS.accentGlow}`,
            }}
          >
            C
          </div>
          <span className="text-lg font-bold tracking-tight">
            Cortex <span style={{ color: COLORS.muted }}>IDE</span>
          </span>
        </div>
        <div className="flex items-center gap-4">
          <a href="https://github.com/hurttlocker/cortex" target="_blank" rel="noreferrer"
            className="text-sm transition hover:text-white" style={{ color: COLORS.muted }}>
            GitHub
          </a>
          <a
            href="#download"
            className="rounded-lg px-4 py-2 text-sm font-semibold text-white transition"
            style={{
              background: `linear-gradient(135deg, ${COLORS.accent}, ${COLORS.accentDim})`,
              boxShadow: `0 8px 24px ${COLORS.accentGlow}`,
            }}
          >
            Download
          </a>
        </div>
      </nav>

      {/* ──── HERO: INTERACTIVE GRAPH ──── */}
      <motion.section
        ref={heroRef}
        style={{ opacity: heroOpacity, scale: heroScale }}
        className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden pt-16"
      >
        {/* Background terrain — full bleed */}
        <div className="absolute inset-0">
          <CortexTerrain />
          {/* Gradient overlays for text readability */}
          <div className="absolute inset-0 bg-gradient-to-b from-[#09090b]/70 via-transparent to-[#09090b]/60" />
        </div>

        {/* Hero text */}
        <div className="relative z-10 mx-auto max-w-4xl px-6 text-center">
          <motion.div
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, ease: [0.22, 1, 0.36, 1] }}
          >
            <p
              className="mb-4 text-xs font-semibold uppercase tracking-[0.3em] sm:text-sm"
              style={{ color: COLORS.accent }}
            >
              The command center for AI agent teams
            </p>
            <h1
              className="text-4xl font-black leading-[0.92] tracking-[-0.04em] sm:text-6xl lg:text-7xl"
              style={{
                background: `linear-gradient(180deg, #ffffff 0%, ${COLORS.muted} 100%)`,
                WebkitBackgroundClip: "text",
                WebkitTextFillColor: "transparent",
              }}
            >
              Your agents
              <br />
              remember everything.
            </h1>
            <p className="mx-auto mt-6 max-w-xl text-base leading-relaxed sm:text-lg" style={{ color: COLORS.muted }}>
              Memory-native control plane for running, supervising, and scaling fleets of coding agents.
              One operator. Many agents. One system.
            </p>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.4, duration: 0.6 }}
            className="mt-8 flex flex-col items-center gap-4 sm:flex-row sm:justify-center"
          >
            <a
              href="#download"
              className="rounded-xl px-8 py-3.5 text-base font-semibold text-white transition-all duration-200 hover:scale-[1.03]"
              style={{
                background: `linear-gradient(135deg, ${COLORS.accent}, ${COLORS.accentDim})`,
                boxShadow: `0 12px 36px ${COLORS.accentGlow}, 0 0 0 1px rgba(168,85,247,0.3)`,
              }}
            >
              Download for Mac
            </a>
            <a
              href="https://github.com/hurttlocker/cortex"
              target="_blank"
              rel="noreferrer"
              className="rounded-xl border px-8 py-3.5 text-base font-semibold transition-all duration-200 hover:border-zinc-600"
              style={{ borderColor: COLORS.border, color: COLORS.muted }}
            >
              View on GitHub
            </a>
          </motion.div>

          <motion.p
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.8 }}
            className="mt-6 text-xs"
            style={{ color: "#52525b" }}
          >
            ↑ Move your cursor across the terrain. Each bar is a memory.
          </motion.p>
        </div>

        {/* Stats at bottom of hero */}
        <div className="relative z-10 mt-auto pb-12">
          <StatsBar />
        </div>
      </motion.section>

      {/* ──── FEATURES ──── */}
      <section className="relative mx-auto max-w-6xl px-6 py-24 sm:px-10">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          className="mb-12 text-center"
        >
          <p className="text-xs font-semibold uppercase tracking-[0.3em]" style={{ color: COLORS.accent }}>
            What's inside
          </p>
          <h2
            className="mt-3 text-3xl font-black tracking-tight sm:text-5xl"
            style={{ color: COLORS.text }}
          >
            Built for the multi-agent era
          </h2>
        </motion.div>
        <FeatureCards />
      </section>

      {/* ──── DOWNLOAD CTA ──── */}
      <section
        id="download"
        className="relative mx-auto max-w-4xl px-6 py-24 text-center sm:px-10"
      >
        <motion.div
          initial={{ opacity: 0, y: 30 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
        >
          <h2
            className="text-3xl font-black tracking-tight sm:text-5xl"
            style={{
              background: `linear-gradient(135deg, ${COLORS.accent} 0%, ${COLORS.pink} 100%)`,
              WebkitBackgroundClip: "text",
              WebkitTextFillColor: "transparent",
            }}
          >
            Start commanding your fleet.
          </h2>
          <p className="mx-auto mt-4 max-w-lg text-base" style={{ color: COLORS.muted }}>
            Download Cortex IDE. Import your files. Watch your agents get smarter.
            Zero config. One binary. Local-first forever.
          </p>
          <div className="mt-8 flex flex-col items-center gap-4 sm:flex-row sm:justify-center">
            <a
              href="#"
              className="rounded-xl px-10 py-4 text-lg font-bold text-white transition-all duration-200 hover:scale-[1.03]"
              style={{
                background: `linear-gradient(135deg, ${COLORS.accent}, ${COLORS.accentDim})`,
                boxShadow: `0 16px 48px ${COLORS.accentGlow}`,
              }}
            >
              ⬇ Download for macOS
            </a>
            <span className="text-sm" style={{ color: "#52525b" }}>
              Windows & Linux coming soon
            </span>
          </div>
          <p className="mt-6 text-xs" style={{ color: "#3f3f46" }}>
            Free during early access · MIT licensed memory layer · No data leaves your machine
          </p>
        </motion.div>
      </section>

      {/* ──── FOOTER ──── */}
      <footer className="border-t px-6 py-8 text-center" style={{ borderColor: COLORS.border }}>
        <p className="text-sm" style={{ color: "#52525b" }}>
          Cortex IDE · Built by{" "}
          <a href="https://github.com/hurttlocker" target="_blank" rel="noreferrer" className="underline transition hover:text-white">
            hurttlocker
          </a>
        </p>
      </footer>
    </div>
  );
}
