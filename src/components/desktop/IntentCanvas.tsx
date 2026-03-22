'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import {
  ArrowRight,
  Bot,
  Bug,
  FileCode2,
  FileSearch,
  GitBranch,
  Github,
  Grip,
  Loader2,
  Merge,
  Network,
  RefreshCw,
  Shield,
  Sparkles,
  Zap,
} from 'lucide-react';
import { renderLLMMarkdown } from './LLMMarkdown';

type Point = { x: number; y: number };
type SourceIconType = 'bug' | 'logs' | 'test' | 'related';
type RouteVibe = 'safe' | 'fast' | 'creative';

interface SourceItem {
  id: string;
  title: string;
  detail: string;
  icon: SourceIconType;
}

interface FlowTask {
  id: string;
  title: string;
  detail: string;
}

interface RelatedIssue {
  id: string;
  title: string;
}

interface RoutePlan {
  id: string;
  title: string;
  summary: string;
  confidence: number;
  speed: number;
  risk: number;
  vibe: RouteVibe;
  recommendation: string;
  tasks: FlowTask[];
  prs: FlowTask[];
  relatedIssues: RelatedIssue[];
}

interface IntentBoard {
  title: string;
  summary: string;
  sources: SourceItem[];
  routes: RoutePlan[];
  merge: {
    title: string;
    detail: string;
  };
  notes: string;
  nextQuestions: string[];
  updatedAt: number;
}

interface IntentTurn {
  id: string;
  prompt: string;
  routeTitle: string;
  summary: string;
  at: number;
}

interface ModelOption {
  id: string;
  label: string;
  provider: 'anthropic' | 'openai' | 'google';
}

interface ProviderStatus {
  id: string;
  configured: boolean;
}

const BOARD_WIDTH = 1320;
const BOARD_HEIGHT = 640;
const SOURCE_SIZE = { width: 152, height: 82 };
const ISSUE_SIZE = { width: 236, height: 132 };
const ROUTE_SIZE = { width: 188, height: 92 };
const TASK_SIZE = { width: 182, height: 74 };
const PR_SIZE = { width: 192, height: 76 };
const MERGE_SIZE = { width: 150, height: 96 };
const RELATED_SIZE = { width: 140, height: 42 };
const ROUTE_X_MIN = 400;
const ROUTE_X_MAX = 610;
const ROUTE_Y_MIN = 34;
const ROUTE_Y_MAX = 520;

const MODELS: ModelOption[] = [
  { id: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro', provider: 'google' },
  { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', provider: 'google' },
  { id: 'claude-sonnet-4-5', label: 'Claude Sonnet', provider: 'anthropic' },
  { id: 'claude-opus-4-6', label: 'Claude Opus', provider: 'anthropic' },
  { id: 'gpt-5.4', label: 'GPT-5.4', provider: 'openai' },
  { id: 'gpt-4o', label: 'GPT-4o', provider: 'openai' },
];

const PROMPT_SUGGESTIONS = [
  'Map issue #84 into three possible implementation routes with tasks and PR outputs.',
  'Brainstorm a v1 PicoClaw onboarding agent without full terminal sessions yet.',
  'Turn the retry / handoff state bug into safe, fast, and system-fix options.',
  'Compare how we should approach setup wizard polish versus memory seeding work.',
];

const INTENT_BOARD_SYSTEM_PROMPT = [
  'You are Cortex Intent Board, an IDE-native planning model.',
  'You brainstorm implementation routes. You do not execute, browse, or call tools.',
  'Return valid JSON only. No markdown fences. No prose outside the JSON object.',
  'Keep text concise so cards fit on screen.',
  'Schema:',
  '{',
  '  "title": "short issue or initiative title",',
  '  "summary": "2-3 sentence problem framing",',
  '  "sources": [',
  '    { "title": "Bug report", "detail": "short detail", "icon": "bug|logs|test|related" }',
  '  ],',
  '  "routes": [',
  '    {',
  '      "title": "Safe patch",',
  '      "summary": "short route summary",',
  '      "confidence": 0-100,',
  '      "speed": 0-100,',
  '      "risk": 0-100,',
  '      "vibe": "safe|fast|creative",',
  '      "recommendation": "why this route matters",',
  '      "tasks": [{ "title": "task", "detail": "short detail" }],',
  '      "prs": [{ "title": "PR title", "detail": "short detail" }],',
  '      "relatedIssues": [{ "title": "#123 adjacent issue" }]',
  '    }',
  '  ],',
  '  "merge": { "title": "main branch", "detail": "merge gate detail" },',
  '  "notes": "markdown notes for the inspector",',
  '  "nextQuestions": ["question 1", "question 2", "question 3"]',
  '}',
  'Rules:',
  '- Give exactly 3 route objects when possible.',
  '- Keep source count between 2 and 4.',
  '- Keep task count between 2 and 3 per route.',
  '- Keep PR count between 1 and 2 per route.',
  '- Keep related issue count between 1 and 3 per route.',
  '- Titles should be short and concrete.',
  '- Route summaries should be under 140 characters.',
  '- Notes should help an operator choose a path, not restate the whole prompt.',
].join('\n');

const INITIAL_BOARD: IntentBoard = {
  title: 'Issue #208 — branch ownership breaks on retry',
  summary: 'A retry after partial handoff can lose which route owns replay state. That makes the UI feel untrustworthy and creates duplicate writes, merge hesitation, and noisy follow-up work.',
  sources: [
    { id: 'source-1', title: 'Bug report', detail: 'Users lose replay ownership after retry.', icon: 'bug' },
    { id: 'source-2', title: 'Console trace', detail: 'Optimistic updates drift after handoff.', icon: 'logs' },
    { id: 'source-3', title: 'Failing test', detail: 'Replay graph drops branch owner on retry.', icon: 'test' },
    { id: 'source-4', title: 'Adjacent issues', detail: 'Touches replay drift, merge trust, and warnings.', icon: 'related' },
  ],
  routes: [
    {
      id: 'safe-patch',
      title: 'Safe patch',
      summary: 'Tighten replay ownership transitions and ship the smallest safe fix first.',
      confidence: 91,
      speed: 62,
      risk: 19,
      vibe: 'safe',
      recommendation: 'Best first move if we need confidence and low regression risk.',
      tasks: [
        { id: 'safe-task-1', title: 'Reproduce ownership loss', detail: 'Pin the exact retry transition that drops branch ownership.' },
        { id: 'safe-task-2', title: 'Patch the guard', detail: 'Add explicit ownership validation before replay state mutates.' },
        { id: 'safe-task-3', title: 'Run replay regression', detail: 'Verify retry, handoff, and merge-review flows stay stable.' },
      ],
      prs: [
        { id: 'safe-pr-1', title: 'fix: preserve owner on retry', detail: 'Replay guard + targeted tests' },
        { id: 'safe-pr-2', title: 'ui: surface replay mismatch warning', detail: 'Warn before the graph drifts silently' },
      ],
      relatedIssues: [
        { id: 'safe-rel-1', title: '#184 stale replay snapshot' },
        { id: 'safe-rel-2', title: '#191 optimistic state drift' },
        { id: 'safe-rel-3', title: '#202 merge panel warning gap' },
      ],
    },
    {
      id: 'fast-ship',
      title: 'Fast ship',
      summary: 'Bypass the risky path, stabilize production first, and come back for the deeper cleanup.',
      confidence: 77,
      speed: 92,
      risk: 34,
      vibe: 'fast',
      recommendation: 'Best when prod behavior matters more than architectural cleanup this week.',
      tasks: [
        { id: 'fast-task-1', title: 'Bypass the retry edge', detail: 'Route around the broken ownership path in the hot flow.' },
        { id: 'fast-task-2', title: 'Throttle duplicate writes', detail: 'Reduce replay churn while retries are in progress.' },
        { id: 'fast-task-3', title: 'Ship degraded-mode label', detail: 'Make incomplete replay ownership obvious in the UI.' },
      ],
      prs: [
        { id: 'fast-pr-1', title: 'hotfix: bypass retry ownership race', detail: 'Hot edge stabilization' },
        { id: 'fast-pr-2', title: 'ui: add degraded replay badge', detail: 'Temporary trust-preserving surface' },
      ],
      relatedIssues: [
        { id: 'fast-rel-1', title: '#177 duplicate branch writes' },
        { id: 'fast-rel-2', title: '#181 queue saturation' },
        { id: 'fast-rel-3', title: '#204 degraded mode missing' },
      ],
    },
    {
      id: 'system-fix',
      title: 'System fix',
      summary: 'Rework ownership into a first-class decision ledger so this class of replay bug goes away.',
      confidence: 84,
      speed: 46,
      risk: 42,
      vibe: 'creative',
      recommendation: 'Best if we want to remove replay trust problems instead of shipping a patch train.',
      tasks: [
        { id: 'system-task-1', title: 'Model a decision ledger', detail: 'Persist route approvals and branch ownership explicitly.' },
        { id: 'system-task-2', title: 'Rebuild replay hydration', detail: 'Hydrate the graph from decisions, not incidental state.' },
        { id: 'system-task-3', title: 'Backfill migration', detail: 'Safely translate old replay records to the new ledger.' },
      ],
      prs: [
        { id: 'system-pr-1', title: 'feat: decision ledger for replay ownership', detail: 'Schema + runtime layer' },
        { id: 'system-pr-2', title: 'refactor: hydrate replay from decisions', detail: 'Workspace surface + tests' },
      ],
      relatedIssues: [
        { id: 'system-rel-1', title: '#121 audit trail missing' },
        { id: 'system-rel-2', title: '#167 branch history not queryable' },
        { id: 'system-rel-3', title: '#205 replay graph hard to trust' },
      ],
    },
  ],
  merge: {
    title: 'main branch',
    detail: 'Selected route returns code here for review, merge, and follow-up routing.',
  },
  notes: 'Use this board for planning before runtime execution. The safe route is the best v1 ship path, the fast route is the ops patch, and the system route is the architectural cleanup.',
  nextQuestions: [
    'Which route should become the first implementation issue?',
    'What can we safely defer out of the v1 patch?',
    'Which adjacent issue is most likely to expand scope?',
  ],
  updatedAt: Date.now(),
};

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(value, max));
}

function center(point: Point, size: { width: number; height: number }) {
  return { x: point.x + size.width / 2, y: point.y + size.height / 2 };
}

function pathBetween(a: { x: number; y: number }, b: { x: number; y: number }) {
  const dx = Math.abs(b.x - a.x);
  const c1x = a.x + Math.max(42, dx * 0.34);
  const c2x = b.x - Math.max(42, dx * 0.34);
  return `M ${a.x} ${a.y} C ${c1x} ${a.y}, ${c2x} ${b.y}, ${b.x} ${b.y}`;
}

function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    || `route-${Math.random().toString(36).slice(2, 8)}`;
}

function compact(value: string, max: number, fallback: string) {
  const normalized = value.trim();
  if (!normalized) return fallback;
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 1).trim()}…`;
}

function clampPercent(value: unknown, fallback: number) {
  if (typeof value !== 'number' || Number.isNaN(value)) return fallback;
  return clamp(Math.round(value), 0, 100);
}

function buildRoutePositions(routes: RoutePlan[]) {
  const count = Math.max(1, routes.length);
  const spacing = count === 1 ? 0 : 320 / Math.max(1, count - 1);
  const startY = count === 1 ? 248 : 72;

  return routes.reduce<Record<string, Point>>((acc, route, index) => {
    acc[route.id] = {
      x: 430 + (index % 2 === 0 ? 0 : 20),
      y: Math.round(startY + index * spacing),
    };
    return acc;
  }, {});
}

function buildStackPositions(count: number, size: { width: number; height: number }, x: number, minY: number, maxY: number, gap: number) {
  if (count <= 0) return [];
  const totalHeight = count * size.height + (count - 1) * gap;
  const startY = clamp((BOARD_HEIGHT - totalHeight) / 2, minY, maxY - totalHeight);
  return Array.from({ length: count }, (_, index) => ({
    x,
    y: Math.round(startY + index * (size.height + gap)),
  }));
}

function buildRelatedPositions(count: number) {
  const baseX = 438;
  const gap = 148;
  const y = BOARD_HEIGHT - RELATED_SIZE.height - 24;
  return Array.from({ length: count }, (_, index) => ({
    x: baseX + gap * index,
    y,
  }));
}

function tone(vibe: RouteVibe) {
  if (vibe === 'safe') {
    return {
      border: 'rgba(52, 211, 153, 0.34)',
      background: 'linear-gradient(180deg, rgba(16, 185, 129, 0.16), rgba(6, 95, 70, 0.12))',
      text: '#d1fae5',
      accent: '#34d399',
    };
  }
  if (vibe === 'fast') {
    return {
      border: 'rgba(96, 165, 250, 0.34)',
      background: 'linear-gradient(180deg, rgba(37, 99, 235, 0.16), rgba(30, 64, 175, 0.12))',
      text: '#dbeafe',
      accent: '#60a5fa',
    };
  }
  return {
    border: 'rgba(196, 181, 253, 0.34)',
    background: 'linear-gradient(180deg, rgba(139, 92, 246, 0.16), rgba(91, 33, 182, 0.12))',
    text: '#ede9fe',
    accent: '#a78bfa',
  };
}

function statColor(value: number) {
  if (value >= 85) return '#86efac';
  if (value >= 70) return '#7dd3fc';
  if (value >= 55) return '#fcd34d';
  return '#fca5a5';
}

function extractJsonBlock(raw: string) {
  const trimmed = raw.trim();
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const unwrapped = fenceMatch?.[1]?.trim() || trimmed;
  const firstBrace = unwrapped.indexOf('{');
  const lastBrace = unwrapped.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    throw new Error('No JSON object found in model output.');
  }
  return unwrapped.slice(firstBrace, lastBrace + 1);
}

function boardContextForModel(board: IntentBoard) {
  return JSON.stringify({
    title: board.title,
    summary: board.summary,
    routes: board.routes.map((route) => ({
      title: route.title,
      summary: route.summary,
      recommendation: route.recommendation,
      tasks: route.tasks.map((task) => task.title),
      prs: route.prs.map((pr) => pr.title),
      relatedIssues: route.relatedIssues.map((issue) => issue.title),
    })),
    notes: board.notes,
    nextQuestions: board.nextQuestions,
  });
}

function normalizeBoard(raw: string, fallbackPrompt: string): IntentBoard {
  const parsed = JSON.parse(extractJsonBlock(raw)) as Record<string, unknown>;
  const title = compact(typeof parsed.title === 'string' ? parsed.title : fallbackPrompt, 88, 'Intent board');
  const summary = compact(typeof parsed.summary === 'string' ? parsed.summary : fallbackPrompt, 280, fallbackPrompt);

  const sourcesRaw = Array.isArray(parsed.sources) ? parsed.sources : [];
  const sources = (sourcesRaw.length > 0 ? sourcesRaw : INITIAL_BOARD.sources).slice(0, 4).map((entry, index) => {
    const source = entry as Record<string, unknown>;
    const icon = source.icon === 'bug' || source.icon === 'logs' || source.icon === 'test' || source.icon === 'related'
      ? source.icon
      : INITIAL_BOARD.sources[index % INITIAL_BOARD.sources.length].icon;
    return {
      id: `source-${index + 1}`,
      title: compact(typeof source.title === 'string' ? source.title : '', 38, `Source ${index + 1}`),
      detail: compact(typeof source.detail === 'string' ? source.detail : '', 86, 'No detail provided.'),
      icon,
    } satisfies SourceItem;
  });

  const routesRaw = Array.isArray(parsed.routes) ? parsed.routes : [];
  const normalizedRoutes = (routesRaw.length > 0 ? routesRaw : INITIAL_BOARD.routes).slice(0, 3).map((entry, index) => {
    const route = entry as Record<string, unknown>;
    const fallback = INITIAL_BOARD.routes[index % INITIAL_BOARD.routes.length];
    const vibe: RouteVibe = route.vibe === 'safe' || route.vibe === 'fast' || route.vibe === 'creative'
      ? route.vibe
      : fallback.vibe;
    const tasksRaw = Array.isArray(route.tasks) ? route.tasks : fallback.tasks;
    const prsRaw = Array.isArray(route.prs) ? route.prs : fallback.prs;
    const relatedRaw = Array.isArray(route.relatedIssues) ? route.relatedIssues : fallback.relatedIssues;

    return {
      id: slugify(typeof route.title === 'string' ? route.title : fallback.title),
      title: compact(typeof route.title === 'string' ? route.title : '', 28, fallback.title),
      summary: compact(typeof route.summary === 'string' ? route.summary : '', 132, fallback.summary),
      confidence: clampPercent(route.confidence, fallback.confidence),
      speed: clampPercent(route.speed, fallback.speed),
      risk: clampPercent(route.risk, fallback.risk),
      vibe,
      recommendation: compact(typeof route.recommendation === 'string' ? route.recommendation : '', 130, fallback.recommendation),
      tasks: tasksRaw.slice(0, 3).map((taskEntry, taskIndex) => {
        const task = taskEntry as Record<string, unknown>;
        const taskFallback = fallback.tasks[taskIndex % fallback.tasks.length];
        return {
          id: `${slugify(typeof route.title === 'string' ? route.title : fallback.title)}-task-${taskIndex + 1}`,
          title: compact(typeof task.title === 'string' ? task.title : '', 40, taskFallback.title),
          detail: compact(typeof task.detail === 'string' ? task.detail : '', 96, taskFallback.detail),
        } satisfies FlowTask;
      }),
      prs: prsRaw.slice(0, 2).map((prEntry, prIndex) => {
        const pr = prEntry as Record<string, unknown>;
        const prFallback = fallback.prs[prIndex % fallback.prs.length];
        return {
          id: `${slugify(typeof route.title === 'string' ? route.title : fallback.title)}-pr-${prIndex + 1}`,
          title: compact(typeof pr.title === 'string' ? pr.title : '', 44, prFallback.title),
          detail: compact(typeof pr.detail === 'string' ? pr.detail : '', 96, prFallback.detail),
        } satisfies FlowTask;
      }),
      relatedIssues: relatedRaw.slice(0, 3).map((relatedEntry, relatedIndex) => {
        const related = relatedEntry as Record<string, unknown>;
        const relatedFallback = fallback.relatedIssues[relatedIndex % fallback.relatedIssues.length];
        return {
          id: `${slugify(typeof route.title === 'string' ? route.title : fallback.title)}-related-${relatedIndex + 1}`,
          title: compact(typeof related.title === 'string' ? related.title : '', 34, relatedFallback.title),
        } satisfies RelatedIssue;
      }),
    } satisfies RoutePlan;
  });

  const mergeRaw = (parsed.merge ?? {}) as Record<string, unknown>;
  const nextQuestionsRaw = Array.isArray(parsed.nextQuestions) ? parsed.nextQuestions : [];

  return {
    title,
    summary,
    sources,
    routes: normalizedRoutes,
    merge: {
      title: compact(typeof mergeRaw.title === 'string' ? mergeRaw.title : '', 30, INITIAL_BOARD.merge.title),
      detail: compact(typeof mergeRaw.detail === 'string' ? mergeRaw.detail : '', 110, INITIAL_BOARD.merge.detail),
    },
    notes: compact(typeof parsed.notes === 'string' ? parsed.notes : '', 900, INITIAL_BOARD.notes),
    nextQuestions: (nextQuestionsRaw.length > 0 ? nextQuestionsRaw : INITIAL_BOARD.nextQuestions)
      .map((question, index) => compact(typeof question === 'string' ? question : '', 90, INITIAL_BOARD.nextQuestions[index % INITIAL_BOARD.nextQuestions.length]))
      .slice(0, 3),
    updatedAt: Date.now(),
  };
}

function SourceGlyph({ type }: { type: SourceIconType }) {
  if (type === 'bug') return <Bug size={14} strokeWidth={2} />;
  if (type === 'logs') return <FileSearch size={14} strokeWidth={2} />;
  if (type === 'test') return <FileCode2 size={14} strokeWidth={2} />;
  return <Network size={14} strokeWidth={2} />;
}

function MiniBar({ label, value }: { label: string; value: number }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        fontSize: 10,
        textTransform: 'uppercase',
        letterSpacing: '0.16em',
        color: 'rgba(226,232,240,0.46)',
      }}>
        <span>{label}</span>
        <span style={{ color: statColor(value), fontWeight: 700 }}>{value}</span>
      </div>
      <div style={{
        height: 6,
        borderRadius: 999,
        background: 'rgba(255,255,255,0.08)',
        overflow: 'hidden',
      }}>
        <div
          style={{
            height: '100%',
            width: `${value}%`,
            borderRadius: 999,
            background: 'linear-gradient(90deg, rgba(255,255,255,0.92), rgba(148,163,184,0.58))',
          }}
        />
      </div>
    </div>
  );
}

function ModelSelect({
  disabled,
  onChange,
  options,
  value,
}: {
  disabled: boolean;
  onChange: (value: string) => void;
  options: ModelOption[];
  value: string;
}) {
  return (
    <label style={{
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      padding: '10px 12px',
      borderRadius: 12,
      border: '1px solid rgba(148,163,184,0.14)',
      background: 'rgba(8, 12, 20, 0.72)',
      fontSize: 12,
      color: '#cbd5e1',
    }}>
      <Sparkles size={14} strokeWidth={2} style={{ color: '#93c5fd', flexShrink: 0 }} />
      <select
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        style={{
          flex: 1,
          background: 'transparent',
          border: 'none',
          color: '#e2e8f0',
          fontSize: 12,
          outline: 'none',
          appearance: 'none',
          cursor: disabled ? 'default' : 'pointer',
        }}
      >
        {options.map((option) => (
          <option key={option.id} value={option.id} style={{ color: '#0f172a' }}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function IntentCanvas() {
  const boardRef = useRef<HTMLDivElement | null>(null);
  const boardViewportRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const dragStartRef = useRef<Record<string, Point>>({});
  const [board, setBoard] = useState<IntentBoard>(INITIAL_BOARD);
  const [positions, setPositions] = useState<Record<string, Point>>(() => buildRoutePositions(INITIAL_BOARD.routes));
  const [selectedRouteId, setSelectedRouteId] = useState(INITIAL_BOARD.routes[0].id);
  const [prompt, setPrompt] = useState(PROMPT_SUGGESTIONS[0]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [streamPreview, setStreamPreview] = useState('');
  const [rawOutput, setRawOutput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<IntentTurn[]>([]);
  const [conversation, setConversation] = useState<Array<{ role: 'user' | 'assistant'; content: string }>>([]);
  const [model, setModel] = useState<ModelOption>(MODELS[0]);
  const [modelResolved, setModelResolved] = useState(false);
  const [boardScale, setBoardScale] = useState(1);

  useEffect(() => {
    if (modelResolved) return;

    (async () => {
      try {
        const response = await fetch('/api/v2/keys');
        if (response.ok) {
          const data = await response.json();
          const configuredProviders = new Set(
            ((data.providers ?? []) as ProviderStatus[])
              .filter((provider) => provider.configured)
              .map((provider) => provider.id),
          );
          const bestMatch = MODELS.find((option) => configuredProviders.has(option.provider));
          if (bestMatch) {
            setModel(bestMatch);
          }
        }
      } catch {
        // Use fallback default model.
      } finally {
        setModelResolved(true);
      }
    })();
  }, [modelResolved]);

  useEffect(() => {
    if (!board.routes.some((route) => route.id === selectedRouteId)) {
      setSelectedRouteId(board.routes[0]?.id ?? '');
    }
  }, [board.routes, selectedRouteId]);

  useEffect(() => {
    const node = boardViewportRef.current;
    if (!node) return;

    const measure = () => {
      const widthScale = (node.clientWidth - 32) / BOARD_WIDTH;
      const heightScale = (node.clientHeight - 32) / BOARD_HEIGHT;
      const nextScale = Math.min(1, widthScale, heightScale);
      setBoardScale(Number.isFinite(nextScale) && nextScale > 0 ? nextScale : 1);
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const selectedRoute = useMemo(
    () => board.routes.find((route) => route.id === selectedRouteId) ?? board.routes[0],
    [board.routes, selectedRouteId],
  );

  const sourcePositions = useMemo<Point[]>(() => ([
    { x: 20, y: 56 },
    { x: 20, y: 150 },
    { x: 20, y: 244 },
    { x: 20, y: 338 },
  ]), []);

  const issuePosition = useMemo<Point>(() => ({ x: 188, y: 182 }), []);
  const taskPositions = useMemo(
    () => buildStackPositions(selectedRoute?.tasks.length ?? 0, TASK_SIZE, 690, 56, 556, 58),
    [selectedRoute],
  );
  const prPositions = useMemo(
    () => buildStackPositions(selectedRoute?.prs.length ?? 0, PR_SIZE, 930, 114, 516, 68),
    [selectedRoute],
  );
  const mergePosition = useMemo<Point>(() => ({ x: 1164, y: 236 }), []);
  const relatedPositions = useMemo(
    () => buildRelatedPositions(selectedRoute?.relatedIssues.length ?? 0),
    [selectedRoute],
  );

  const issueCenter = center(issuePosition, ISSUE_SIZE);
  const mergeCenter = center(mergePosition, MERGE_SIZE);
  const selectedCenter = center(positions[selectedRoute.id], ROUTE_SIZE);
  const taskCenters = taskPositions.map((position) => center(position, TASK_SIZE));
  const prCenters = prPositions.map((position) => center(position, PR_SIZE));

  const handleReset = useCallback(() => {
    setBoard(INITIAL_BOARD);
    setPositions(buildRoutePositions(INITIAL_BOARD.routes));
    setSelectedRouteId(INITIAL_BOARD.routes[0].id);
    setPrompt(PROMPT_SUGGESTIONS[0]);
    setStreamPreview('');
    setRawOutput('');
    setError(null);
    setHistory([]);
    setConversation([]);
  }, []);

  const handleGenerate = useCallback(async () => {
    const nextPrompt = prompt.trim();
    if (!nextPrompt || isGenerating) return;

    setIsGenerating(true);
    setError(null);
    setStreamPreview('');
    setRawOutput('');

    try {
      const response = await fetch('/api/v2/proxy/llm', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-tab-id': 'intent-board',
        },
        body: JSON.stringify({
          model: model.id,
          provider: model.provider,
          disableTools: true,
          messages: [
            { role: 'system', content: INTENT_BOARD_SYSTEM_PROMPT },
            ...(conversation.length > 0
              ? [
                  {
                    role: 'system',
                    content: `Current board context:\n${boardContextForModel(board)}`,
                  },
                ]
              : []),
            ...conversation.slice(-8),
            { role: 'user', content: nextPrompt },
          ],
        }),
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => ({ error: 'Request failed' }));
        throw new Error(payload.error || `HTTP ${response.status}`);
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('No response stream available.');
      }

      const decoder = new TextDecoder();
      let content = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        for (const line of chunk.split('\n')) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6);
          if (!data || data === '[DONE]') continue;

          try {
            const parsed = JSON.parse(data) as {
              type?: string;
              text?: string;
              message?: string;
            };

            if (parsed.type === 'content' && parsed.text) {
              content += parsed.text;
              setStreamPreview(content);
            } else if (parsed.type === 'error' && parsed.message) {
              throw new Error(parsed.message);
            }
          } catch (parseError) {
            if (parseError instanceof Error) {
              throw parseError;
            }
          }
        }
      }

      setRawOutput(content);
      const nextBoard = normalizeBoard(content, nextPrompt);
      setBoard(nextBoard);
      setPositions(buildRoutePositions(nextBoard.routes));
      setSelectedRouteId(nextBoard.routes[0]?.id ?? '');
      setConversation((prev) => (
        ([
          ...prev,
          { role: 'user', content: nextPrompt },
          { role: 'assistant', content: boardContextForModel(nextBoard) },
        ] as Array<{ role: 'user' | 'assistant'; content: string }>).slice(-10)
      ));
      setHistory((prev) => (
        [
          {
            id: `${Date.now()}`,
            prompt: compact(nextPrompt, 120, nextPrompt),
            routeTitle: nextBoard.routes[0]?.title ?? 'Route',
            summary: compact(nextBoard.summary, 120, nextBoard.summary),
            at: Date.now(),
          },
          ...prev,
        ].slice(0, 6)
      ));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to generate intent board.';
      setError(message);
    } finally {
      setIsGenerating(false);
    }
  }, [board, conversation, isGenerating, model.id, model.provider, prompt]);

  const boardTags = useMemo(
    () => [
      { label: 'sources', value: `${board.sources.length}` },
      { label: 'routes', value: `${board.routes.length}` },
      { label: 'tasks', value: `${selectedRoute.tasks.length}` },
      { label: 'updated', value: new Date(board.updatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) },
    ],
    [board.routes.length, board.sources.length, board.updatedAt, selectedRoute.tasks.length],
  );

  return (
    <div style={{
      height: '100%',
      padding: 16,
      background: 'linear-gradient(180deg, #060814 0%, #0b1120 100%)',
      color: '#f8fafc',
      overflow: 'hidden',
      display: 'flex',
      flexDirection: 'column',
      gap: 14,
    }}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 16,
        padding: '18px 20px',
        borderRadius: 24,
        border: '1px solid rgba(148,163,184,0.12)',
        background: 'linear-gradient(135deg, rgba(8, 15, 28, 0.98), rgba(17, 24, 39, 0.92))',
        boxShadow: '0 24px 60px rgba(2,6,23,0.36)',
      }}>
        <div>
          <div style={{
            fontSize: 11,
            textTransform: 'uppercase',
            letterSpacing: '0.22em',
            color: 'rgba(148,163,184,0.72)',
            marginBottom: 6,
          }}>
            Intent Board V1
          </div>
          <div style={{ fontSize: 24, fontWeight: 700, letterSpacing: '-0.03em' }}>
            Brainstorm routes before you launch agents
          </div>
          <div style={{ marginTop: 8, maxWidth: 920, fontSize: 13, lineHeight: 1.6, color: 'rgba(226,232,240,0.72)' }}>
            This surface is planning-only for now. It uses the same LLM proxy as the desktop chat, but tools are disabled so the model stays focused on issue framing, route options, tasks, PR outputs, and tradeoffs inside the workspace.
          </div>
        </div>

        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          flexWrap: 'wrap',
          justifyContent: 'flex-end',
          maxWidth: 360,
        }}>
          {boardTags.map((tag) => (
            <div
              key={tag.label}
              style={{
                padding: '8px 10px',
                borderRadius: 999,
                border: '1px solid rgba(148,163,184,0.14)',
                background: 'rgba(15, 23, 42, 0.58)',
                fontSize: 11,
                color: 'rgba(226,232,240,0.76)',
                textTransform: 'uppercase',
                letterSpacing: '0.12em',
              }}
            >
              {tag.label} · <span style={{ color: '#f8fafc', fontWeight: 700 }}>{tag.value}</span>
            </div>
          ))}
        </div>
      </div>

      <div style={{
        flex: 1,
        minHeight: 0,
        display: 'grid',
        gridTemplateColumns: 'minmax(0, 1fr) 360px',
        gap: 14,
      }}>
        <section style={{
          minWidth: 0,
          minHeight: 0,
          borderRadius: 28,
          border: '1px solid rgba(148,163,184,0.12)',
          background: 'linear-gradient(180deg, rgba(10, 14, 26, 0.98), rgba(9, 12, 21, 0.94))',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          boxShadow: '0 24px 60px rgba(2,6,23,0.28)',
        }}>
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 16,
            padding: '16px 18px',
            borderBottom: '1px solid rgba(148,163,184,0.10)',
          }}>
            <div>
              <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.2em', color: 'rgba(148,163,184,0.62)' }}>
                Spatial workspace
              </div>
              <div style={{ marginTop: 4, fontSize: 18, fontWeight: 700, letterSpacing: '-0.02em' }}>
                {board.title}
              </div>
            </div>
            <div style={{
              padding: '8px 12px',
              borderRadius: 999,
              background: 'rgba(37, 99, 235, 0.14)',
              border: '1px solid rgba(96, 165, 250, 0.18)',
              color: '#bfdbfe',
              fontSize: 11,
              letterSpacing: '0.14em',
              textTransform: 'uppercase',
            }}>
              drag the route pills
            </div>
          </div>

          <div
            ref={boardViewportRef}
            style={{
              flex: 1,
              minHeight: 0,
              overflow: 'auto',
              padding: 16,
              display: 'flex',
              alignItems: 'flex-start',
              justifyContent: 'center',
            }}
          >
            <div
              style={{
                position: 'relative',
                width: BOARD_WIDTH * boardScale,
                height: BOARD_HEIGHT * boardScale,
              }}
            >
              <div
                ref={boardRef}
                style={{
                  position: 'absolute',
                  left: 0,
                  top: 0,
                  width: BOARD_WIDTH,
                  height: BOARD_HEIGHT,
                  transform: `scale(${boardScale})`,
                  transformOrigin: 'top left',
                  background: 'radial-gradient(circle at 14% 18%, rgba(37,99,235,0.08), transparent 18%), radial-gradient(circle at 62% 22%, rgba(168,85,247,0.10), transparent 18%), radial-gradient(circle at 68% 78%, rgba(16,185,129,0.08), transparent 20%), linear-gradient(180deg, rgba(255,255,255,0.02), rgba(255,255,255,0.01))',
                }}
              >
              <svg width={BOARD_WIDTH} height={BOARD_HEIGHT} style={{ position: 'absolute', inset: 0 }}>
                <defs>
                  <linearGradient id="intent-line" x1="0%" y1="0%" x2="100%" y2="0%">
                    <stop offset="0%" stopColor="rgba(148, 163, 184, 0.18)" />
                    <stop offset="100%" stopColor="rgba(255, 255, 255, 0.42)" />
                  </linearGradient>
                  <linearGradient id="intent-active" x1="0%" y1="0%" x2="100%" y2="0%">
                    <stop offset="0%" stopColor="rgba(168,85,247,0.56)" />
                    <stop offset="100%" stopColor="rgba(56,189,248,0.72)" />
                  </linearGradient>
                </defs>

                {board.sources.map((_, index) => {
                  const from = center(sourcePositions[index], SOURCE_SIZE);
                  const to = { x: issueCenter.x, y: issueCenter.y - 34 + index * 24 };
                  return (
                    <path
                      key={`source-line-${index}`}
                      d={pathBetween(from, to)}
                      stroke="url(#intent-line)"
                      strokeWidth="2"
                      fill="none"
                      opacity="0.74"
                    />
                  );
                })}

                {board.routes.map((route) => {
                  const to = { x: positions[route.id].x, y: positions[route.id].y + ROUTE_SIZE.height / 2 };
                  const active = route.id === selectedRoute.id;
                  return (
                    <path
                      key={`route-line-${route.id}`}
                      d={pathBetween({ x: issuePosition.x + ISSUE_SIZE.width, y: issueCenter.y }, to)}
                      stroke={active ? 'url(#intent-active)' : 'url(#intent-line)'}
                      strokeWidth={active ? 3 : 2}
                      fill="none"
                      opacity={active ? 1 : 0.55}
                    />
                  );
                })}

                {selectedRoute.relatedIssues.map((related, index) => (
                  <path
                    key={`related-line-${related.id}`}
                    d={pathBetween(selectedCenter, center(relatedPositions[index], RELATED_SIZE))}
                    stroke="rgba(250,204,21,0.42)"
                    strokeWidth="1.8"
                    fill="none"
                    strokeDasharray="5 7"
                  />
                ))}

                {taskCenters.map((taskCenter, index) => (
                  <path
                    key={`task-line-${index}`}
                    d={pathBetween(
                      { x: positions[selectedRoute.id].x + ROUTE_SIZE.width, y: positions[selectedRoute.id].y + ROUTE_SIZE.height / 2 },
                      { x: taskPositions[index].x, y: taskCenter.y },
                    )}
                    stroke="url(#intent-active)"
                    strokeWidth="2.2"
                    fill="none"
                    opacity="0.94"
                  />
                ))}

                {prCenters.map((prCenter, index) => {
                  const taskCenter = taskCenters[Math.min(index, taskCenters.length - 1)] ?? selectedCenter;
                  return (
                    <path
                      key={`pr-line-${index}`}
                      d={pathBetween(taskCenter, { x: prPositions[index].x, y: prCenter.y })}
                      stroke="rgba(255,255,255,0.32)"
                      strokeWidth="2"
                      fill="none"
                    />
                  );
                })}

                {prCenters.map((prCenter, index) => (
                  <path
                    key={`merge-line-${index}`}
                    d={pathBetween(
                      { x: prPositions[index].x + PR_SIZE.width, y: prCenter.y },
                      { x: mergePosition.x, y: mergeCenter.y },
                    )}
                    stroke="rgba(255,255,255,0.28)"
                    strokeWidth="2"
                    fill="none"
                  />
                ))}
              </svg>

              {[
                { label: 'sources', x: 18, y: 16 },
                { label: 'issue', x: 212, y: 16 },
                { label: 'routes', x: 438, y: 16 },
                { label: 'tasks', x: 706, y: 16 },
                { label: 'prs', x: 944, y: 16 },
                { label: 'merge', x: 1176, y: 16 },
              ].map((tag) => (
                <div
                  key={tag.label}
                  style={{
                    position: 'absolute',
                    left: tag.x,
                    top: tag.y,
                    padding: '7px 10px',
                    borderRadius: 999,
                    background: 'rgba(8, 15, 28, 0.56)',
                    border: '1px solid rgba(148,163,184,0.12)',
                    fontSize: 10,
                    color: 'rgba(226,232,240,0.52)',
                    textTransform: 'uppercase',
                    letterSpacing: '0.16em',
                    zIndex: 2,
                  }}
                >
                  {tag.label}
                </div>
              ))}

              {board.sources.map((source, index) => (
                <div
                  key={source.id}
                  style={{
                    position: 'absolute',
                    left: sourcePositions[index].x,
                    top: sourcePositions[index].y,
                    width: SOURCE_SIZE.width,
                    minHeight: SOURCE_SIZE.height,
                    padding: 14,
                    borderRadius: 22,
                    border: '1px solid rgba(148,163,184,0.12)',
                    background: 'rgba(8, 12, 20, 0.72)',
                    backdropFilter: 'blur(18px)',
                    boxShadow: '0 16px 40px rgba(2,6,23,0.24)',
                    zIndex: 3,
                  }}
                >
                  <div style={{ display: 'flex', gap: 10 }}>
                    <div style={{
                      width: 30,
                      height: 30,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      borderRadius: 12,
                      background: 'rgba(255,255,255,0.05)',
                      color: '#dbeafe',
                      flexShrink: 0,
                    }}>
                      <SourceGlyph type={source.icon} />
                    </div>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 700, lineHeight: 1.2 }}>{source.title}</div>
                      <div style={{ marginTop: 4, fontSize: 11, lineHeight: 1.55, color: 'rgba(226,232,240,0.62)' }}>
                        {source.detail}
                      </div>
                    </div>
                  </div>
                </div>
              ))}

              <div
                style={{
                  position: 'absolute',
                  left: issuePosition.x,
                  top: issuePosition.y,
                  width: ISSUE_SIZE.width,
                  minHeight: ISSUE_SIZE.height,
                  padding: 18,
                  borderRadius: 26,
                  border: '1px solid rgba(217, 70, 239, 0.30)',
                  background: 'linear-gradient(180deg, rgba(192, 38, 211, 0.14), rgba(88, 28, 135, 0.12))',
                  boxShadow: '0 24px 60px rgba(88,28,135,0.22)',
                  zIndex: 3,
                }}
              >
                <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.18em', color: 'rgba(248,250,252,0.54)' }}>
                  Core issue
                </div>
                <div style={{ marginTop: 8, fontSize: 16, fontWeight: 700, lineHeight: 1.25 }}>
                  {board.title}
                </div>
                <div style={{ marginTop: 8, fontSize: 12, lineHeight: 1.6, color: 'rgba(248,250,252,0.72)' }}>
                  {board.summary}
                </div>
              </div>

              {board.routes.map((route) => {
                const pos = positions[route.id];
                const routeTone = tone(route.vibe);
                const active = route.id === selectedRoute.id;

                return (
                  <motion.button
                    key={route.id}
                    type="button"
                    drag
                    dragConstraints={boardRef}
                    dragMomentum={false}
                    onDragStart={() => {
                      dragStartRef.current[route.id] = positions[route.id];
                    }}
                    onDrag={(_, info) => {
                      const start = dragStartRef.current[route.id] ?? positions[route.id];
                      setPositions((current) => ({
                        ...current,
                        [route.id]: {
                          x: clamp(start.x + info.offset.x, ROUTE_X_MIN, ROUTE_X_MAX),
                          y: clamp(start.y + info.offset.y, ROUTE_Y_MIN, ROUTE_Y_MAX),
                        },
                      }));
                    }}
                    onClick={() => setSelectedRouteId(route.id)}
                    style={{
                      position: 'absolute',
                      left: 0,
                      top: 0,
                      x: pos.x,
                      y: pos.y,
                      width: ROUTE_SIZE.width,
                      minHeight: ROUTE_SIZE.height,
                      padding: 14,
                      borderRadius: 24,
                      border: `1px solid ${routeTone.border}`,
                      background: routeTone.background,
                      color: routeTone.text,
                      textAlign: 'left',
                      cursor: 'pointer',
                      boxShadow: active ? `0 0 0 1px rgba(255,255,255,0.42), 0 24px 64px ${routeTone.border}` : '0 18px 46px rgba(2,6,23,0.18)',
                      zIndex: 4,
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 }}>
                      <div>
                        <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.14em', color: 'rgba(255,255,255,0.56)' }}>
                          Route
                        </div>
                        <div style={{ marginTop: 4, fontSize: 14, fontWeight: 700 }}>{route.title}</div>
                      </div>
                      <div style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 4,
                        padding: '5px 8px',
                        borderRadius: 999,
                        background: 'rgba(15,23,42,0.24)',
                        fontSize: 10,
                        color: 'rgba(255,255,255,0.76)',
                      }}>
                        <Grip size={10} strokeWidth={2} />
                        drag
                      </div>
                    </div>
                    <div style={{ marginTop: 8, fontSize: 11, lineHeight: 1.55, color: 'rgba(255,255,255,0.80)' }}>
                      {route.summary}
                    </div>
                  </motion.button>
                );
              })}

              {selectedRoute.relatedIssues.map((related, index) => (
                <div
                  key={related.id}
                  style={{
                    position: 'absolute',
                    left: relatedPositions[index].x,
                    top: relatedPositions[index].y,
                    width: RELATED_SIZE.width,
                    minHeight: RELATED_SIZE.height,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    padding: '0 12px',
                    borderRadius: 999,
                    border: '1px solid rgba(250,204,21,0.28)',
                    background: 'rgba(146, 64, 14, 0.16)',
                    color: '#fde68a',
                    fontSize: 11,
                    lineHeight: 1.3,
                    textAlign: 'center',
                    zIndex: 3,
                  }}
                >
                  {related.title}
                </div>
              ))}

              {selectedRoute.tasks.map((task, index) => (
                <div
                  key={task.id}
                  style={{
                    position: 'absolute',
                    left: taskPositions[index].x,
                    top: taskPositions[index].y,
                    width: TASK_SIZE.width,
                    minHeight: TASK_SIZE.height,
                    padding: 14,
                    borderRadius: 22,
                    border: '1px solid rgba(148,163,184,0.12)',
                    background: 'rgba(8,12,20,0.72)',
                    boxShadow: '0 16px 40px rgba(2,6,23,0.22)',
                    zIndex: 3,
                  }}
                >
                  <div style={{ display: 'flex', gap: 10 }}>
                    <div style={{
                      width: 30,
                      height: 30,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      borderRadius: 12,
                      background: 'rgba(255,255,255,0.05)',
                      color: '#bfdbfe',
                      flexShrink: 0,
                    }}>
                      <Bot size={14} strokeWidth={2} />
                    </div>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 12, fontWeight: 700, lineHeight: 1.25 }}>{task.title}</div>
                      <div style={{ marginTop: 4, fontSize: 11, lineHeight: 1.5, color: 'rgba(226,232,240,0.62)' }}>
                        {task.detail}
                      </div>
                    </div>
                  </div>
                </div>
              ))}

              {selectedRoute.prs.map((pr, index) => (
                <div
                  key={pr.id}
                  style={{
                    position: 'absolute',
                    left: prPositions[index].x,
                    top: prPositions[index].y,
                    width: PR_SIZE.width,
                    minHeight: PR_SIZE.height,
                    padding: 14,
                    borderRadius: 22,
                    border: '1px solid rgba(148,163,184,0.12)',
                    background: 'rgba(8,12,20,0.72)',
                    boxShadow: '0 16px 40px rgba(2,6,23,0.22)',
                    zIndex: 3,
                  }}
                >
                  <div style={{ display: 'flex', gap: 10 }}>
                    <div style={{
                      width: 30,
                      height: 30,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      borderRadius: 12,
                      background: 'rgba(255,255,255,0.05)',
                      color: '#f8fafc',
                      flexShrink: 0,
                    }}>
                      <Github size={14} strokeWidth={2} />
                    </div>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 12, fontWeight: 700, lineHeight: 1.25 }}>{pr.title}</div>
                      <div style={{ marginTop: 4, fontSize: 11, lineHeight: 1.5, color: 'rgba(226,232,240,0.62)' }}>
                        {pr.detail}
                      </div>
                    </div>
                  </div>
                </div>
              ))}

              <div
                style={{
                  position: 'absolute',
                  left: mergePosition.x,
                  top: mergePosition.y,
                  width: MERGE_SIZE.width,
                  minHeight: MERGE_SIZE.height,
                  padding: 14,
                  borderRadius: 24,
                  border: '1px solid rgba(148,163,184,0.16)',
                  background: 'rgba(255,255,255,0.05)',
                  boxShadow: '0 18px 48px rgba(2,6,23,0.22)',
                  zIndex: 3,
                }}
              >
                <div style={{ height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
                  <div>
                    <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.16em', color: 'rgba(226,232,240,0.52)' }}>
                      Merge gate
                    </div>
                    <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 8, fontSize: 15, fontWeight: 700 }}>
                      <Merge size={14} strokeWidth={2.2} />
                      {board.merge.title}
                    </div>
                    <div style={{ marginTop: 8, fontSize: 11, lineHeight: 1.55, color: 'rgba(226,232,240,0.62)' }}>
                      {board.merge.detail}
                    </div>
                  </div>
                  <div style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    fontSize: 11,
                    color: 'rgba(226,232,240,0.52)',
                    textTransform: 'uppercase',
                    letterSpacing: '0.10em',
                  }}>
                    Review
                    <ArrowRight size={12} strokeWidth={2.2} />
                    Merge
                  </div>
                </div>
              </div>
              </div>
            </div>
          </div>
        </section>

        <aside style={{
          minHeight: 0,
          borderRadius: 28,
          border: '1px solid rgba(148,163,184,0.12)',
          background: 'linear-gradient(180deg, rgba(10, 14, 26, 0.98), rgba(9, 12, 21, 0.94))',
          overflow: 'auto',
          boxShadow: '0 24px 60px rgba(2,6,23,0.28)',
          padding: 16,
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
        }}>
          <div style={{
            padding: 16,
            borderRadius: 22,
            border: '1px solid rgba(148,163,184,0.12)',
            background: 'rgba(8,12,20,0.70)',
          }}>
            <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.18em', color: 'rgba(148,163,184,0.62)' }}>
              Compose
            </div>
            <div style={{ marginTop: 6, fontSize: 18, fontWeight: 700, letterSpacing: '-0.02em' }}>
              Brainstorm with the board
            </div>
            <div style={{ marginTop: 8, fontSize: 12, lineHeight: 1.6, color: 'rgba(226,232,240,0.70)' }}>
              Ask for routes, tradeoffs, tasks, or PR outputs. This v1 only uses model reasoning, not terminal/runtime sessions.
            </div>

            <div style={{ marginTop: 14 }}>
              <ModelSelect
                disabled={isGenerating}
                onChange={(value) => {
                  const nextModel = MODELS.find((option) => option.id === value);
                  if (nextModel) {
                    setModel(nextModel);
                  }
                }}
                options={MODELS}
                value={model.id}
              />
            </div>

            <textarea
              ref={inputRef}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void handleGenerate();
                }
              }}
              placeholder="Turn an issue, initiative, or rough idea into route options..."
              style={{
                width: '100%',
                minHeight: 110,
                marginTop: 14,
                padding: 14,
                borderRadius: 18,
                border: '1px solid rgba(148,163,184,0.14)',
                background: 'rgba(2, 6, 23, 0.72)',
                color: '#f8fafc',
                fontSize: 13,
                lineHeight: 1.6,
                resize: 'vertical',
                outline: 'none',
              }}
            />

            <div style={{
              marginTop: 10,
              display: 'flex',
              flexWrap: 'wrap',
              gap: 8,
            }}>
              {PROMPT_SUGGESTIONS.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  onClick={() => {
                    setPrompt(suggestion);
                    inputRef.current?.focus();
                  }}
                  style={{
                    padding: '7px 10px',
                    borderRadius: 999,
                    border: '1px solid rgba(148,163,184,0.14)',
                    background: 'rgba(15,23,42,0.58)',
                    color: 'rgba(226,232,240,0.74)',
                    fontSize: 11,
                    lineHeight: 1.4,
                    cursor: 'pointer',
                    textAlign: 'left',
                  }}
                >
                  {suggestion}
                </button>
              ))}
            </div>

            <div style={{ marginTop: 14, display: 'flex', gap: 10 }}>
              <button
                type="button"
                onClick={() => void handleGenerate()}
                disabled={isGenerating || !prompt.trim()}
                style={{
                  flex: 1,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 8,
                  padding: '11px 14px',
                  borderRadius: 14,
                  border: 'none',
                  background: isGenerating ? 'rgba(37,99,235,0.42)' : 'linear-gradient(135deg, #2563eb, #0ea5e9)',
                  color: '#fff',
                  fontSize: 13,
                  fontWeight: 700,
                  cursor: isGenerating ? 'default' : 'pointer',
                }}
              >
                {isGenerating ? <Loader2 size={14} strokeWidth={2.4} className="animate-spin" /> : <ArrowRight size={14} strokeWidth={2.4} />}
                {isGenerating ? 'Thinking...' : 'Generate board'}
              </button>
              <button
                type="button"
                onClick={handleReset}
                disabled={isGenerating}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 6,
                  padding: '11px 12px',
                  borderRadius: 14,
                  border: '1px solid rgba(148,163,184,0.14)',
                  background: 'rgba(15,23,42,0.52)',
                  color: '#cbd5e1',
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: isGenerating ? 'default' : 'pointer',
                }}
              >
                <RefreshCw size={14} strokeWidth={2.2} />
                Reset
              </button>
            </div>

            {error ? (
              <div style={{
                marginTop: 12,
                padding: '10px 12px',
                borderRadius: 14,
                background: 'rgba(127, 29, 29, 0.30)',
                border: '1px solid rgba(248,113,113,0.18)',
                color: '#fecaca',
                fontSize: 12,
                lineHeight: 1.5,
              }}>
                {error}
              </div>
            ) : null}
          </div>

          <div style={{
            padding: 16,
            borderRadius: 22,
            border: '1px solid rgba(148,163,184,0.12)',
            background: tone(selectedRoute.vibe).background,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, fontWeight: 700, color: tone(selectedRoute.vibe).text }}>
              {selectedRoute.vibe === 'safe'
                ? <Shield size={14} strokeWidth={2.2} />
                : selectedRoute.vibe === 'fast'
                  ? <Zap size={14} strokeWidth={2.2} />
                  : <Sparkles size={14} strokeWidth={2.2} />}
              Route inspector
            </div>
            <div style={{ marginTop: 8, fontSize: 19, fontWeight: 700, letterSpacing: '-0.02em', color: '#f8fafc' }}>
              {selectedRoute.title}
            </div>
            <div style={{ marginTop: 8, fontSize: 12, lineHeight: 1.6, color: 'rgba(255,255,255,0.82)' }}>
              {selectedRoute.summary}
            </div>
            <div style={{ marginTop: 12, fontSize: 12, lineHeight: 1.6, color: '#f8fafc' }}>
              {selectedRoute.recommendation}
            </div>
            <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>
              <MiniBar label="Confidence" value={selectedRoute.confidence} />
              <MiniBar label="Speed" value={selectedRoute.speed} />
              <MiniBar label="Safety" value={100 - selectedRoute.risk} />
            </div>
          </div>

          <div style={{
            padding: 16,
            borderRadius: 22,
            border: '1px solid rgba(148,163,184,0.12)',
            background: 'rgba(8,12,20,0.70)',
          }}>
            <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.18em', color: 'rgba(148,163,184,0.62)' }}>
              Board notes
            </div>
            <div style={{ marginTop: 10, fontSize: 12, lineHeight: 1.7, color: '#e2e8f0' }}>
              {renderLLMMarkdown(board.notes)}
            </div>
            <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
              {board.nextQuestions.map((question) => (
                <button
                  key={question}
                  type="button"
                  onClick={() => {
                    setPrompt(question);
                    inputRef.current?.focus();
                  }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    width: '100%',
                    padding: '10px 12px',
                    borderRadius: 14,
                    border: '1px solid rgba(148,163,184,0.12)',
                    background: 'rgba(15,23,42,0.56)',
                    color: '#e2e8f0',
                    fontSize: 12,
                    lineHeight: 1.5,
                    cursor: 'pointer',
                    textAlign: 'left',
                  }}
                >
                  <GitBranch size={13} strokeWidth={2.2} style={{ color: '#93c5fd', flexShrink: 0 }} />
                  <span>{question}</span>
                </button>
              ))}
            </div>
          </div>

          {(isGenerating || rawOutput) ? (
            <div style={{
              padding: 16,
              borderRadius: 22,
              border: '1px solid rgba(148,163,184,0.12)',
              background: 'rgba(8,12,20,0.70)',
            }}>
              <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.18em', color: 'rgba(148,163,184,0.62)' }}>
                Live output
              </div>
              <div style={{
                marginTop: 10,
                maxHeight: 180,
                overflow: 'auto',
                padding: 12,
                borderRadius: 16,
                background: 'rgba(2,6,23,0.72)',
                border: '1px solid rgba(148,163,184,0.12)',
                fontSize: 11,
                lineHeight: 1.6,
                color: 'rgba(226,232,240,0.78)',
                whiteSpace: 'pre-wrap',
                fontFamily: '"SF Mono", ui-monospace, monospace',
              }}>
                {streamPreview || rawOutput || 'Waiting for model output...'}
              </div>
            </div>
          ) : null}

          {history.length > 0 ? (
            <div style={{
              padding: 16,
              borderRadius: 22,
              border: '1px solid rgba(148,163,184,0.12)',
              background: 'rgba(8,12,20,0.70)',
            }}>
              <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.18em', color: 'rgba(148,163,184,0.62)' }}>
                Session turns
              </div>
              <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 10 }}>
                {history.map((turn) => (
                  <div
                    key={turn.id}
                    style={{
                      padding: 12,
                      borderRadius: 16,
                      border: '1px solid rgba(148,163,184,0.10)',
                      background: 'rgba(15,23,42,0.52)',
                    }}
                  >
                    <div style={{ fontSize: 11, lineHeight: 1.5, color: '#f8fafc', fontWeight: 600 }}>
                      {turn.prompt}
                    </div>
                    <div style={{ marginTop: 6, fontSize: 11, lineHeight: 1.55, color: 'rgba(226,232,240,0.62)' }}>
                      {turn.summary}
                    </div>
                    <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                      <span style={{
                        fontSize: 10,
                        color: '#93c5fd',
                        textTransform: 'uppercase',
                        letterSpacing: '0.14em',
                      }}>
                        {turn.routeTitle}
                      </span>
                      <span style={{ fontSize: 10, color: 'rgba(148,163,184,0.72)' }}>
                        {new Date(turn.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </aside>
      </div>
    </div>
  );
}
