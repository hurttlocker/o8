'use client';

import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import {
  Brain,
  Check,
  ChevronRight,
  Copy,
  Crosshair,
  ExternalLink,
  FileCode,
  FileText,
  GitBranch,
  Globe,
  Lightbulb,
  Loader2,
  MessageSquare,
  MoreHorizontal,
  Search,
  Send,
  Sparkles,
  Terminal,
  Wrench,
  Zap,
  type LucideIcon,
} from '@/components/desktop/lucide-shims';
import { DesktopToolCallStack } from '@/components/desktop/DesktopToolCallStack';
import { ChainOfThought as CurrentChainOfThought } from '@/components/desktop/llm-chat/ChainOfThought';
import type { ThinkingStep } from '@/components/desktop/llm-chat/shared';
import type { MobileTranscriptToolCall } from '@/lib/mobile/types';

const FONT_FAMILY = 'var(--font-sans-system)';
const MONO_FAMILY = '"SF Mono", "SFMono-Regular", ui-monospace, Menlo, Consolas, monospace';

const KEYFRAMES = `
@keyframes o8-dash-travel {
  0%   { stroke-dashoffset: 0; }
  100% { stroke-dashoffset: -100; }
}

@keyframes preview-pulse {
  0%, 100% { opacity: 0.42; transform: scale(0.92); }
  50% { opacity: 1; transform: scale(1); }
}

@keyframes preview-spin {
  to { transform: rotate(360deg); }
}

@keyframes preview-loader-dot {
  0%, 80%, 100% { opacity: 0.28; transform: translateY(0); }
  40% { opacity: 1; transform: translateY(-2px); }
}

@keyframes preview-text-loader {
  0%, 100% { opacity: 0.46; }
  50% { opacity: 1; }
}
`;

const INFINITY_PATH = 'M-12,0 C-12,-7 -4,-7 0,0 C4,7 12,7 12,0 C12,-7 4,-7 0,0 C-4,7 -12,7 -12,0Z';

type Mode = 'idle' | 'thinking' | 'working' | 'attention' | 'error' | 'offline';

const MODES: { mode: Mode; label: string; desc: string; color: string }[] = [
  { mode: 'working', label: 'Working', desc: 'Actively coding - fast, confident loop', color: '#16a34a' },
  { mode: 'thinking', label: 'Thinking', desc: 'Reviewing, waiting, planning - slow drift', color: '#2563eb' },
  { mode: 'attention', label: 'Attention', desc: 'Merge ready, needs operator - warm glow', color: '#f97316' },
  { mode: 'error', label: 'Blocked', desc: 'Error or blocked - urgent red', color: '#ef4444' },
  { mode: 'idle', label: 'Idle', desc: 'Connected but quiet - dim static path', color: '#64748b' },
  { mode: 'offline', label: 'Offline', desc: 'Disconnected - barely visible', color: '#6b7280' },
];

const SIZES = [0.5, 0.65, 0.8, 1, 1.4, 2];

const TYPE_SAMPLES = [
  {
    label: 'Assistant body',
    meta: '14px / 400 / 1.6',
    size: 14,
    weight: 400,
    lineHeight: 1.6,
    text: 'I found the transcript surface and narrowed the change to the isolated preview route.',
  },
  {
    label: 'User prompt',
    meta: '13px / 500 / 1.55',
    size: 13,
    weight: 500,
    lineHeight: 1.55,
    text: 'Can we compare the thinking strip, tool cards, and message action row before wiring it in?',
  },
  {
    label: 'Reasoning label',
    meta: '11px mono / 600',
    size: 11,
    weight: 600,
    lineHeight: 1.35,
    mono: true,
    text: '(THINKING · 184 tokens)',
  },
  {
    label: 'Tool output',
    meta: '12px mono / 400',
    size: 12,
    weight: 400,
    lineHeight: 1.55,
    mono: true,
    text: 'src/components/desktop/llm-chat/ChainOfThought.tsx',
  },
];

const FONT_CANDIDATES = [
  {
    label: 'Current',
    name: 'system UI',
    family: FONT_FAMILY,
    note: 'Current app default. Design doc calls this locked.',
  },
  {
    label: 'System',
    name: 'Apple system',
    family: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", "Segoe UI", Roboto, system-ui, sans-serif',
    note: 'Direct OS stack without a CSS variable wrapper.',
  },
];

const CHAT_TEXT_SCALES = {
  small: {
    label: 'Small',
    user: 12.5,
    assistant: 13,
    reasoningTitle: 12,
    reasoningBody: 11,
    steps: 12,
    source: 11,
    toolTitle: 11.5,
    toolDetail: 10.5,
    meta: 10.5,
    lineHeight: 1.5,
  },
  chat: {
    label: 'Chat',
    user: 13,
    assistant: 14,
    reasoningTitle: 14,
    reasoningBody: 13,
    steps: 13,
    source: 12,
    toolTitle: 12,
    toolDetail: 11,
    meta: 11,
    lineHeight: 1.6,
  },
  large: {
    label: 'Large',
    user: 14,
    assistant: 15,
    reasoningTitle: 16,
    reasoningBody: 15,
    steps: 15,
    source: 13,
    toolTitle: 13,
    toolDetail: 12,
    meta: 12,
    lineHeight: 1.62,
  },
};

type ChatTextScale = (typeof CHAT_TEXT_SCALES)[keyof typeof CHAT_TEXT_SCALES];

const CHANGE_TARGETS: { icon: LucideIcon; label: string; value: string; color: string }[] = [
  { icon: Brain, label: 'Thought surface', value: 'strip, rail, or card', color: '#2563eb' },
  { icon: Wrench, label: 'Tool calls', value: 'compact vs expanded', color: '#64748b' },
  { icon: FileCode, label: 'Changed files', value: 'diff capsule style', color: '#16a34a' },
  { icon: MessageSquare, label: 'Message rhythm', value: 'bubble width and spacing', color: '#f97316' },
  { icon: Sparkles, label: 'Live state', value: 'streaming and waiting', color: '#0f766e' },
  { icon: MoreHorizontal, label: 'Action row', value: 'copy, retry, fork', color: '#475569' },
];

const THOUGHT_STEPS = [
  { icon: Search, title: 'Scan transcript shape', body: 'Matched the preview to current desktop chat pieces.', status: 'done' },
  { icon: FileText, title: 'Read active styling', body: 'Kept system body text and SF Mono status labels.', status: 'done' },
  { icon: Zap, title: 'Select chat treatment', body: 'Compare strip, rail, and docked card before implementation.', status: 'active' },
];

type AdvancedReasoningItem = {
  text: string;
  lead?: string;
  code?: string;
  language?: string;
};

const ADVANCED_REASONING_STEPS: {
  icon: LucideIcon;
  title: string;
  items: AdvancedReasoningItem[];
}[] = [
  {
    icon: Search,
    title: 'Research phase: Understanding the chat surface',
    items: [
      { text: 'The problem is showing summarized reasoning in a dense agent transcript without making the chat feel noisy.' },
      { text: 'Current surfaces already expose thinking, tool calls, file changes, model metadata, and message actions.' },
      { text: 'The preview should stay sandboxed so we can judge the interaction before changing the real chat runtime.' },
    ],
  },
  {
    icon: Lightbulb,
    title: 'Analysis: Identifying display opportunities',
    items: [
      { text: 'A trigger row gives the operator a readable headline while keeping detailed reasoning out of the way.' },
      { text: 'Nested items are better than one long raw-thinking block because each step can carry evidence or code.' },
      { text: 'The line, icons, and chevron need to feel like chat infrastructure, not a separate widget library.' },
      { text: 'Code blocks inside reasoning should use the same compact mono grammar as tool output and file previews.' },
    ],
  },
  {
    icon: Crosshair,
    title: 'Solution: Implementing targeted improvements',
    items: [
      {
        lead: 'Step 1:',
        text: 'Add a composite reasoning preview with collapsible sections.',
        code: `type ReasoningStep = {
  title: string;
  icon: LucideIcon;
  items: ReasoningItem[];
};`,
        language: 'typescript',
      },
      {
        lead: 'Step 2:',
        text: 'Keep the content model close to Prompt Kit: trigger, content, item, and optional code.',
        code: `<ChainOfThoughtStep>
  <ChainOfThoughtTrigger leftIcon={<Search />}>
    Research phase
  </ChainOfThoughtTrigger>
  <ChainOfThoughtContent>
    <ChainOfThoughtItem>Summarized finding</ChainOfThoughtItem>
  </ChainOfThoughtContent>
</ChainOfThoughtStep>`,
        language: 'tsx',
      },
      {
        lead: 'Step 3:',
        text: 'Only graduate this into the real chat after the preview feels right in the browser.',
      },
    ],
  },
];

const MOCK_SOURCE_ITEMS = [
  {
    label: '1',
    domain: 'prompt-kit.com',
    title: 'Prompt Kit Steps',
    href: 'https://www.prompt-kit.com/docs/steps',
    description: 'Collapsible operation sequences for reasoning traces, tool calls, and process logs.',
  },
  {
    label: '2',
    domain: 'prompt-kit.com',
    title: 'Prompt Kit Source',
    href: 'https://www.prompt-kit.com/docs/source',
    description: 'Source triggers that expose URL details, titles, and descriptions.',
  },
  {
    label: '3',
    domain: 'cortex-ide',
    title: 'Local Preview Route',
    href: 'http://localhost:3010/preview',
    description: 'The isolated route where chat pieces can be judged before runtime wiring.',
  },
];

const MOCK_RUN_STEPS = [
  'Web search: Prompt Kit steps and source patterns',
  'Map docs into local preview-only components',
  'Render reasoning, steps, sources, tools, and files together',
  'Run lint and typecheck before graduating any chat change',
];

const CURRENT_REASONING_STEPS: ThinkingStep[] = [
  { type: 'search', label: 'Scanned current chat components', description: 'Read the existing chain-of-thought and tool stack.', status: 'complete' },
  { type: 'tool', label: 'Mapped current tool rendering', description: 'Current tools use DesktopToolCallStack in the transcript.', status: 'complete' },
  { type: 'analyzing', label: 'Comparing proposed treatments', description: 'Keeping current behavior selectable beside the mock additions.', status: 'active' },
];

const CURRENT_TOOL_CALLS: MobileTranscriptToolCall[] = [
  {
    id: 'mock-search',
    name: 'search_code',
    status: 'done',
    args: { query: 'DesktopToolCallStack ChainOfThought preview' },
  },
  {
    id: 'mock-read',
    name: 'read_file',
    status: 'done',
    args: { path: 'src/components/desktop/llm-chat/ChainOfThought.tsx' },
  },
  {
    id: 'mock-edit',
    name: 'edit_file',
    status: 'done',
    args: {
      path: 'src/app/preview/page.tsx',
      old_string: 'toolMode: rail',
      new_string: 'toolMode: current',
    },
  },
];

function InfinityGlow({ color, mode = 'idle', size = 1 }: { color: string; mode?: Mode; size?: number }) {
  const w = Math.round(28 * size);
  const h = Math.round(14 * size);
  const stroke = 1.2 * size;

  if (mode === 'idle') {
    return (
      <svg width={w} height={h} viewBox="-14 -8 28 16" style={{ overflow: 'visible' }}>
        <path d={INFINITY_PATH} fill="none" stroke={`${color}33`} strokeWidth={stroke} strokeLinecap="round" />
      </svg>
    );
  }

  if (mode === 'offline') {
    return (
      <svg width={w} height={h} viewBox="-14 -8 28 16" style={{ overflow: 'visible', opacity: 0.35 }}>
        <path d={INFINITY_PATH} fill="none" stroke={`${color}22`} strokeWidth={stroke} strokeLinecap="round" />
      </svg>
    );
  }

  const config = {
    thinking: { speed: 3.2, dashOn: 10, dashOff: 40, glow: 0.4, pathOpacity: '18' },
    working: { speed: 1.8, dashOn: 14, dashOff: 36, glow: 0.7, pathOpacity: '22' },
    attention: { speed: 1.2, dashOn: 18, dashOff: 32, glow: 0.9, pathOpacity: '28' },
    error: { speed: 0.8, dashOn: 20, dashOff: 30, glow: 1.0, pathOpacity: '30' },
  }[mode] ?? { speed: 3, dashOn: 10, dashOff: 40, glow: 0.4, pathOpacity: '18' };

  return (
    <svg width={w} height={h} viewBox="-14 -8 28 16" style={{ overflow: 'visible' }}>
      <path d={INFINITY_PATH} fill="none" stroke={`${color}${config.pathOpacity}`} strokeWidth={stroke} strokeLinecap="round" />
      <path
        d={INFINITY_PATH}
        fill="none"
        stroke={color}
        strokeWidth={stroke + 2}
        strokeLinecap="round"
        strokeDasharray={`${config.dashOn} ${config.dashOff}`}
        style={{ animation: `o8-dash-travel ${config.speed}s linear infinite`, filter: 'blur(3px)', opacity: config.glow * 0.5 }}
      />
      <path
        d={INFINITY_PATH}
        fill="none"
        stroke={color}
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={`${config.dashOn} ${config.dashOff}`}
        style={{ animation: `o8-dash-travel ${config.speed}s linear infinite`, filter: `drop-shadow(0 0 2px ${color})` }}
      />
    </svg>
  );
}

function SectionHeader({ label, title, detail }: { label: string; title: string; detail: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: '0.18em', color: '#64748b', textTransform: 'uppercase' }}>
        {label}
      </span>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 20, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0, color: '#0f172a', fontSize: 24, lineHeight: 1.05, fontWeight: 800, letterSpacing: 0 }}>
          {title}
        </h2>
        <p style={{ maxWidth: 560, margin: 0, color: '#64748b', fontSize: 13, lineHeight: 1.55 }}>
          {detail}
        </p>
      </div>
    </div>
  );
}

function PreviewShell({ children, style }: { children: React.ReactNode; style?: CSSProperties }) {
  return (
    <section
      style={{
        border: '1px solid rgba(148, 163, 184, 0.18)',
        borderRadius: 18,
        background: 'rgba(255, 255, 255, 0.72)',
        boxShadow: '0 22px 70px rgba(15, 23, 42, 0.08)',
        padding: 18,
        ...style,
      }}
    >
      {children}
    </section>
  );
}

function StatusPill({ children, color = '#2563eb' }: { children: React.ReactNode; color?: string }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        minHeight: 24,
        padding: '3px 9px',
        borderRadius: 999,
        background: `${color}12`,
        border: `1px solid ${color}24`,
        color,
        fontSize: 10,
        fontWeight: 800,
        letterSpacing: '0.02em',
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </span>
  );
}

function FontCandidateCard({ candidate }: { candidate: (typeof FONT_CANDIDATES)[number] }) {
  return (
    <PreviewShell style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
        <div>
          <div style={{ color: '#0f172a', fontSize: 15, fontWeight: 850, fontFamily: candidate.family }}>{candidate.name}</div>
          <div style={{ marginTop: 4, color: '#64748b', fontSize: 11, lineHeight: 1.4 }}>{candidate.note}</div>
        </div>
        <StatusPill color={candidate.label === 'Current' ? '#16a34a' : '#64748b'}>{candidate.label}</StatusPill>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, fontFamily: candidate.family }}>
        <div
          style={{
            alignSelf: 'flex-end',
            maxWidth: '82%',
            padding: '9px 13px',
            borderRadius: '15px 15px 5px 15px',
            background: 'rgba(37, 99, 235, 0.10)',
            border: '1px solid rgba(37, 99, 235, 0.12)',
            color: '#0f172a',
            fontSize: 13,
            lineHeight: 1.55,
            fontWeight: 500,
          }}
        >
          Show the reasoning without making it feel like another card stack.
        </div>
        <div style={{ color: '#0f172a', fontSize: 14, lineHeight: 1.65, fontWeight: 400 }}>
          I would keep the chain quiet, use icons as anchors, and let the answer text stay visually dominant.
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#94a3b8', fontSize: 11 }}>
          <Brain size={12} strokeWidth={2.2} />
          3 reasoning steps · 612 tokens · preview only
        </div>
      </div>
    </PreviewShell>
  );
}

function IconButton({ icon: Icon, label }: { icon: LucideIcon; label: string }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 30,
        height: 30,
        borderRadius: 10,
        border: '1px solid rgba(148, 163, 184, 0.2)',
        background: 'rgba(255, 255, 255, 0.72)',
        color: '#64748b',
        cursor: 'default',
      }}
    >
      <Icon size={14} strokeWidth={2.2} />
    </button>
  );
}

function PreviewCodeBlock({ code, language }: { code: string; language: string }) {
  return (
    <div
      style={{
        marginTop: 9,
        overflow: 'hidden',
        borderRadius: 11,
        border: '1px solid rgba(15, 23, 42, 0.08)',
        background: '#0f172a',
        boxShadow: 'inset 0 1px 0 rgba(255, 255, 255, 0.06)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          padding: '7px 10px',
          borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
          color: '#94a3b8',
          fontSize: 10,
          fontWeight: 800,
          fontFamily: MONO_FAMILY,
        }}
      >
        <span>{language}</span>
        <FileCode size={12} strokeWidth={2.2} />
      </div>
      <pre
        style={{
          margin: 0,
          padding: '11px 12px 12px',
          color: '#e2e8f0',
          fontSize: 11,
          lineHeight: 1.58,
          fontFamily: MONO_FAMILY,
          overflowX: 'auto',
          whiteSpace: 'pre',
        }}
      >
        {code}
      </pre>
    </div>
  );
}

function AdvancedChainOfThoughtPreview() {
  const [openSteps, setOpenSteps] = useState(() => new Set([0]));

  function toggleStep(index: number) {
    setOpenSteps((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }

  return (
    <div
      style={{
        maxWidth: 980,
        padding: '8px 0 4px',
      }}
    >
      <div style={{ marginBottom: 20 }}>
        <div style={{ color: '#0f172a', fontSize: 15, fontWeight: 850 }}>Prompt Kit-style chain</div>
        <div style={{ marginTop: 4, color: '#64748b', fontSize: 12, lineHeight: 1.55 }}>
          No reasoning cards. Just icon triggers, a thin rail, and indented text like the reference.
        </div>
      </div>

      <div>
        {ADVANCED_REASONING_STEPS.map((step, index) => {
          const Icon = step.icon;
          const expanded = openSteps.has(index);
          const isLast = index === ADVANCED_REASONING_STEPS.length - 1;

          return (
            <div key={step.title} style={{ display: 'grid', gridTemplateColumns: '32px minmax(0, 1fr)', columnGap: 14 }}>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 2 }}>
                <span
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: 28,
                    height: 28,
                    borderRadius: 999,
                    background: 'transparent',
                    border: 'none',
                    color: expanded ? '#6b7280' : '#7a7f8c',
                  }}
                >
                  {expanded ? (
                    <ChevronRight size={18} strokeWidth={2.4} style={{ transform: 'rotate(-90deg)' }} />
                  ) : (
                    <Icon size={22} strokeWidth={2} />
                  )}
                </span>
                {!isLast ? (
                  <span
                    style={{
                      width: 1,
                      flex: 1,
                      minHeight: expanded ? 118 : 28,
                      background: 'rgba(107, 114, 128, 0.24)',
                    }}
                  />
                ) : null}
              </div>

              <div style={{ paddingBottom: isLast ? 0 : 18 }}>
                <button
                  type="button"
                  aria-expanded={expanded}
                  onClick={() => toggleStep(index)}
                  style={{
                    width: '100%',
                    minHeight: 32,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    padding: 0,
                    borderRadius: 0,
                    border: 'none',
                    background: 'transparent',
                    color: '#6d707b',
                    cursor: 'pointer',
                    textAlign: 'left',
                    fontFamily: FONT_FAMILY,
                  }}
                >
                  <span style={{ minWidth: 0, fontSize: 20, fontWeight: 400, lineHeight: 1.3, letterSpacing: 0 }}>
                    {step.title}
                  </span>
                </button>

                {expanded ? (
                  <div
                    style={{
                      marginTop: 15,
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 16,
                    }}
                  >
                    {step.items.map((item, itemIndex) => (
                      <div
                        key={`${step.title}-${itemIndex}`}
                        style={{
                          color: '#6d707b',
                          fontSize: 20,
                          fontWeight: 400,
                          lineHeight: 1.35,
                          letterSpacing: 0,
                        }}
                      >
                        {item.lead ? <strong style={{ color: '#4b5563', fontWeight: 650 }}>{item.lead} </strong> : null}
                        {item.text}
                        {item.code ? <PreviewCodeBlock code={item.code} language={item.language ?? 'text'} /> : null}
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ThoughtStripPreview() {
  return (
    <PreviewShell style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <StatusPill>01</StatusPill>
        <h3 style={{ margin: 0, color: '#0f172a', fontSize: 15, fontWeight: 800 }}>Slim strip</h3>
      </div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          minWidth: 0,
          padding: '8px 10px',
          borderRadius: 11,
          border: '1px solid rgba(37, 99, 235, 0.18)',
          background: 'linear-gradient(180deg, rgba(37, 99, 235, 0.07), rgba(37, 99, 235, 0.025))',
          color: '#64748b',
          fontSize: 11,
          lineHeight: 1.35,
          fontFamily: MONO_FAMILY,
        }}
      >
        <span style={{ color: '#2563eb', whiteSpace: 'nowrap', fontWeight: 700 }}>(THINKING · 184 tokens)</span>
        <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          - Checking transcript layout, current tool cards, and message spacing.
        </span>
      </div>
      <p style={{ margin: 0, color: '#64748b', fontSize: 12, lineHeight: 1.55 }}>
        Lowest visual weight. Best when thinking should be visible but not compete with the answer.
      </p>
    </PreviewShell>
  );
}

function ThoughtRailPreview() {
  return (
    <PreviewShell style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <StatusPill color="#16a34a">02</StatusPill>
        <h3 style={{ margin: 0, color: '#0f172a', fontSize: 15, fontWeight: 800 }}>Step rail</h3>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 0, paddingLeft: 2 }}>
        {THOUGHT_STEPS.map((step, index) => {
          const Icon = step.icon;
          const done = step.status === 'done';
          const active = step.status === 'active';
          return (
            <div key={step.title} style={{ display: 'grid', gridTemplateColumns: '24px 1fr', gap: 10 }}>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                <span
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: 24,
                    height: 24,
                    borderRadius: 999,
                    background: done ? 'rgba(22, 163, 74, 0.1)' : active ? 'rgba(37, 99, 235, 0.11)' : '#f1f5f9',
                    border: `1px solid ${done ? 'rgba(22, 163, 74, 0.24)' : active ? 'rgba(37, 99, 235, 0.24)' : '#e2e8f0'}`,
                    color: done ? '#16a34a' : active ? '#2563eb' : '#94a3b8',
                  }}
                >
                  {done ? <Check size={12} strokeWidth={2.4} /> : <Icon size={12} strokeWidth={2.2} />}
                </span>
                {index < THOUGHT_STEPS.length - 1 ? <span style={{ width: 1, flex: 1, minHeight: 24, background: '#e2e8f0' }} /> : null}
              </div>
              <div style={{ paddingBottom: index < THOUGHT_STEPS.length - 1 ? 12 : 0 }}>
                <div style={{ color: active ? '#1d4ed8' : '#0f172a', fontSize: 13, fontWeight: 750 }}>{step.title}</div>
                <div style={{ marginTop: 3, color: '#64748b', fontSize: 12, lineHeight: 1.45 }}>{step.body}</div>
              </div>
            </div>
          );
        })}
      </div>
    </PreviewShell>
  );
}

function ThoughtCardPreview() {
  return (
    <PreviewShell style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <StatusPill color="#f97316">03</StatusPill>
        <h3 style={{ margin: 0, color: '#0f172a', fontSize: 15, fontWeight: 800 }}>Docked card</h3>
      </div>
      <div
        style={{
          borderRadius: 14,
          border: '1px solid rgba(249, 115, 22, 0.18)',
          background: 'linear-gradient(180deg, rgba(255, 247, 237, 0.95), rgba(255, 255, 255, 0.72))',
          padding: 13,
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 30,
              height: 30,
              borderRadius: 11,
              background: 'rgba(249, 115, 22, 0.12)',
              color: '#f97316',
            }}
          >
            <Brain size={15} strokeWidth={2.2} />
          </span>
          <div style={{ minWidth: 0 }}>
            <div style={{ color: '#0f172a', fontSize: 13, fontWeight: 800 }}>Reasoning summary</div>
            <div style={{ marginTop: 2, color: '#64748b', fontSize: 11 }}>3 steps · 8.4s</div>
          </div>
        </div>
        <p style={{ margin: 0, color: '#475569', fontSize: 12, lineHeight: 1.55 }}>
          Compared current chat spacing, checked reusable status treatments, and staged the preview route only.
        </p>
      </div>
    </PreviewShell>
  );
}

function ThoughtInlinePreview() {
  return (
    <PreviewShell style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <StatusPill color="#0f766e">04</StatusPill>
        <h3 style={{ margin: 0, color: '#0f172a', fontSize: 15, fontWeight: 800 }}>Inline turn</h3>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#2563eb', fontSize: 11, fontWeight: 800 }}>
          <Loader2 size={13} strokeWidth={2.2} style={{ animation: 'preview-spin 1s linear infinite' }} />
          Thinking through the chat preview
        </div>
        <div style={{ color: '#0f172a', fontSize: 13, lineHeight: 1.6 }}>
          I would keep this treatment only for active turns where motion helps the operator understand the model has not stalled.
        </div>
      </div>
    </PreviewShell>
  );
}

function DiffCapsulePreview() {
  return (
    <div
      style={{
        border: '1px solid rgba(148, 163, 184, 0.18)',
        borderRadius: 14,
        overflow: 'hidden',
        background: 'rgba(255, 255, 255, 0.68)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '10px 12px', borderBottom: '1px solid rgba(148, 163, 184, 0.16)' }}>
        <FileText size={14} color="#2563eb" />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ color: '#0f172a', fontSize: 12, fontWeight: 800 }}>1 file changed</div>
          <div style={{ color: '#64748b', fontSize: 11, fontFamily: MONO_FAMILY, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>src/app/preview/page.tsx</div>
        </div>
        <span style={{ color: '#16a34a', fontSize: 11, fontWeight: 900 }}>+214</span>
        <span style={{ color: '#ef4444', fontSize: 11, fontWeight: 900 }}>-0</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1, background: 'rgba(148, 163, 184, 0.14)' }}>
        <pre style={{ margin: 0, padding: 12, minHeight: 92, background: 'rgba(254, 242, 242, 0.72)', color: '#991b1b', fontSize: 11, lineHeight: 1.55, fontFamily: MONO_FAMILY, whiteSpace: 'pre-wrap' }}>- hidden inside chat only</pre>
        <pre style={{ margin: 0, padding: 12, minHeight: 92, background: 'rgba(240, 253, 244, 0.72)', color: '#166534', fontSize: 11, lineHeight: 1.55, fontFamily: MONO_FAMILY, whiteSpace: 'pre-wrap' }}>+ compare in preview first</pre>
      </div>
    </div>
  );
}

function SegmentControl({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 7, minWidth: 0 }}>
      <span style={{ color: '#64748b', fontSize: 10, fontWeight: 850, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
        {label}
      </span>
      <div
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 3,
          padding: 3,
          borderRadius: 12,
          border: '1px solid rgba(148, 163, 184, 0.18)',
          background: 'rgba(248, 250, 252, 0.74)',
          width: 'fit-content',
          maxWidth: '100%',
          flexWrap: 'wrap',
        }}
      >
        {options.map((option) => {
          const active = value === option.value;
          return (
            <button
              key={option.value}
              type="button"
              onClick={() => onChange(option.value)}
              style={{
                border: active ? '1px solid rgba(148, 163, 184, 0.28)' : '1px solid transparent',
                borderRadius: 9,
                background: active ? 'rgba(255, 255, 255, 0.84)' : 'transparent',
                color: active ? '#0f172a' : '#64748b',
                minHeight: 30,
                padding: '0 10px',
                fontSize: 11,
                fontWeight: 800,
                fontFamily: FONT_FAMILY,
                cursor: 'pointer',
              }}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function MockReasoningTimeline({ fontFamily, compact = false, scale }: { fontFamily: string; compact?: boolean; scale: ChatTextScale }) {
  const visibleSteps = compact ? ADVANCED_REASONING_STEPS.slice(0, 2) : ADVANCED_REASONING_STEPS;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 0, paddingTop: 2, fontFamily }}>
      {visibleSteps.map((step, index) => {
        const Icon = step.icon;
        const expanded = index === 0;
        const isLast = index === visibleSteps.length - 1;

        return (
          <div key={step.title} style={{ display: 'grid', gridTemplateColumns: '25px minmax(0, 1fr)', columnGap: 11 }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 1 }}>
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 22,
                  height: 22,
                  color: '#7a7f8c',
                }}
              >
                {expanded ? <ChevronRight size={16} strokeWidth={2.4} style={{ transform: 'rotate(-90deg)' }} /> : <Icon size={18} strokeWidth={2} />}
              </span>
              {!isLast ? <span style={{ width: 1, flex: 1, minHeight: expanded ? 88 : 26, background: 'rgba(107, 114, 128, 0.24)' }} /> : null}
            </div>
            <div style={{ paddingBottom: isLast ? 0 : 14 }}>
              <div style={{ color: '#6d707b', fontSize: scale.reasoningTitle, fontWeight: 400, lineHeight: 1.35 }}>
                {step.title}
              </div>
              {expanded ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: compact ? 7 : 9, marginTop: 8 }}>
                  {step.items.slice(0, compact ? 2 : 3).map((item) => (
                    <div key={item.text} style={{ color: '#6d707b', fontSize: scale.reasoningBody, fontWeight: 400, lineHeight: scale.lineHeight }}>
                      {item.text}
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function MockReasoningStrip({ fontFamily, scale }: { fontFamily: string; scale: ChatTextScale }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        minWidth: 0,
        padding: '7px 10px',
        borderRadius: 10,
        border: '1px solid rgba(37, 99, 235, 0.16)',
        background: 'rgba(37, 99, 235, 0.045)',
        color: '#64748b',
        fontSize: scale.meta,
        fontFamily: MONO_FAMILY,
      }}
    >
      <Brain size={13} color="#2563eb" />
      <span style={{ color: '#2563eb', fontWeight: 800, whiteSpace: 'nowrap' }}>(THINKING · 612 tokens)</span>
      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily }}>
        Preview route only, then decide what graduates into chat.
      </span>
    </div>
  );
}

function MockWorkingLoader({ mode, scale, fontFamily }: { mode: string; scale: ChatTextScale; fontFamily: string }) {
  if (mode === 'hidden') return null;

  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 7,
        width: 'fit-content',
        minHeight: 22,
        padding: '2px 0',
        color: '#64748b',
        fontSize: scale.meta,
        lineHeight: 1,
        fontFamily,
        fontWeight: 650,
      }}
    >
      <span style={{ color: '#94a3b8', fontFamily: MONO_FAMILY, fontWeight: 700 }}>agent</span>
      <span style={{ animation: mode === 'text' ? 'preview-text-loader 1.4s ease-in-out infinite' : undefined }}>
        {mode === 'text' ? 'thinking...' : 'working'}
      </span>
      {mode === 'dots' ? (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
          {[0, 1, 2].map((dot) => (
            <span
              key={dot}
              style={{
                width: 4,
                height: 4,
                borderRadius: 999,
                background: '#94a3b8',
                animation: `preview-loader-dot 1.15s ease-in-out ${dot * 0.14}s infinite`,
              }}
            />
          ))}
        </span>
      ) : null}
    </div>
  );
}

function MockCurrentReasoning() {
  return (
    <div
      style={{
        '--t-text': '#0f172a',
        '--t-text-secondary': '#64748b',
        '--t-text-muted': '#94a3b8',
        '--t-divider': 'rgba(148, 163, 184, 0.18)',
        '--t-panel-border': 'rgba(148, 163, 184, 0.18)',
        '--t-bg-card': 'rgba(248, 250, 252, 0.76)',
      } as CSSProperties}
    >
      <CurrentChainOfThought
        steps={CURRENT_REASONING_STEPS}
        thinking="Preview-only current chat reasoning: compact trigger, optional expanded steps, and raw thinking tucked behind another disclosure."
        durationMs={8400}
      />
    </div>
  );
}

function MockToolCalls({ mode, scale }: { mode: string; scale: ChatTextScale }) {
  const tools = [
    { icon: Search, label: 'Search', detail: 'chain-of-thought components', color: '#64748b', status: 'done' },
    { icon: FileText, label: 'Read', detail: 'src/app/preview/page.tsx', color: '#64748b', status: 'done' },
    { icon: Terminal, label: 'Check', detail: 'npm run typecheck', color: '#64748b', status: 'running' },
  ];

  if (mode === 'hidden') return null;

  if (mode === 'current') {
    return (
      <div
        style={{
          '--t-text': '#0f172a',
          '--t-text-secondary': '#64748b',
          '--t-text-muted': '#64748b',
          '--t-text-faint': '#94a3b8',
          '--t-border': 'rgba(148, 163, 184, 0.18)',
          '--t-panel': 'rgba(248, 250, 252, 0.66)',
          '--t-bg-subtle': 'rgba(241, 245, 249, 0.78)',
          '--t-success': '#64748b',
          '--t-danger': '#64748b',
          '--t-accent': '#64748b',
          '--t-divider-subtle': 'rgba(148, 163, 184, 0.16)',
          '--t-panel-translucent': 'rgba(255, 255, 255, 0.64)',
        } as CSSProperties}
      >
        <DesktopToolCallStack toolCalls={CURRENT_TOOL_CALLS} />
      </div>
    );
  }

  if (mode === 'inline') {
    return (
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {tools.map((tool) => (
          <StatusPill key={tool.label} color={tool.color}>
            {tool.status === 'running' ? <Loader2 size={11} style={{ animation: 'preview-spin 1s linear infinite' }} /> : <Check size={11} />}
            {tool.label}
          </StatusPill>
        ))}
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      {tools.map((tool) => {
        const Icon = tool.icon;
        return (
          <div
            key={tool.label}
            style={{
              display: 'grid',
              gridTemplateColumns: '22px minmax(0, 1fr) auto',
              alignItems: 'center',
              gap: 8,
              minHeight: scale === CHAT_TEXT_SCALES.small ? 30 : 34,
              padding: '6px 4px',
              borderBottom: '1px solid rgba(148, 163, 184, 0.14)',
            }}
          >
            <Icon size={15} strokeWidth={2.1} color={tool.color} />
            <div style={{ minWidth: 0 }}>
              <div style={{ color: '#334155', fontSize: scale.toolTitle, fontWeight: 800 }}>{tool.label}</div>
              <div style={{ color: '#64748b', fontSize: scale.toolDetail, fontFamily: MONO_FAMILY, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{tool.detail}</div>
            </div>
            {tool.status === 'running' ? <Loader2 size={13} color="#64748b" style={{ animation: 'preview-spin 1s linear infinite' }} /> : <Check size={13} color="#64748b" />}
          </div>
        );
      })}
    </div>
  );
}

function MockFileChange({ mode, scale }: { mode: string; scale: ChatTextScale }) {
  if (mode === 'hidden') return null;

  if (mode === 'current') {
    return (
      <div
        style={{
          '--t-text': '#0f172a',
          '--t-text-secondary': '#64748b',
          '--t-text-muted': '#64748b',
          '--t-text-faint': '#94a3b8',
          '--t-border': 'rgba(148, 163, 184, 0.18)',
          '--t-panel': 'rgba(248, 250, 252, 0.66)',
          '--t-bg-subtle': 'rgba(241, 245, 249, 0.78)',
          '--t-success': '#64748b',
          '--t-danger': '#64748b',
          '--t-accent': '#64748b',
          '--t-divider-subtle': 'rgba(148, 163, 184, 0.16)',
          '--t-panel-translucent': 'rgba(255, 255, 255, 0.64)',
        } as CSSProperties}
      >
        <DesktopToolCallStack toolCalls={CURRENT_TOOL_CALLS.slice(2)} />
      </div>
    );
  }

  if (mode === 'line') {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, color: '#64748b', fontSize: scale.source }}>
        <FileCode size={14} color="#64748b" />
        <span style={{ fontFamily: MONO_FAMILY, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>src/app/preview/page.tsx</span>
        <span style={{ color: '#64748b', fontWeight: 850 }}>+128</span>
        <span style={{ color: '#64748b', fontWeight: 850 }}>-22</span>
      </div>
    );
  }

  return <DiffCapsulePreview />;
}

function MockSources({ mode, scale }: { mode: string; scale: ChatTextScale }) {
  const [activeSource, setActiveSource] = useState(0);
  if (mode === 'hidden') return null;

  const active = MOCK_SOURCE_ITEMS[activeSource] ?? MOCK_SOURCE_ITEMS[0];
  const compact = mode === 'chips';
  const current = mode === 'current';

  return (
    <div style={{ display: 'flex', flexDirection: compact || current ? 'row' : 'column', gap: compact || current ? 6 : 8, alignItems: compact || current ? 'center' : 'stretch', flexWrap: 'wrap' }}>
      {MOCK_SOURCE_ITEMS.map((source, index) => (
        <a
          key={source.href}
          href={source.href}
          target="_blank"
          rel="noopener noreferrer"
          onMouseEnter={() => setActiveSource(index)}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            width: compact || current ? 'auto' : '100%',
            minHeight: compact || current ? 26 : 34,
            padding: compact || current ? '3px 8px' : '6px 9px',
            borderRadius: compact || current ? 999 : 9,
            border: current ? '1px solid rgba(37, 99, 235, 0.18)' : '1px solid rgba(148, 163, 184, 0.2)',
            background: current ? 'rgba(37, 99, 235, 0.06)' : index === activeSource ? 'rgba(255, 255, 255, 0.74)' : 'rgba(248, 250, 252, 0.62)',
            color: current ? '#2563eb' : '#64748b',
            textDecoration: 'none',
            fontSize: scale.source,
            fontWeight: current ? 600 : 700,
          }}
        >
          {current ? <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 16, height: 16, borderRadius: 999, background: '#2563eb', color: '#ffffff', fontSize: 9, fontWeight: 800 }}>{source.label}</span> : <Globe size={12} strokeWidth={2.1} />}
          <span>{compact || current ? source.domain : source.title}</span>
          {!compact && !current ? <span style={{ color: '#94a3b8', fontWeight: 500 }}>{source.domain}</span> : null}
          <ExternalLink size={11} strokeWidth={2.2} style={{ opacity: 0.65 }} />
        </a>
      ))}
      {!compact && !current ? (
        <div
          style={{
            padding: '8px 10px',
            borderRadius: 10,
            border: '1px solid rgba(148, 163, 184, 0.16)',
            background: 'rgba(255, 255, 255, 0.58)',
            color: '#64748b',
            fontSize: scale.source,
            lineHeight: 1.45,
          }}
        >
          <span style={{ display: 'block', color: '#334155', fontWeight: 800, marginBottom: 2 }}>{active.title}</span>
          {active.description}
        </div>
      ) : null}
    </div>
  );
}

function MockStepsBlock({ mode, sourceMode, scale }: { mode: string; sourceMode: string; scale: ChatTextScale }) {
  const [expanded, setExpanded] = useState(true);
  if (mode === 'hidden') return null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          minHeight: 30,
          padding: 0,
          border: 'none',
          background: 'transparent',
          color: '#64748b',
          cursor: 'pointer',
          fontFamily: FONT_FAMILY,
          fontSize: scale.steps,
          fontWeight: 750,
          textAlign: 'left',
        }}
      >
        <ChevronRight
          size={14}
          strokeWidth={2.3}
          style={{
            transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
            transition: 'transform 160ms cubic-bezier(0.22, 1, 0.36, 1)',
          }}
        />
        Agent run: refine chat preview
      </button>
      {expanded ? (
        <div style={{ display: 'grid', gridTemplateColumns: '18px minmax(0, 1fr)', gap: 9 }}>
          <div style={{ display: 'flex', justifyContent: 'center' }}>
            <span style={{ width: 2, minHeight: 126, borderRadius: 999, background: 'rgba(148, 163, 184, 0.24)' }} />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {MOCK_RUN_STEPS.map((step, index) => (
              <div key={step} style={{ color: '#64748b', fontSize: scale.steps, lineHeight: scale.lineHeight }}>
                {step}
                {mode === 'sources' && index === 1 && sourceMode !== 'hidden' ? (
                  <div style={{ marginTop: 8 }}>
                    <MockSources mode={sourceMode} scale={scale} />
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function CompositeChatPreview() {
  const [fontName, setFontName] = useState('system UI');
  const [sizeName, setSizeName] = useState<keyof typeof CHAT_TEXT_SCALES>('small');
  const [workingMode, setWorkingMode] = useState('dots');
  const [reasoningMode, setReasoningMode] = useState('current');
  const [stepsMode, setStepsMode] = useState('hidden');
  const [sourceMode, setSourceMode] = useState('chips');
  const [toolMode, setToolMode] = useState('current');
  const [fileMode, setFileMode] = useState('current');
  const [actionMode, setActionMode] = useState('current');
  const activeFont = FONT_CANDIDATES.find((font) => font.name === fontName) ?? FONT_CANDIDATES[0];
  const activeScale = CHAT_TEXT_SCALES[sizeName];

  return (
    <PreviewShell style={{ padding: 0, overflow: 'hidden', background: 'rgba(255, 255, 255, 0.78)' }}>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))',
          gap: 12,
          padding: 16,
          borderBottom: '1px solid rgba(148, 163, 184, 0.16)',
          background: 'rgba(248, 250, 252, 0.72)',
        }}
      >
        <SegmentControl
          label="Font"
          value={fontName}
          onChange={setFontName}
          options={FONT_CANDIDATES.map((font) => ({ value: font.name, label: font.name === 'system UI' ? 'System' : font.name.replace(' Sans', '') }))}
        />
        <SegmentControl
          label="Size"
          value={sizeName}
          onChange={(value) => setSizeName(value as keyof typeof CHAT_TEXT_SCALES)}
          options={Object.entries(CHAT_TEXT_SCALES).map(([value, scale]) => ({ value, label: scale.label }))}
        />
        <SegmentControl
          label="Working"
          value={workingMode}
          onChange={setWorkingMode}
          options={[
            { value: 'dots', label: 'Dots' },
            { value: 'text', label: 'Text' },
            { value: 'hidden', label: 'Off' },
          ]}
        />
        <SegmentControl
          label="Reasoning"
          value={reasoningMode}
          onChange={setReasoningMode}
          options={[
            { value: 'current', label: 'Current' },
            { value: 'timeline', label: 'Timeline' },
            { value: 'strip', label: 'Strip' },
            { value: 'off', label: 'Off' },
          ]}
        />
        <SegmentControl
          label="Steps"
          value={stepsMode}
          onChange={setStepsMode}
          options={[
            { value: 'compact', label: 'Compact' },
            { value: 'sources', label: 'Sources' },
            { value: 'hidden', label: 'Off' },
          ]}
        />
        <SegmentControl
          label="Sources"
          value={sourceMode}
          onChange={setSourceMode}
          options={[
            { value: 'current', label: 'Current' },
            { value: 'chips', label: 'Chips' },
            { value: 'details', label: 'Details' },
            { value: 'hidden', label: 'Off' },
          ]}
        />
        <SegmentControl
          label="Tools"
          value={toolMode}
          onChange={setToolMode}
          options={[
            { value: 'current', label: 'Current' },
            { value: 'rail', label: 'Rail' },
            { value: 'inline', label: 'Inline' },
            { value: 'hidden', label: 'Off' },
          ]}
        />
        <SegmentControl
          label="Files"
          value={fileMode}
          onChange={setFileMode}
          options={[
            { value: 'current', label: 'Current' },
            { value: 'capsule', label: 'Capsule' },
            { value: 'line', label: 'Line' },
            { value: 'hidden', label: 'Off' },
          ]}
        />
        <SegmentControl
          label="Actions"
          value={actionMode}
          onChange={setActionMode}
          options={[
            { value: 'current', label: 'Current' },
            { value: 'quiet', label: 'Quiet' },
          ]}
        />
      </div>
      <div
        style={{
          minHeight: 680,
          display: 'grid',
          gridTemplateRows: 'auto 1fr auto',
          background: '#f4f2ed',
          fontFamily: activeFont.family,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 28, padding: '5px 14px', borderBottom: '0.5px solid rgba(148, 163, 184, 0.18)', background: 'transparent' }}>
          <button
            type="button"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
              height: 24,
              padding: '0 9px 0 8px',
              borderWidth: 0,
              borderRadius: 7,
              background: 'transparent',
              color: '#64748b',
              fontSize: 11,
              fontWeight: 500,
              cursor: 'default',
              fontFamily: activeFont.family,
            }}
          >
            <MessageSquare size={12} strokeWidth={2.2} />
            History
          </button>
          <div style={{ flex: 1 }} />
          <span style={{ fontSize: 10.5, color: '#64748b', fontFamily: MONO_FAMILY, display: 'flex', alignItems: 'center', gap: 6 }}>
            <span>2 msgs</span>
            <span style={{ color: '#cbd5e1' }}>|</span>
            <span>1.4K tokens</span>
            <span style={{ color: '#cbd5e1' }}>|</span>
            <span>$0.0031</span>
          </span>
          <button
            type="button"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              padding: '3px 7px',
              borderWidth: 0,
              borderRadius: 6,
              background: 'transparent',
              color: '#64748b',
              fontSize: 11,
              fontWeight: 500,
              cursor: 'default',
              fontFamily: activeFont.family,
            }}
          >
            <GitBranch size={12} strokeWidth={2.2} />
            New
          </button>
        </div>

        <div style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 18 }}>
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <div
              style={{
                maxWidth: '78%',
                padding: '10px 14px',
                borderRadius: '16px 16px 5px 16px',
                background: 'rgba(37, 99, 235, 0.11)',
                border: '1px solid rgba(37, 99, 235, 0.12)',
                color: '#0f172a',
                fontSize: activeScale.user,
                lineHeight: activeScale.lineHeight,
                fontWeight: 500,
              }}
            >
              Show me the chat changes first: thinking, tools, file diffs, actions, and the composer density.
            </div>
          </div>

          <article style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: '88%' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#64748b', fontSize: 11, fontWeight: 800 }}>
              <Sparkles size={13} strokeWidth={2.2} />
              Assistant
            </div>
            <MockWorkingLoader mode={workingMode} scale={activeScale} fontFamily={activeFont.family} />
            {reasoningMode === 'current' ? <MockCurrentReasoning /> : null}
            {reasoningMode === 'timeline' ? <MockReasoningTimeline fontFamily={activeFont.family} compact scale={activeScale} /> : null}
            {reasoningMode === 'strip' ? <MockReasoningStrip fontFamily={activeFont.family} scale={activeScale} /> : null}
            <div style={{ color: '#0f172a', fontSize: activeScale.assistant, lineHeight: activeScale.lineHeight, fontWeight: 400 }}>
              I set this up as a sandbox so the real chat surface stays untouched. This view lets us judge reasoning, steps, sources, tools, file changes, actions, and chat font together instead of judging each piece in isolation.
            </div>
            <MockStepsBlock mode={stepsMode} sourceMode={sourceMode} scale={activeScale} />
            {stepsMode !== 'sources' && sourceMode !== 'hidden' ? <MockSources mode={sourceMode} scale={activeScale} /> : null}
            <MockToolCalls mode={toolMode} scale={activeScale} />
            <MockFileChange mode={fileMode} scale={activeScale} />
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
              <StatusPill color="#475569">preview only</StatusPill>
              <StatusPill color="#64748b">{activeFont.name}</StatusPill>
              <StatusPill color="#64748b">mock pieces</StatusPill>
            </div>
            {actionMode === 'current' ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, paddingTop: 2 }}>
                <span style={{ color: '#94a3b8', fontSize: activeScale.meta, marginRight: 6 }}>812 tok · $0.0031</span>
                <IconButton icon={Copy} label="Copy" />
                <IconButton icon={GitBranch} label="Fork from here" />
                <IconButton icon={MoreHorizontal} label="More" />
              </div>
            ) : (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingTop: 2, color: '#94a3b8', fontSize: activeScale.meta }}>
                <span>812 tok</span>
                <IconButton icon={MoreHorizontal} label="More" />
              </div>
            )}
          </article>
        </div>

        <div style={{ padding: 14, borderTop: '1px solid rgba(148, 163, 184, 0.2)', background: 'rgba(255, 255, 255, 0.5)' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 38px', gap: 10 }}>
            <div style={{ minHeight: 44, display: 'flex', alignItems: 'center', padding: '0 14px', borderRadius: 14, border: '1px solid rgba(148, 163, 184, 0.22)', background: 'rgba(255, 255, 255, 0.78)', color: '#64748b', fontSize: activeScale.user }}>
              Ask o8 to apply the selected chat treatment...
            </div>
            <button
              type="button"
              aria-label="Send"
              title="Send"
              style={{
                width: 38,
                height: 44,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: 14,
                border: '1px solid rgba(37, 99, 235, 0.24)',
                background: '#2563eb',
                color: '#ffffff',
                cursor: 'default',
              }}
            >
              <Send size={15} strokeWidth={2.4} />
            </button>
          </div>
        </div>
      </div>
    </PreviewShell>
  );
}

export default function PreviewPage() {
  const injected = useRef(false);

  useEffect(() => {
    if (!injected.current) {
      const s = document.createElement('style');
      s.textContent = KEYFRAMES;
      document.head.appendChild(s);
      injected.current = true;
    }
  }, []);

  return (
    <main
      style={{
        minHeight: '100vh',
        background: 'linear-gradient(180deg, #f8fafc 0%, #eef4fb 48%, #f4f2ed 100%)',
        color: '#0f172a',
        fontFamily: FONT_FAMILY,
        padding: '42px min(5vw, 64px) 64px',
        display: 'flex',
        flexDirection: 'column',
        gap: 34,
      }}
    >
      <header style={{ display: 'flex', justifyContent: 'space-between', gap: 24, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <span style={{ color: '#2563eb', fontSize: 11, fontWeight: 900, letterSpacing: '0.2em', textTransform: 'uppercase' }}>
            Preview Lab
          </span>
          <h1 style={{ margin: 0, fontSize: 38, lineHeight: 1.02, fontWeight: 850, letterSpacing: 0 }}>
            Chat Surface Treatments
          </h1>
          <p style={{ maxWidth: 760, margin: 0, color: '#475569', fontSize: 14, lineHeight: 1.65 }}>
            A browser-only comparison board for typography, reasoning summaries, tool calls, file-change cards, and action density.
          </p>
        </div>
        <StatusPill color="#f97316">sandbox route · /preview</StatusPill>
      </header>

      <section style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <SectionHeader
          label="Text Fonts"
          title="Type Scale"
          detail="The chat examples below use system UI for conversation text and SF Mono for machine/status details."
        />
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 12 }}>
          {TYPE_SAMPLES.map((sample) => (
            <PreviewShell key={sample.label} style={{ minHeight: 150, display: 'flex', flexDirection: 'column', justifyContent: 'space-between', gap: 18 }}>
              <div>
                <div style={{ color: '#0f172a', fontSize: 12, fontWeight: 850 }}>{sample.label}</div>
                <div style={{ marginTop: 4, color: '#94a3b8', fontSize: 11, fontFamily: MONO_FAMILY }}>{sample.meta}</div>
              </div>
              <p
                style={{
                  margin: 0,
                  color: '#0f172a',
                  fontSize: sample.size,
                  fontWeight: sample.weight,
                  lineHeight: sample.lineHeight,
                  fontFamily: sample.mono ? MONO_FAMILY : FONT_FAMILY,
                }}
              >
                {sample.text}
              </p>
            </PreviewShell>
          ))}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 14, flexWrap: 'wrap' }}>
            <div>
              <h3 style={{ margin: 0, color: '#0f172a', fontSize: 16, fontWeight: 850 }}>Font Switchboard</h3>
              <p style={{ margin: '4px 0 0', color: '#64748b', fontSize: 12, lineHeight: 1.5 }}>
                Preview-only font candidates for chat. The real app still uses system UI.
              </p>
            </div>
            <StatusPill color="#64748b">no app font change</StatusPill>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 12 }}>
            {FONT_CANDIDATES.map((candidate) => (
              <FontCandidateCard key={candidate.name} candidate={candidate} />
            ))}
          </div>
        </div>
      </section>

      <section style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <SectionHeader
          label="Change Targets"
          title="Things To Decide"
          detail="Each card corresponds to a real chat surface we can adjust after you pick a direction."
        />
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
          {CHANGE_TARGETS.map((target) => {
            const Icon = target.icon;
            return (
              <PreviewShell key={target.label} style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                <span
                  style={{
                    display: 'inline-flex',
                    width: 36,
                    height: 36,
                    alignItems: 'center',
                    justifyContent: 'center',
                    borderRadius: 13,
                    background: `${target.color}12`,
                    color: target.color,
                    flexShrink: 0,
                  }}
                >
                  <Icon size={17} strokeWidth={2.2} />
                </span>
                <div style={{ minWidth: 0 }}>
                  <div style={{ color: '#0f172a', fontSize: 13, fontWeight: 850 }}>{target.label}</div>
                  <div style={{ color: '#64748b', fontSize: 12, marginTop: 2 }}>{target.value}</div>
                </div>
              </PreviewShell>
            );
          })}
        </div>
      </section>

      <section style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <SectionHeader
          label="Train Of Thought"
          title="Prompt Kit-style Reasoning"
          detail="This mirrors the trigger, content, item, and code-block rhythm from Prompt Kit while staying in the isolated preview route."
        />
        <AdvancedChainOfThoughtPreview />
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 14 }}>
          <ThoughtStripPreview />
          <ThoughtRailPreview />
          <ThoughtCardPreview />
          <ThoughtInlinePreview />
        </div>
      </section>

      <section style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <SectionHeader
          label="Composite"
          title="Full Chat Mock"
          detail="A single transcript turn showing the pieces together at desktop density."
        />
        <CompositeChatPreview />
      </section>

      <section style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <SectionHeader
          label="Agent Status"
          title="Infinity Glow Reference"
          detail="The previous status-motion preview remains here for comparison against live chat and agent-chip states."
        />
        <PreviewShell style={{ background: '#0a0f1a', color: '#e2e8f0', boxShadow: '0 24px 80px rgba(15, 23, 42, 0.26)' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 32 }}>
            {MODES.map(({ mode, label, desc, color }) => (
              <div key={mode} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div>
                  <span style={{ fontSize: 15, fontWeight: 800, color: '#f8fafc' }}>{label}</span>
                  <span style={{ fontSize: 11, color: '#94a3b8', marginLeft: 10 }}>{desc}</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 20, paddingLeft: 8, flexWrap: 'wrap' }}>
                  {SIZES.map((sz) => (
                    <div key={sz} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
                      <div
                        style={{
                          minWidth: 64,
                          height: 44,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          borderRadius: 12,
                          background: 'rgba(255,255,255,0.04)',
                          border: '1px solid rgba(255,255,255,0.06)',
                          padding: '0 8px',
                        }}
                      >
                        <InfinityGlow color={color} mode={mode} size={sz} />
                      </div>
                      <span style={{ fontSize: 9, color: '#64748b' }}>{sz}x</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </PreviewShell>
      </section>
    </main>
  );
}
