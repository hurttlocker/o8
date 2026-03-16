"use client";

import { useRef, useEffect, useState, useCallback } from "react";
import CortexTerrain from "./CortexTerrain";

/* ─────────────────────── FEATURE DATA ─────────────────────── */

const features = [
  {
    title: "Memory That Forgets",
    desc: "Ebbinghaus decay curves. Facts reinforce or fade. Your agents remember what matters and forget what doesn't.",
    color: "#06b6d4",
    icon: "⬡",
  },
  {
    title: "Fleet Command",
    desc: "See every agent. Steer any session. Approve, deny, redirect — from desktop or phone.",
    color: "#a855f7",
    icon: "◎",
  },
  {
    title: "Worktree Isolation",
    desc: "One branch per agent. Parallel PRs. No merge conflicts. Git-native safety for multi-agent work.",
    color: "#22c55e",
    icon: "⌥",
  },
  {
    title: "Runtime Agnostic",
    desc: "Codex. Claude Code. OpenClaw. Gemini. Any ACP runtime. One control plane for all of them.",
    color: "#f59e0b",
    icon: "⚡",
  },
  {
    title: "Knowledge Graph",
    desc: "Facts connect to facts. Traverse by subject. Visualize in 2D/3D. See how your agents think.",
    color: "#ec4899",
    icon: "◇",
  },
  {
    title: "Mobile Operator",
    desc: "PWA from day one. Approve PRs from your phone. Monitor agents from anywhere.",
    color: "#8b5cf6",
    icon: "▣",
  },
];

const stats = [
  { label: "Memories", value: "21,170" },
  { label: "Facts", value: "38,523" },
  { label: "Sources", value: "3,493" },
  { label: "Active Agents", value: "5" },
];

/* ─────────────────────── STYLES ─────────────────────── */

const s = {
  page: {
    background: "#09090b",
    color: "#f4f4f5",
    minHeight: "100vh",
    fontFamily: '-apple-system, "SF Pro Display", "Segoe UI", system-ui, sans-serif',
    overflow: "hidden auto" as const,
  },
  nav: {
    position: "fixed" as const,
    top: 0,
    left: 0,
    right: 0,
    zIndex: 100,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "16px 40px",
    background: "rgba(9, 9, 11, 0.7)",
    backdropFilter: "blur(16px)",
    WebkitBackdropFilter: "blur(16px)",
    borderBottom: "1px solid rgba(255,255,255,0.06)",
  },
  navBrand: {
    display: "flex",
    alignItems: "center",
    gap: "12px",
  },
  navLogo: {
    width: 32,
    height: 32,
    borderRadius: 8,
    background: "linear-gradient(135deg, #a855f7, #7c3aed)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: 14,
    fontWeight: 900,
    color: "#fff",
    boxShadow: "0 4px 16px rgba(168,85,247,0.3)",
  },
  navTitle: {
    fontSize: 17,
    fontWeight: 700,
    letterSpacing: "-0.02em",
  },
  navTitleDim: {
    color: "#71717a",
    fontWeight: 500,
  },
  navLinks: {
    display: "flex",
    alignItems: "center",
    gap: "24px",
  },
  navLink: {
    fontSize: 14,
    color: "#a1a1aa",
    textDecoration: "none",
    fontWeight: 500,
    transition: "color 0.2s",
  },
  navCta: {
    fontSize: 13,
    fontWeight: 600,
    color: "#fff",
    background: "linear-gradient(135deg, #a855f7, #7c3aed)",
    border: "none",
    borderRadius: 10,
    padding: "8px 20px",
    cursor: "pointer",
    textDecoration: "none",
    boxShadow: "0 6px 20px rgba(168,85,247,0.25)",
    transition: "transform 0.15s, box-shadow 0.15s",
  },
  hero: {
    position: "relative" as const,
    height: "100vh",
    minHeight: 700,
    display: "flex",
    flexDirection: "column" as const,
    alignItems: "center",
    justifyContent: "flex-start",
    paddingTop: "11vh",
    overflow: "hidden",
  },
  terrainWrap: {
    position: "absolute" as const,
    left: "-10%",
    right: "-10%",
    bottom: 0,
    height: "70%",
    zIndex: 1,
  },
  heroOverlay: {
    position: "absolute" as const,
    left: "-10%",
    right: "-10%",
    bottom: 0,
    height: "75%",
    background: "linear-gradient(180deg, rgba(9,9,11,1) 0%, rgba(9,9,11,0.6) 18%, rgba(9,9,11,0.1) 45%, rgba(9,9,11,0.35) 100%)",
    pointerEvents: "none" as const,
    zIndex: 5,
  },
  heroContent: {
    position: "relative" as const,
    zIndex: 20,
    textAlign: "center" as const,
    maxWidth: 720,
    padding: "0 32px",
    pointerEvents: "auto" as const,
  },
  eyebrow: {
    fontSize: 12,
    fontWeight: 600,
    textTransform: "uppercase" as const,
    letterSpacing: "0.3em",
    color: "#a855f7",
    marginBottom: 20,
  },
  h1: {
    fontSize: "clamp(40px, 6vw, 72px)",
    fontWeight: 800,
    lineHeight: 0.92,
    letterSpacing: "-0.04em",
    background: "linear-gradient(180deg, #ffffff 0%, #a1a1aa 100%)",
    WebkitBackgroundClip: "text",
    WebkitTextFillColor: "transparent",
    margin: 0,
  },
  heroSub: {
    fontSize: "clamp(15px, 1.8vw, 18px)",
    lineHeight: 1.65,
    color: "rgba(255,255,255,0.6)",
    marginTop: 24,
    maxWidth: 520,
    marginLeft: "auto",
    marginRight: "auto",
  },
  ctaRow: {
    display: "flex",
    gap: 16,
    justifyContent: "center",
    marginTop: 36,
    flexWrap: "wrap" as const,
  },
  ctaPrimary: {
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
    fontSize: 15,
    fontWeight: 600,
    color: "#09090b",
    background: "linear-gradient(135deg, #ffffff, #e4e4e7)",
    border: "1px solid rgba(255,255,255,0.6)",
    borderRadius: 12,
    padding: "14px 32px",
    cursor: "pointer",
    textDecoration: "none",
    boxShadow: "0 12px 40px rgba(255,255,255,0.15), 0 0 0 1px rgba(255,255,255,0.1)",
    transition: "transform 0.2s, box-shadow 0.2s",
  },
  ctaSecondary: {
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
    fontSize: 15,
    fontWeight: 500,
    color: "#a1a1aa",
    background: "transparent",
    border: "1px solid rgba(255,255,255,0.1)",
    borderRadius: 12,
    padding: "14px 32px",
    cursor: "pointer",
    textDecoration: "none",
    transition: "border-color 0.2s, color 0.2s",
  },
  hint: {
    fontSize: 12,
    color: "#3f3f46",
    marginTop: 24,
    textAlign: "center" as const,
  },
  statsBar: {
    position: "relative" as const,
    zIndex: 20,
    display: "flex",
    justifyContent: "center",
    gap: 56,
    flexWrap: "wrap" as const,
    marginTop: "auto",
    paddingBottom: 80,
  },
  statItem: {
    textAlign: "center" as const,
  },
  statValue: {
    fontSize: 28,
    fontWeight: 700,
    color: "#fff",
    letterSpacing: "-0.02em",
  },
  statLabel: {
    fontSize: 11,
    textTransform: "uppercase" as const,
    letterSpacing: "0.15em",
    color: "rgba(255,255,255,0.7)",
    marginTop: 4,
  },
  section: {
    maxWidth: 1100,
    margin: "0 auto",
    padding: "100px 40px",
    position: "relative" as const,
    zIndex: 2,
  },
  paperBg: {
    position: "relative" as const,
    background: "linear-gradient(180deg, #0c0c0f 0%, #131318 20%, #111116 50%, #0f0f13 80%, #09090b 100%)",
    overflow: "hidden" as const,
  },
  sectionEyebrow: {
    fontSize: 12,
    fontWeight: 600,
    textTransform: "uppercase" as const,
    letterSpacing: "0.3em",
    color: "#a855f7",
    textAlign: "center" as const,
  },
  sectionTitle: {
    fontSize: "clamp(28px, 4vw, 44px)",
    fontWeight: 800,
    letterSpacing: "-0.03em",
    textAlign: "center" as const,
    marginTop: 12,
    color: "#f4f4f5",
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))",
    gap: 16,
    marginTop: 56,
  },
  card: (color: string) => ({
    position: "relative" as const,
    padding: "28px 28px 24px",
    borderRadius: 16,
    border: `1px solid rgba(255,255,255,0.08)`,
    background: "rgba(255, 255, 255, 0.03)",
    backdropFilter: "blur(16px)",
    WebkitBackdropFilter: "blur(16px)",
    overflow: "hidden",
    transition: "border-color 0.3s, box-shadow 0.3s, background 0.3s",
  }),
  cardGlow: (color: string) => ({
    position: "absolute" as const,
    top: -40,
    right: -40,
    width: 140,
    height: 140,
    borderRadius: "50%",
    background: color,
    opacity: 0.06,
    filter: "blur(50px)",
    pointerEvents: "none" as const,
  }),
  cardIcon: (color: string) => ({
    fontSize: 24,
    color,
    marginBottom: 16,
    display: "block",
  }),
  cardTitle: {
    fontSize: 17,
    fontWeight: 700,
    color: "#f4f4f5",
    marginBottom: 8,
  },
  cardDesc: {
    fontSize: 14,
    lineHeight: 1.6,
    color: "#71717a",
  },
  downloadSection: {
    textAlign: "center" as const,
    maxWidth: 600,
    margin: "0 auto",
    padding: "80px 40px 120px",
    position: "relative" as const,
    zIndex: 2,
  },
  downloadTitle: {
    fontSize: "clamp(28px, 4vw, 44px)",
    fontWeight: 800,
    letterSpacing: "-0.03em",
    background: "linear-gradient(135deg, #a855f7, #ec4899)",
    WebkitBackgroundClip: "text",
    WebkitTextFillColor: "transparent",
  },
  downloadSub: {
    fontSize: 15,
    lineHeight: 1.6,
    color: "#71717a",
    marginTop: 16,
  },
  downloadNote: {
    fontSize: 12,
    color: "#3f3f46",
    marginTop: 24,
  },
  footer: {
    borderTop: "1px solid rgba(255,255,255,0.06)",
    padding: "24px 40px",
    textAlign: "center" as const,
    fontSize: 13,
    color: "#3f3f46",
  },
  footerLink: {
    color: "#52525b",
    textDecoration: "underline",
    transition: "color 0.2s",
  },
  divider: {
    width: "100%",
    height: 120,
    background: "linear-gradient(180deg, #09090b 0%, #0d0d0f 100%)",
  },
};

/* ─────────────────────── PAPER NOISE SHADER ─────────────────────── */

function PaperNoise() {
  const divRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = divRef.current;
    if (!el) return;

    // Generate a small noise tile and convert to a repeating CSS background
    const size = 200;
    const c = document.createElement("canvas");
    c.width = size;
    c.height = size;
    const ctx = c.getContext("2d");
    if (!ctx) return;

    const imageData = ctx.createImageData(size, size);
    const d = imageData.data;
    for (let i = 0; i < d.length; i += 4) {
      const v = Math.random() * 30 + 10;
      d[i] = v;
      d[i + 1] = v;
      d[i + 2] = v + Math.random() * 5; // slight cool tint
      d[i + 3] = 50;
    }
    ctx.putImageData(imageData, 0, 0);

    el.style.backgroundImage = `url(${c.toDataURL()})`;
    el.style.backgroundRepeat = "repeat";
    el.style.backgroundSize = `${size}px ${size}px`;
  }, []);

  return (
    <div
      ref={divRef}
      style={{
        position: "absolute",
        inset: 0,
        pointerEvents: "none",
        opacity: 0.7,
        mixBlendMode: "screen",
        zIndex: 1,
      }}
    />
  );
}

/* ─────────────────────── COMPONENT ─────────────────────── */

export default function CortexLanding() {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  return (
    <div style={s.page}>
      {/* ──── NAV ──── */}
      <nav style={s.nav}>
        <div style={s.navBrand}>
          <div style={s.navLogo}>C</div>
          <span style={s.navTitle}>
            Cortex <span style={s.navTitleDim}>IDE</span>
          </span>
        </div>
        <div style={s.navLinks}>
          <a href="https://github.com/hurttlocker/cortex" target="_blank" rel="noreferrer" style={s.navLink}>
            GitHub
          </a>
          <a href="#download" style={s.navCta}>
            Download
          </a>
        </div>
      </nav>

      {/* ──── HERO ──── */}
      <section style={s.hero}>
        {/* Terrain background — FULL VIEWPORT */}
        <div style={s.terrainWrap}>
          {mounted && <CortexTerrain />}
        </div>
        <div style={s.heroOverlay} />

        {/* Radial glow behind text */}
        <div style={{
          position: "absolute",
          top: "30%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          width: 600,
          height: 400,
          borderRadius: "50%",
          background: "radial-gradient(ellipse, rgba(168,85,247,0.12) 0%, transparent 70%)",
          filter: "blur(60px)",
          pointerEvents: "none",
          zIndex: 8,
        }} />

        {/* Hero copy */}
        <div style={s.heroContent}>
          <p style={s.eyebrow}>The command center for AI agent teams</p>
          <h1 style={s.h1}>
            Your agents<br />remember everything.
          </h1>
          <p style={s.heroSub}>
            Memory-native control plane for running, supervising, and scaling
            fleets of coding agents. One operator. Many agents. One system.
          </p>
          <div style={s.ctaRow}>
            <a href="#download" style={s.ctaPrimary}>
              ⬇ Download for Mac
            </a>
            <a
              href="https://github.com/hurttlocker/cortex"
              target="_blank"
              rel="noreferrer"
              style={s.ctaSecondary}
            >
              View on GitHub →
            </a>
          </div>
          {/* hint removed — terrain speaks for itself */}
        </div>

        {/* Stats */}
        <div style={s.statsBar}>
          {stats.map((st) => (
            <div key={st.label} style={s.statItem}>
              <div style={s.statValue}>{st.value}</div>
              <div style={s.statLabel}>{st.label}</div>
            </div>
          ))}
        </div>
      </section>

      {/* ──── FADE + PAPER SECTION ──── */}
      <div style={s.divider} />

      <div style={s.paperBg}>
        {/* Paper shader noise overlay */}
        <PaperNoise />

        {/* Ambient gradient orbs — give glass something to blur */}
        <div style={{
          position: "absolute", top: "15%", left: "15%", width: 400, height: 400,
          borderRadius: "50%", background: "radial-gradient(circle, rgba(168,85,247,0.07) 0%, transparent 70%)",
          filter: "blur(80px)", pointerEvents: "none", zIndex: 0,
        }} />
        <div style={{
          position: "absolute", top: "40%", right: "10%", width: 350, height: 350,
          borderRadius: "50%", background: "radial-gradient(circle, rgba(6,182,212,0.05) 0%, transparent 70%)",
          filter: "blur(80px)", pointerEvents: "none", zIndex: 0,
        }} />
        <div style={{
          position: "absolute", bottom: "20%", left: "30%", width: 300, height: 300,
          borderRadius: "50%", background: "radial-gradient(circle, rgba(236,72,153,0.04) 0%, transparent 70%)",
          filter: "blur(80px)", pointerEvents: "none", zIndex: 0,
        }} />

        {/* ──── FEATURES ──── */}
        <section style={s.section}>
          <p style={s.sectionEyebrow}>What's inside</p>
          <h2 style={s.sectionTitle}>Built for the multi-agent era</h2>
        <div style={s.grid}>
          {features.map((f) => (
            <div
              key={f.title}
              style={s.card(f.color)}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLDivElement).style.borderColor = "rgba(255,255,255,0.14)";
                (e.currentTarget as HTMLDivElement).style.background = "rgba(255, 255, 255, 0.05)";
                (e.currentTarget as HTMLDivElement).style.boxShadow = `0 20px 60px ${f.color}12, 0 0 40px ${f.color}08`;
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLDivElement).style.borderColor = "rgba(255,255,255,0.08)";
                (e.currentTarget as HTMLDivElement).style.background = "rgba(255, 255, 255, 0.03)";
                (e.currentTarget as HTMLDivElement).style.boxShadow = "none";
              }}
            >
              <div style={s.cardGlow(f.color)} />
              <span style={s.cardIcon(f.color)}>{f.icon}</span>
              <div style={s.cardTitle}>{f.title}</div>
              <div style={s.cardDesc}>{f.desc}</div>
            </div>
          ))}
        </div>
      </section>

      {/* ──── DOWNLOAD CTA ──── */}
      <section id="download" style={s.downloadSection}>
        <h2 style={s.downloadTitle}>Start commanding your fleet.</h2>
        <p style={s.downloadSub}>
          Download Cortex IDE. Import your files. Watch your agents get smarter.
          Zero config. One binary. Local-first forever.
        </p>
        <div style={{ ...s.ctaRow, marginTop: 32 }}>
          <a href="#" style={{ ...s.ctaPrimary, padding: "16px 40px", fontSize: 16, color: "#09090b" }}>
            ⬇ Download for macOS
          </a>
        </div>
        <p style={s.downloadNote}>
          Free during early access · MIT licensed memory layer · No data leaves your machine
        </p>
        <p style={{ ...s.downloadNote, marginTop: 8 }}>
          Windows & Linux coming soon
        </p>
      </section>

      </div>{/* close paperBg */}

      {/* ──── FOOTER ──── */}
      <footer style={s.footer}>
        Cortex IDE · Built by{" "}
        <a href="https://github.com/hurttlocker" target="_blank" rel="noreferrer" style={s.footerLink}>
          hurttlocker
        </a>
      </footer>
    </div>
  );
}
