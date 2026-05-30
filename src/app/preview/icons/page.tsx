'use client';

/**
 * /preview/icons — A/B/C comparison: Lucide vs Tabler vs Iconoir.
 *
 * Lucide and Tabler React components don't render in Tauri webview, so
 * this page imports each icon's __iconNode raw data and renders via
 * inline <svg> — the same pattern as src/components/desktop/lucide-shims.tsx.
 * Iconoir's React components render correctly in Tauri so they import normally.
 */

import { createElement, type SVGProps } from 'react';

// ── Lucide raw nodes ──
import { __iconNode as LucideSearchNode } from 'lucide-react/dist/esm/icons/search.js';
import { __iconNode as LucideFolderNode } from 'lucide-react/dist/esm/icons/folder.js';
import { __iconNode as LucideSettingsNode } from 'lucide-react/dist/esm/icons/settings.js';
import { __iconNode as LucidePlusNode } from 'lucide-react/dist/esm/icons/plus.js';
import { __iconNode as LucideChevronDownNode } from 'lucide-react/dist/esm/icons/chevron-down.js';
import { __iconNode as LucidePlayNode } from 'lucide-react/dist/esm/icons/play.js';
import { __iconNode as LucideMessageSquareNode } from 'lucide-react/dist/esm/icons/message-square.js';
import { __iconNode as LucideTerminalNode } from 'lucide-react/dist/esm/icons/terminal.js';
import { __iconNode as LucideZapNode } from 'lucide-react/dist/esm/icons/zap.js';
import { __iconNode as LucideGitBranchNode } from 'lucide-react/dist/esm/icons/git-branch.js';

// ── Tabler raw nodes ──
import { __iconNode as TablerSearchNode } from '@tabler/icons-react/dist/esm/icons/IconSearch.mjs';
import { __iconNode as TablerFolderNode } from '@tabler/icons-react/dist/esm/icons/IconFolder.mjs';
import { __iconNode as TablerSettingsNode } from '@tabler/icons-react/dist/esm/icons/IconSettings.mjs';
import { __iconNode as TablerPlusNode } from '@tabler/icons-react/dist/esm/icons/IconPlus.mjs';
import { __iconNode as TablerChevronDownNode } from '@tabler/icons-react/dist/esm/icons/IconChevronDown.mjs';
import { __iconNode as TablerPlayNode } from '@tabler/icons-react/dist/esm/icons/IconPlayerPlay.mjs';
import { __iconNode as TablerMessageNode } from '@tabler/icons-react/dist/esm/icons/IconMessage.mjs';
import { __iconNode as TablerTerminalNode } from '@tabler/icons-react/dist/esm/icons/IconTerminal2.mjs';
import { __iconNode as TablerBoltNode } from '@tabler/icons-react/dist/esm/icons/IconBolt.mjs';
import { __iconNode as TablerGitBranchNode } from '@tabler/icons-react/dist/esm/icons/IconGitBranch.mjs';

// ── Iconoir React components (render fine in Tauri) ──
import {
  Search as IconoirSearch,
  Folder as IconoirFolder,
  Settings as IconoirSettings,
  Plus as IconoirPlus,
  NavArrowDown as IconoirChevronDown,
  Play as IconoirPlay,
  ChatBubble as IconoirChat,
  Terminal as IconoirTerminal,
  Flash as IconoirZap,
  GitFork as IconoirGitBranch,
} from 'iconoir-react';

const FONT = 'var(--font-sans-system)';

type IconNodeTuple = readonly [string, Record<string, string | number>];
type IconNodeData = ReadonlyArray<IconNodeTuple>;

interface RawIconProps {
  node: IconNodeData;
  size: number;
  /** Tabler ships with viewBox 0 0 24 24 + native strokeWidth 2 — same as
   *  Lucide. If a set needs a different viewBox, pass it here. */
  viewBox?: string;
}

function RawIcon({ node, size, viewBox = '0 0 24 24' }: RawIconProps) {
  const children = node.map(([tag, attrs], index) =>
    createElement(tag, { ...attrs, key: attrs.key ?? `node-${index}` }),
  );
  const svgProps: SVGProps<SVGSVGElement> = {
    xmlns: 'http://www.w3.org/2000/svg',
    width: size,
    height: size,
    viewBox,
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
  };
  return createElement('svg', svgProps, ...children);
}

interface Row {
  label: string;
  lucide: IconNodeData;
  tabler: IconNodeData;
  Iconoir: React.ComponentType<{ width?: number; height?: number; strokeWidth?: number; color?: string }>;
  notes?: string;
}

const ROWS: Row[] = [
  { label: 'Search', lucide: LucideSearchNode, tabler: TablerSearchNode, Iconoir: IconoirSearch },
  { label: 'Folder', lucide: LucideFolderNode, tabler: TablerFolderNode, Iconoir: IconoirFolder },
  { label: 'Settings', lucide: LucideSettingsNode, tabler: TablerSettingsNode, Iconoir: IconoirSettings },
  { label: 'Plus', lucide: LucidePlusNode, tabler: TablerPlusNode, Iconoir: IconoirPlus },
  { label: 'ChevronDown', lucide: LucideChevronDownNode, tabler: TablerChevronDownNode, Iconoir: IconoirChevronDown, notes: 'Iconoir uses NavArrowDown' },
  { label: 'Play', lucide: LucidePlayNode, tabler: TablerPlayNode, Iconoir: IconoirPlay },
  { label: 'Chat', lucide: LucideMessageSquareNode, tabler: TablerMessageNode, Iconoir: IconoirChat },
  { label: 'Terminal', lucide: LucideTerminalNode, tabler: TablerTerminalNode, Iconoir: IconoirTerminal },
  { label: 'Bolt / Zap', lucide: LucideZapNode, tabler: TablerBoltNode, Iconoir: IconoirZap, notes: 'Iconoir uses Flash' },
  { label: 'Git branch', lucide: LucideGitBranchNode, tabler: TablerGitBranchNode, Iconoir: IconoirGitBranch, notes: 'Iconoir uses GitFork' },
];

export default function IconComparisonPage() {
  return (
    <div
      style={{
        minHeight: '100vh',
        background: 'var(--t-bg, #f8f8f6)',
        color: 'var(--t-text, #111827)',
        fontFamily: FONT,
        paddingTop: 40,
        paddingBottom: 80,
        paddingLeft: 40,
        paddingRight: 40,
      }}
    >
      <header style={{ maxWidth: 980, margin: '0 auto', marginBottom: 24 }}>
        <h1 style={{ fontSize: 22, fontWeight: 440, letterSpacing: '-0.4px', margin: 0 }}>
          Icon library compare
        </h1>
        <p style={{ fontSize: 13, color: 'var(--t-text-muted, #6b7280)', marginTop: 6, lineHeight: 1.5, maxWidth: 720 }}>
          Same icon, three libraries. All rendered as raw SVG (Tauri-compatible). Pick the column that feels right per row — or pick one library wholesale.
        </p>
      </header>

      <div style={{ maxWidth: 980, margin: '0 auto' }}>
        <ComparisonGrid size={14} label="Chrome density (14px)" />
        <div style={{ height: 32 }} />
        <ComparisonGrid size={18} label="Slightly larger (18px)" />
        <div style={{ height: 32 }} />
        <ComparisonGrid size={24} label="Hero / dashboard (24px)" />
      </div>

      <section style={{ maxWidth: 980, margin: '40px auto 0 auto', borderTop: '1px solid var(--t-divider, #e5e7eb)', paddingTop: 16 }}>
        <h2 style={{ fontSize: 13, fontWeight: 440, letterSpacing: '-0.2px', margin: 0, marginBottom: 6 }}>
          Notes
        </h2>
        <ul style={{ fontSize: 11.5, color: 'var(--t-text-muted)', lineHeight: 1.5, paddingLeft: 16, margin: 0 }}>
          <li><strong>Lucide</strong> — friendly, slightly rounded, default in the app. ~1,500 icons. (Rendered via __iconNode raw SVG to bypass the Tauri webview bug.)</li>
          <li><strong>Tabler</strong> — tighter, more geometric. 5,400+ icons (3-4× Lucide). (Same raw-SVG render path.)</li>
          <li><strong>Iconoir</strong> — more personality, looser strokes, hand-crafted feel. ~1,600 icons. (React components render natively.)</li>
          <li>All shown at strokeWidth: 2 with rounded line caps/joins so the visual difference is glyph design only.</li>
        </ul>
      </section>
    </div>
  );
}

function ComparisonGrid({ size, label }: { size: number; label: string }) {
  return (
    <section>
      <h3 style={{ fontSize: 12, fontWeight: 440, letterSpacing: '-0.1px', color: 'var(--t-text-muted)', margin: 0, marginBottom: 10 }}>
        {label}
      </h3>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(140px, 1fr) repeat(3, minmax(140px, 1fr)) minmax(140px, 1.4fr)',
          gap: 0,
          background: 'var(--t-panel, #ffffff)',
          border: '1px solid var(--t-divider, #e5e7eb)',
          borderRadius: 10,
          overflow: 'hidden',
        }}
      >
        <HeaderCell>Glyph</HeaderCell>
        <HeaderCell>Lucide</HeaderCell>
        <HeaderCell>Tabler</HeaderCell>
        <HeaderCell>Iconoir</HeaderCell>
        <HeaderCell>Notes</HeaderCell>
        {ROWS.map((row) => (
          <RowCells key={row.label} row={row} size={size} />
        ))}
      </div>
    </section>
  );
}

function HeaderCell({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        paddingTop: 8,
        paddingBottom: 8,
        paddingLeft: 14,
        paddingRight: 14,
        fontSize: 10,
        fontWeight: 300,
        letterSpacing: '-0.1px',
        color: 'var(--t-text-faint)',
        background: 'var(--t-bg, #fafafa)',
        borderBottom: '1px solid var(--t-divider, #e5e7eb)',
      }}
    >
      {children}
    </div>
  );
}

function RowCells({ row, size }: { row: Row; size: number }) {
  const cellStyle = {
    paddingTop: 10,
    paddingBottom: 10,
    paddingLeft: 14,
    paddingRight: 14,
    borderBottom: '1px solid var(--t-divider-subtle, #f0f0f0)',
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  } as const;

  return (
    <>
      <div style={cellStyle}>
        <span style={{ fontSize: 12.5, fontWeight: 300, letterSpacing: '-0.1px', color: 'var(--t-text)' }}>
          {row.label}
        </span>
      </div>
      <div style={cellStyle}>
        <RawIcon node={row.lucide} size={size} />
      </div>
      <div style={cellStyle}>
        <RawIcon node={row.tabler} size={size} />
      </div>
      <div style={cellStyle}>
        <row.Iconoir width={size} height={size} strokeWidth={2} color="currentColor" />
      </div>
      <div style={cellStyle}>
        <span style={{ fontSize: 11, fontWeight: 260, letterSpacing: '-0.4px', color: 'var(--t-text-faint)' }}>
          {row.notes ?? ''}
        </span>
      </div>
    </>
  );
}
