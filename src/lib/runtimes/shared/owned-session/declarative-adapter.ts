import type { ThinkingEffort } from '@/lib/orchestrator/thinking-effort';
import { compactText, formatClock } from './helpers';
import { createOwnedSessionStore } from './store';
import type {
  OwnedRunRecord,
  OwnedRuntimeAdapter,
  OwnedSessionStore,
  OwnedTailEntry,
  ParsedRunLog,
} from './types';

type TemplateKey = 'cwd' | 'prompt' | 'model' | 'effort' | 'threadId';
type TemplateContext = Partial<Record<TemplateKey, string>>;

export interface DeclarativeArgGroup {
  when: TemplateKey;
  args: string[];
}

export type DeclarativeArgTemplate = Array<string | DeclarativeArgGroup>;

export interface DeclarativeRunLogPattern {
  eventType?: string | RegExp;
  linePattern?: RegExp;
  when?: { path: string; equals: string };
  kind?: OwnedTailEntry['kind'];
  label?: string;
  labelPaths?: string[];
  textPaths?: string[];
  textGroup?: number;
  threadIdPaths?: string[];
  threadIdGroup?: number;
  threadIdPattern?: RegExp;
  completedTurn?: boolean;
}

export interface DeclarativeRunLogPatterns {
  eventTypePaths?: string[];
  timestampPaths?: string[];
  patterns: DeclarativeRunLogPattern[];
  includeUnmatchedJson?: boolean;
}

export type DeclarativeOwnedRuntimeConfig = Omit<
  OwnedRuntimeAdapter,
  'launchArgs' | 'resumeArgs' | 'parseRunLog' | 'stderrNoise'
> & {
  launchArgs: DeclarativeArgTemplate;
  resumeArgs: DeclarativeArgTemplate | null;
  parseRunLog: DeclarativeRunLogPatterns;
  stderrNoise?: RegExp[];
};

export interface DeclarativeOwnedRuntimeRegistration {
  adapter: OwnedRuntimeAdapter;
  store: OwnedSessionStore;
}

const registry = new Map<string, DeclarativeOwnedRuntimeRegistration>();
const TEMPLATE_TOKEN = /\{\{(cwd|prompt|model|effort|threadId)\}\}/g;

function renderArg(value: string, context: TemplateContext): string {
  return value.replace(TEMPLATE_TOKEN, (_match, key: TemplateKey) => {
    const replacement = context[key];
    if (replacement === undefined) {
      throw new Error(`Missing declarative CLI template value: ${key}`);
    }
    return replacement;
  });
}

export function renderDeclarativeArgs(
  template: DeclarativeArgTemplate,
  context: TemplateContext,
): string[] {
  return template.flatMap((part) => {
    if (typeof part === 'string') return [renderArg(part, context)];
    if (context[part.when] === undefined) return [];
    return part.args.map((arg) => renderArg(arg, context));
  });
}

function readPath(source: unknown, dottedPath: string): unknown {
  let current = source;
  for (const segment of dottedPath.split('.')) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function stringifyValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    return value.map(stringifyValue).filter(Boolean).join(' ');
  }
  if (value && typeof value === 'object') {
    const preferred = ['text', 'message', 'content', 'output']
      .map((key) => readPath(value, key))
      .map(stringifyValue)
      .find(Boolean);
    if (preferred) return preferred;
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return '';
}

function firstPathValue(source: unknown, paths: string[] | undefined): unknown {
  for (const candidate of paths ?? []) {
    const value = readPath(source, candidate);
    if (value !== undefined && value !== null && stringifyValue(value)) return value;
  }
  return undefined;
}

function normalizeTimestamp(value: unknown, fallback: string): string {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  if (typeof value === 'string' && /^\d{11,}$/.test(value.trim())) {
    const epochMs = Number(value);
    if (Number.isFinite(epochMs)) return new Date(epochMs).toISOString();
  }
  return stringifyValue(value) || fallback;
}

function regexTest(pattern: RegExp, value: string): boolean {
  pattern.lastIndex = 0;
  return pattern.test(value);
}

function regexExec(pattern: RegExp, value: string): RegExpExecArray | null {
  pattern.lastIndex = 0;
  return pattern.exec(value);
}

function patternMatches(
  pattern: DeclarativeRunLogPattern,
  eventType: string,
  parsed: Record<string, unknown> | null,
  rawLine: string,
): RegExpExecArray | null | false {
  let lineMatch: RegExpExecArray | null = null;
  if (pattern.linePattern) {
    lineMatch = regexExec(pattern.linePattern, rawLine);
    if (!lineMatch) return false;
  } else if (!parsed) {
    return false;
  }
  if (typeof pattern.eventType === 'string' && pattern.eventType !== eventType) return false;
  if (pattern.eventType instanceof RegExp && !regexTest(pattern.eventType, eventType)) return false;
  if (pattern.when && stringifyValue(readPath(parsed, pattern.when.path)) !== pattern.when.equals) return false;
  return lineMatch;
}

function parseDeclarativeRunLog(
  config: DeclarativeRunLogPatterns,
  raw: string,
  run: OwnedRunRecord,
): ParsedRunLog {
  const entries: OwnedTailEntry[] = [{
    id: `${run.id}:prompt`,
    kind: 'event',
    label: run.mode === 'launch' ? 'Launch prompt' : 'Resume prompt',
    text: compactText(run.prompt, 400),
    timestamp: run.startedAt,
    timestampLabel: formatClock(run.startedAt),
  }];
  let threadId: string | undefined;
  let completedTurn = false;
  const fallbackTimestamp = run.finishedAt ?? run.startedAt;

  for (const [lineIndex, rawLine] of raw.split('\n').entries()) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    let parsed: Record<string, unknown> | null = null;
    if (trimmed.startsWith('{')) {
      try {
        const candidate = JSON.parse(trimmed) as unknown;
        parsed = candidate && typeof candidate === 'object' && !Array.isArray(candidate)
          ? candidate as Record<string, unknown>
          : null;
      } catch {
        parsed = null;
      }
    }
    const eventType = stringifyValue(firstPathValue(parsed, config.eventTypePaths ?? ['type']));
    const timestamp = normalizeTimestamp(
      firstPathValue(parsed, config.timestampPaths ?? ['timestamp']),
      fallbackTimestamp,
    );
    let matched = false;

    for (const pattern of config.patterns) {
      const lineMatch = patternMatches(pattern, eventType, parsed, trimmed);
      if (lineMatch === false) continue;
      matched = true;
      const threadValue = lineMatch && pattern.threadIdGroup !== undefined
        ? lineMatch[pattern.threadIdGroup]
        : stringifyValue(firstPathValue(parsed, pattern.threadIdPaths));
      if (threadValue && (!pattern.threadIdPattern || regexTest(pattern.threadIdPattern, threadValue))) {
        threadId = threadValue;
      }
      if (pattern.completedTurn) completedTurn = true;
      if (!pattern.kind) break;

      const label = stringifyValue(firstPathValue(parsed, pattern.labelPaths)) || pattern.label || eventType || 'Runtime event';
      const text = lineMatch && pattern.textGroup !== undefined
        ? lineMatch[pattern.textGroup] ?? ''
        : stringifyValue(firstPathValue(parsed, pattern.textPaths)) || stringifyValue(parsed) || trimmed;
      entries.push({
        id: `${run.id}:${eventType || 'line'}:${lineIndex}`,
        kind: pattern.kind,
        label,
        text: compactText(text, pattern.kind === 'message' ? 1000 : 800),
        timestamp,
        timestampLabel: formatClock(timestamp),
      });
      break;
    }

    if (!matched && parsed && config.includeUnmatchedJson) {
      entries.push({
        id: `${run.id}:unknown:${lineIndex}`,
        kind: 'event',
        label: eventType || 'unknown',
        text: compactText(stringifyValue(parsed), 300),
        timestamp,
        timestampLabel: formatClock(timestamp),
      });
    }
  }

  const outcome = run.outcome === 'running'
    ? completedTurn
      ? 'finished'
      : run.interruptRequestedAt
        ? 'interrupted'
        : 'running'
    : run.outcome;
  return { threadId, entries, outcome, completedTurn };
}

function launchContext(ctx: {
  cwd: string;
  prompt: string;
  model?: string;
  effort?: ThinkingEffort;
}, defaultModel?: string): TemplateContext {
  return {
    cwd: ctx.cwd,
    prompt: ctx.prompt,
    ...(ctx.model || defaultModel ? { model: ctx.model || defaultModel } : {}),
    ...(ctx.effort ? { effort: ctx.effort } : {}),
  };
}

export function createDeclarativeOwnedRuntimeAdapter(
  config: DeclarativeOwnedRuntimeConfig,
): OwnedRuntimeAdapter {
  const { launchArgs, resumeArgs, parseRunLog, stderrNoise, ...base } = config;
  return {
    ...base,
    launchArgs: (ctx) => renderDeclarativeArgs(launchArgs, launchContext(ctx, base.defaultModel)),
    resumeArgs: resumeArgs === null
      ? () => null
      : (ctx) => renderDeclarativeArgs(resumeArgs, {
          prompt: ctx.prompt,
          threadId: ctx.threadId,
          ...(ctx.model || base.defaultModel ? { model: ctx.model || base.defaultModel } : {}),
        }),
    parseRunLog: (raw, run) => parseDeclarativeRunLog(parseRunLog, raw, run),
    stderrNoise,
  };
}

export function registerDeclarativeOwnedRuntime(
  config: DeclarativeOwnedRuntimeConfig,
): DeclarativeOwnedRuntimeRegistration {
  if (registry.has(config.runtimeId)) {
    throw new Error(`Declarative owned runtime already registered: ${config.runtimeId}`);
  }
  const adapter = createDeclarativeOwnedRuntimeAdapter(config);
  const registration = { adapter, store: createOwnedSessionStore(adapter) };
  registry.set(config.runtimeId, registration);
  return registration;
}

export function getDeclarativeOwnedRuntime(
  runtimeId: string,
): DeclarativeOwnedRuntimeRegistration | undefined {
  return registry.get(runtimeId);
}
