"use client";

import { useRef, useEffect, useState } from "react";
import CortexTerrain from "./CortexTerrain";

const palette = {
  darkBlue: "#1A0089",
  portlandOrange: "#FF5E39",
  whiteChocolate: "#EFE7D3",
  juneBud: "#B7CF4F",
};

/* ─────────────────────── FEATURE DATA ─────────────────────── */

const features = [
  {
    title: "Memory That Forgets",
    desc: "Ebbinghaus decay curves. Facts reinforce or fade. Your agents remember what matters and forget what doesn't.",
    color: palette.juneBud,
    icon: "⬡",
  },
  {
    title: "Fleet Command",
    desc: "See every agent. Steer any session. Approve, deny, redirect — from desktop or phone.",
    color: palette.portlandOrange,
    icon: "◎",
  },
  {
    title: "Worktree Isolation",
    desc: "One branch per agent. Parallel PRs. No merge conflicts. Git-native safety for multi-agent work.",
    color: palette.juneBud,
    icon: "⌥",
  },
  {
    title: "Runtime Agnostic",
    desc: "Codex. Claude Code. OpenClaw. Gemini. Any ACP runtime. One control plane for all of them.",
    color: palette.portlandOrange,
    icon: "⚡",
  },
  {
    title: "Knowledge Graph",
    desc: "Facts connect to facts. Traverse by subject. Visualize in 2D/3D. See how your agents think.",
    color: palette.juneBud,
    icon: "◇",
  },
  {
    title: "Mobile Operator",
    desc: "PWA from day one. Approve PRs from your phone. Monitor agents from anywhere.",
    color: palette.portlandOrange,
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
    background:
      "radial-gradient(circle at 18% 18%, rgba(183,207,79,0.14) 0%, transparent 24%), radial-gradient(circle at 82% 10%, rgba(255,94,57,0.12) 0%, transparent 28%), linear-gradient(180deg, #F4EEDF 0%, #EFE7D3 42%, #E8E0CC 100%)",
    color: palette.darkBlue,
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
    background: "rgba(239,231,211,0.82)",
    backdropFilter: "blur(16px)",
    WebkitBackdropFilter: "blur(16px)",
    borderBottom: "1px solid rgba(26,0,137,0.12)",
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
    background: "linear-gradient(135deg, #1A0089, #3E2BBA)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: 14,
    fontWeight: 900,
    color: palette.whiteChocolate,
    boxShadow: "0 4px 16px rgba(26,0,137,0.16)",
  },
  navTitle: {
    fontSize: 17,
    fontWeight: 700,
    letterSpacing: "-0.02em",
    color: palette.darkBlue,
  },
  navTitleDim: {
    color: "rgba(255,94,57,0.82)",
    fontWeight: 500,
  },
  navLinks: {
    display: "flex",
    alignItems: "center",
    gap: "24px",
  },
  navLink: {
    fontSize: 14,
    color: "rgba(26,0,137,0.78)",
    textDecoration: "none",
    fontWeight: 500,
    transition: "color 0.2s",
  },
  navCta: {
    fontSize: 13,
    fontWeight: 600,
    color: palette.whiteChocolate,
    background: "linear-gradient(135deg, #FF5E39, #FF7B54)",
    border: "1px solid rgba(26,0,137,0.08)",
    borderRadius: 10,
    padding: "8px 20px",
    cursor: "pointer",
    textDecoration: "none",
    boxShadow: "0 6px 20px rgba(255,94,57,0.18)",
    transition: "transform 0.15s, box-shadow 0.15s",
  },
  hero: {
    position: "relative" as const,
    display: "flex",
    flexDirection: "column" as const,
    alignItems: "center",
    justifyContent: "flex-start",
    paddingTop: "16vh",
    paddingBottom: 72,
    overflow: "hidden",
  },
  terrainWrap: {
    position: "relative" as const,
    width: "min(92vw, 980px)",
    height: "min(62vh, 560px)",
    marginTop: 64,
    borderRadius: 32,
    overflow: "hidden",
    zIndex: 10,
    background:
      "radial-gradient(circle at 18% 18%, rgba(183,207,79,0.14) 0%, transparent 24%), radial-gradient(circle at 82% 10%, rgba(255,94,57,0.12) 0%, transparent 28%), linear-gradient(180deg, #F4EEDF 0%, #EFE7D3 42%, #E8E0CC 100%)",
    border: "1px solid rgba(26,0,137,0.12)",
    boxShadow: "0 26px 70px rgba(26,0,137,0.08), 0 10px 30px rgba(255,94,57,0.08)",
  },
  heroOverlay: {
    position: "absolute" as const,
    left: "-10%",
    right: "-10%",
    bottom: 0,
    height: "52%",
    background: "linear-gradient(180deg, rgba(239,231,211,0.98) 0%, rgba(239,231,211,0.78) 16%, rgba(239,231,211,0.12) 46%, rgba(239,231,211,0) 100%)",
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
    color: palette.portlandOrange,
    marginBottom: 20,
  },
  h1: {
    fontSize: "clamp(40px, 6vw, 72px)",
    fontWeight: 800,
    lineHeight: 0.92,
    letterSpacing: "-0.04em",
    background: "linear-gradient(180deg, #1A0089 0%, #2510A0 100%)",
    WebkitBackgroundClip: "text",
    WebkitTextFillColor: "transparent",
    margin: 0,
  },
  heroSub: {
    fontSize: "clamp(15px, 1.8vw, 18px)",
    lineHeight: 1.65,
    color: "rgba(26,0,137,0.72)",
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
    color: palette.whiteChocolate,
    background: "linear-gradient(135deg, #FF5E39, #FF7B54)",
    border: "1px solid rgba(26,0,137,0.08)",
    borderRadius: 12,
    padding: "14px 32px",
    cursor: "pointer",
    textDecoration: "none",
    boxShadow: "0 12px 40px rgba(255,94,57,0.18), 0 0 0 1px rgba(255,94,57,0.12)",
    transition: "transform 0.2s, box-shadow 0.2s",
  },
  ctaSecondary: {
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
    fontSize: 15,
    fontWeight: 500,
    color: palette.darkBlue,
    background: "rgba(239,231,211,0.56)",
    border: "1px solid rgba(183,207,79,0.4)",
    borderRadius: 12,
    padding: "14px 32px",
    cursor: "pointer",
    textDecoration: "none",
    transition: "border-color 0.2s, color 0.2s",
  },
  hint: {
    fontSize: 12,
    color: "rgba(26,0,137,0.42)",
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
    marginTop: 40,
    paddingBottom: 0,
  },
  statItem: {
    textAlign: "center" as const,
  },
  statValue: {
    fontSize: 28,
    fontWeight: 700,
    color: palette.darkBlue,
    letterSpacing: "-0.02em",
  },
  statLabel: {
    fontSize: 11,
    textTransform: "uppercase" as const,
    letterSpacing: "0.15em",
    color: "rgba(255,94,57,0.82)",
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
    background: "linear-gradient(180deg, #EFE7D3 0%, #F4EEDF 26%, #ECE4D0 58%, #E6DCC7 100%)",
    overflow: "hidden" as const,
  },
  sectionEyebrow: {
    fontSize: 12,
    fontWeight: 600,
    textTransform: "uppercase" as const,
    letterSpacing: "0.3em",
    color: palette.portlandOrange,
    textAlign: "center" as const,
  },
  sectionTitle: {
    fontSize: "clamp(28px, 4vw, 44px)",
    fontWeight: 800,
    letterSpacing: "-0.03em",
    textAlign: "center" as const,
    marginTop: 12,
    color: palette.darkBlue,
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
    border: `1px solid ${color}55`,
    background: "rgba(255,255,255,0.34)",
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
    opacity: 0.08,
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
    color: palette.darkBlue,
    marginBottom: 8,
  },
  cardDesc: {
    fontSize: 14,
    lineHeight: 1.6,
    color: "rgba(26,0,137,0.72)",
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
    background: "linear-gradient(135deg, #1A0089, #2510A0)",
    WebkitBackgroundClip: "text",
    WebkitTextFillColor: "transparent",
  },
  downloadSub: {
    fontSize: 15,
    lineHeight: 1.6,
    color: "rgba(26,0,137,0.72)",
    marginTop: 16,
  },
  downloadNote: {
    fontSize: 12,
    color: "rgba(26,0,137,0.5)",
    marginTop: 24,
  },
  footer: {
    borderTop: "1px solid rgba(26,0,137,0.08)",
    padding: "24px 40px",
    textAlign: "center" as const,
    fontSize: 13,
    color: "rgba(26,0,137,0.5)",
  },
  footerLink: {
    color: palette.portlandOrange,
    textDecoration: "underline",
    transition: "color 0.2s",
  },
  divider: {
    width: "100%",
    height: 120,
    background: "linear-gradient(180deg, #F1EADB 0%, #ECE4D0 100%)",
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
    const frame = window.requestAnimationFrame(() => {
      setMounted(true);
    });

    return () => {
      window.cancelAnimationFrame(frame);
    };
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
        {/* Radial glow behind text */}
        <div style={{
          position: "absolute",
          top: "30%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          width: 600,
          height: 400,
          borderRadius: "50%",
          background: "radial-gradient(ellipse, rgba(255,94,57,0.14) 0%, rgba(183,207,79,0.1) 42%, transparent 72%)",
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

        <div style={s.terrainWrap}>
          {mounted && <CortexTerrain />}
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
          borderRadius: "50%", background: "radial-gradient(circle, rgba(255,94,57,0.08) 0%, transparent 70%)",
          filter: "blur(80px)", pointerEvents: "none", zIndex: 0,
        }} />
        <div style={{
          position: "absolute", top: "40%", right: "10%", width: 350, height: 350,
          borderRadius: "50%", background: "radial-gradient(circle, rgba(183,207,79,0.1) 0%, transparent 70%)",
          filter: "blur(80px)", pointerEvents: "none", zIndex: 0,
        }} />
        <div style={{
          position: "absolute", bottom: "20%", left: "30%", width: 300, height: 300,
          borderRadius: "50%", background: "radial-gradient(circle, rgba(26,0,137,0.06) 0%, transparent 70%)",
          filter: "blur(80px)", pointerEvents: "none", zIndex: 0,
        }} />

        {/* ──── FEATURES ──── */}
        <section style={s.section}>
          <p style={s.sectionEyebrow}>What&apos;s inside</p>
          <h2 style={s.sectionTitle}>Built for the multi-agent era</h2>
        <div style={s.grid}>
          {features.map((f) => (
            <div
              key={f.title}
              style={s.card(f.color)}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLDivElement).style.borderColor = `${f.color}88`;
                (e.currentTarget as HTMLDivElement).style.background = "rgba(255, 255, 255, 0.52)";
                (e.currentTarget as HTMLDivElement).style.boxShadow = `0 20px 60px ${f.color}12, 0 0 40px ${f.color}08`;
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLDivElement).style.borderColor = `${f.color}55`;
                (e.currentTarget as HTMLDivElement).style.background = "rgba(255, 255, 255, 0.34)";
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
          <a href="https://github.com/hurttlocker/cortex-ide/releases/latest" target="_blank" rel="noreferrer" style={{ ...s.ctaPrimary, padding: "16px 40px", fontSize: 16, color: palette.whiteChocolate }}>
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
