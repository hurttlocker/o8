import { NextRequest, NextResponse } from 'next/server';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { getDb, usageLogs } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/panel/analytics?hours=24
 *
 * Returns comprehensive cost/usage analytics aggregated across:
 * - Codex CLI owned sessions
 * - Claude Code sessions
 * - IDE LLM chat usage logs
 */

type SurfaceKey = 'Codex CLI' | 'Claude Code' | 'IDE LLM Chat';

interface HourBucket {
  hour: string;
  cost: number;
  messages: number;
  tokens: number;
}

interface ModelBreakdown {
  model: string;
  cost: number;
  messages: number;
  sessions: number;
}

interface Breakdown {
  cost: number;
  messages: number;
  tokens: number;
  sessions: number;
}

interface TopSession {
  id: string;
  agent: string;
  cost: number;
  messages: number;
  model: string;
  active: boolean;
}

interface SessionAccumulator {
  id: string;
  agent: string;
  surface: SurfaceKey;
  cost: number;
  messages: number;
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  cacheWriteTokens: number;
  model: string;
  models: Set<string>;
  active: boolean;
}

const SURFACES: SurfaceKey[] = ['Codex CLI', 'Claude Code', 'IDE LLM Chat'];
const ACTIVE_WINDOW_MS = 5 * 60 * 1000;
const ANTHROPIC_DEFAULT_PRICING = {
  inputPerToken: 3 / 1_000_000,
  outputPerToken: 15 / 1_000_000,
  cacheReadPerToken: 0.3 / 1_000_000,
  cacheWritePerToken: 3.75 / 1_000_000,
};

function safeReadDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function numberOrZero(value: unknown): number {
  return finiteNumber(value) ?? 0;
}

function firstFiniteNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    const parsed = finiteNumber(value);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

function parseTimestamp(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1_000_000_000_000 ? value : value * 1000;
  }
  if (typeof value === 'string' && value.trim()) {
    const direct = Number(value);
    if (Number.isFinite(direct)) {
      return direct > 1_000_000_000_000 ? direct : direct * 1000;
    }
    const parsed = new Date(value).getTime();
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function parseDbTimestamp(value: string | null | undefined): number {
  if (!value) return 0;
  const normalized = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`;
  return parseTimestamp(normalized, 0);
}

function parseTimestampFromName(fileName: string): number | undefined {
  const match = basename(fileName).match(/^(\d{10,13})/);
  if (!match) return undefined;
  return parseTimestamp(Number(match[1]));
}

function normalizeModel(model: string | null | undefined): string {
  const value = String(model ?? 'unknown').trim() || 'unknown';
  return value.replace(/-\d{8}$/, '');
}

function tokenTotal(input: number, output: number, cacheRead: number, cacheWrite: number): number {
  return input + output + cacheRead + cacheWrite;
}

function hourKey(ts: number): string {
  const date = new Date(ts);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:00`;
}

function estimateAnthropicCost(input: number, output: number, cacheRead: number, cacheWrite: number): number {
  return (
    input * ANTHROPIC_DEFAULT_PRICING.inputPerToken
    + output * ANTHROPIC_DEFAULT_PRICING.outputPerToken
    + cacheRead * ANTHROPIC_DEFAULT_PRICING.cacheReadPerToken
    + cacheWrite * ANTHROPIC_DEFAULT_PRICING.cacheWritePerToken
  );
}

function createBreakdown(): Breakdown {
  return { cost: 0, messages: 0, tokens: 0, sessions: 0 };
}

function ensureBreakdown(map: Map<string, Breakdown>, key: string): Breakdown {
  let value = map.get(key);
  if (!value) {
    value = createBreakdown();
    map.set(key, value);
  }
  return value;
}

function ensureModelBreakdown(map: Map<string, ModelBreakdown>, key: string): ModelBreakdown {
  let value = map.get(key);
  if (!value) {
    value = { model: key, cost: 0, messages: 0, sessions: 0 };
    map.set(key, value);
  }
  return value;
}

function createSession(id: string, agent: string, surface: SurfaceKey, active: boolean): SessionAccumulator {
  return {
    id,
    agent,
    surface,
    cost: 0,
    messages: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheTokens: 0,
    cacheWriteTokens: 0,
    model: 'unknown',
    models: new Set<string>(),
    active,
  };
}

function discoverIdeChatSessions(sinceTs: number): Array<{ id: string; model: string }> {
  const historyDir = join(homedir(), '.cortex-ide', 'chat-history');
  const sessions: Array<{ id: string; model: string }> = [];

  for (const file of safeReadDir(historyDir)) {
    if (!file.endsWith('.json')) continue;
    const filePath = join(historyDir, file);

    try {
      const stat = statSync(filePath);
      if (stat.mtimeMs < sinceTs) continue;

      const raw = readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(raw) as { messages?: unknown[]; model?: string };
      if (!Array.isArray(parsed.messages) || parsed.messages.length === 0) continue;

      sessions.push({
        id: basename(file, '.json'),
        model: normalizeModel(parsed.model),
      });
    } catch {
      // skip unreadable history files
    }
  }

  return sessions;
}

export async function GET(request: NextRequest) {
  try {
    const hours = parseInt(request.nextUrl.searchParams.get('hours') || '24', 10);
    const sinceTs = Date.now() - hours * 60 * 60 * 1000;
    const visibleSurfaces = SURFACES;

    const hourlyMap = new Map<string, HourBucket>();
    const modelMap = new Map<string, ModelBreakdown>();
    const agentMap = new Map<string, Breakdown>();
    const surfaceMap = new Map<string, Breakdown>(visibleSurfaces.map((surface) => [surface, createBreakdown()]));
    const topSessions: TopSession[] = [];

    let totalCost = 0;
    let totalMessages = 0;
    let totalInput = 0;
    let totalOutput = 0;
    let totalCache = 0;
    let totalCacheWrite = 0;
    let totalSessions = 0;

    const recordUsage = (args: {
      ts: number;
      cost: number;
      inputTokens: number;
      outputTokens: number;
      cacheTokens: number;
      cacheWriteTokens: number;
      model: string;
      agent: string;
      surface: SurfaceKey;
    }) => {
      const normalizedModel = normalizeModel(args.model);
      const tokens = tokenTotal(args.inputTokens, args.outputTokens, args.cacheTokens, args.cacheWriteTokens);

      totalCost += args.cost;
      totalMessages += 1;
      totalInput += args.inputTokens;
      totalOutput += args.outputTokens;
      totalCache += args.cacheTokens;
      totalCacheWrite += args.cacheWriteTokens;

      const bucketKey = hourKey(args.ts);
      if (!hourlyMap.has(bucketKey)) {
        hourlyMap.set(bucketKey, { hour: bucketKey, cost: 0, messages: 0, tokens: 0 });
      }
      const hourly = hourlyMap.get(bucketKey)!;
      hourly.cost += args.cost;
      hourly.messages += 1;
      hourly.tokens += tokens;

      const model = ensureModelBreakdown(modelMap, normalizedModel);
      model.cost += args.cost;
      model.messages += 1;

      const agent = ensureBreakdown(agentMap, args.agent);
      agent.cost += args.cost;
      agent.messages += 1;
      agent.tokens += tokens;

      const surface = ensureBreakdown(surfaceMap, args.surface);
      surface.cost += args.cost;
      surface.messages += 1;
      surface.tokens += tokens;

      return normalizedModel;
    };

    const finalizeSession = (session: SessionAccumulator) => {
      if (session.messages === 0) return;

      totalSessions += 1;
      ensureBreakdown(agentMap, session.agent).sessions += 1;
      ensureBreakdown(surfaceMap, session.surface).sessions += 1;

      const models = session.models.size > 0 ? session.models : new Set([normalizeModel(session.model)]);
      for (const model of models) {
        ensureModelBreakdown(modelMap, model).sessions += 1;
      }

      topSessions.push({
        id: session.id,
        agent: session.agent,
        cost: session.cost,
        messages: session.messages,
        model: normalizeModel(session.model),
        active: session.active,
      });
    };

    // ── Codex CLI sessions ────────────────────────────────────────────────────
    const codexRoots = [
      join(homedir(), '.cortex-ide', 'owned-codex'),
      join(homedir(), '.cortex-ide', 'owned-codex-archive'),
    ];

    for (const root of codexRoots) {
      for (const sessionDirName of safeReadDir(root)) {
        const runsDir = join(root, sessionDirName, 'runs');
        const runFiles = safeReadDir(runsDir).filter((file) => file.endsWith('.jsonl'));
        if (runFiles.length === 0) continue;

        const session = createSession(sessionDirName, 'Codex CLI', 'Codex CLI', false);

        for (const runFile of runFiles) {
          const runPath = join(runsDir, runFile);

          try {
            const stat = statSync(runPath);
            if ((Date.now() - stat.mtimeMs) < ACTIVE_WINDOW_MS) session.active = true;
            if (stat.mtimeMs < sinceTs) continue;

            const fallbackTs = parseTimestampFromName(runFile) ?? stat.mtimeMs;
            const lines = readFileSync(runPath, 'utf-8').split('\n').filter(Boolean);
            for (const line of lines) {
              try {
                const parsed = JSON.parse(line) as Record<string, unknown>;
                if (parsed.type !== 'turn.completed') continue;

                const usage = (parsed.usage ?? {}) as Record<string, unknown>;
                const ts = parseTimestamp(parsed.timestamp ?? parsed.completed_at, fallbackTs);
                if (ts < sinceTs) continue;

                const inputTokens = numberOrZero(usage.input_tokens);
                const outputTokens = numberOrZero(usage.output_tokens);
                const cacheTokens = numberOrZero(usage.cached_input_tokens);
                const cacheWriteTokens = 0;
                const cost = 0;

                if (inputTokens === 0 && outputTokens === 0 && cacheTokens === 0) continue;

                const normalizedModel = recordUsage({
                  ts,
                  cost,
                  inputTokens,
                  outputTokens,
                  cacheTokens,
                  cacheWriteTokens,
                  model: 'codex',
                  agent: 'Codex CLI',
                  surface: 'Codex CLI',
                });

                session.cost += cost;
                session.messages += 1;
                session.inputTokens += inputTokens;
                session.outputTokens += outputTokens;
                session.cacheTokens += cacheTokens;
                session.models.add(normalizedModel);
                session.model = 'codex';
              } catch {
                // skip malformed run lines
              }
            }
          } catch {
            // skip unreadable run file
          }
        }

        finalizeSession(session);
      }
    }

    // ── Claude Code sessions ─────────────────────────────────────────────────
    const claudeProjectsRoot = join(homedir(), '.claude', 'projects');
    for (const projectDir of safeReadDir(claudeProjectsRoot)) {
      const projectPath = join(claudeProjectsRoot, projectDir);
      const files = safeReadDir(projectPath).filter((file) => file.endsWith('.jsonl'));

      for (const file of files) {
        const filePath = join(projectPath, file);

        try {
          const stat = statSync(filePath);
          if (stat.mtimeMs < sinceTs) continue;

          const session = createSession(
            basename(file, '.jsonl'),
            'Claude Code',
            'Claude Code',
            (Date.now() - stat.mtimeMs) < ACTIVE_WINDOW_MS,
          );

          const lines = readFileSync(filePath, 'utf-8').split('\n').filter(Boolean);
          for (const line of lines) {
            try {
              const parsed = JSON.parse(line) as Record<string, unknown>;
              if (parsed.type !== 'assistant') continue;

              const message = (parsed.message ?? {}) as Record<string, unknown>;
              const usage = (message.usage ?? {}) as Record<string, unknown>;
              if (Object.keys(usage).length === 0) continue;

              const ts = parseTimestamp(parsed.timestamp ?? message.timestamp, stat.mtimeMs);
              if (ts < sinceTs) continue;

              const inputTokens = numberOrZero(usage.input_tokens);
              const outputTokens = numberOrZero(usage.output_tokens);
              const cacheTokens = numberOrZero(usage.cache_read_input_tokens);
              const cacheWriteTokens = numberOrZero(usage.cache_creation_input_tokens);

              if (inputTokens === 0 && outputTokens === 0 && cacheTokens === 0 && cacheWriteTokens === 0) {
                continue;
              }

              const explicitCost = firstFiniteNumber(
                parsed.cost_usd,
                parsed.costUsd,
                message.cost_usd,
                message.costUsd,
                usage.cost_usd,
                usage.costUsd,
              );
              const cost = explicitCost ?? estimateAnthropicCost(inputTokens, outputTokens, cacheTokens, cacheWriteTokens);
              const model = String(message.model ?? parsed.model ?? 'claude');
              const normalizedModel = recordUsage({
                ts,
                cost,
                inputTokens,
                outputTokens,
                cacheTokens,
                cacheWriteTokens,
                model,
                agent: 'Claude Code',
                surface: 'Claude Code',
              });

              session.cost += cost;
              session.messages += 1;
              session.inputTokens += inputTokens;
              session.outputTokens += outputTokens;
              session.cacheTokens += cacheTokens;
              session.cacheWriteTokens += cacheWriteTokens;
              session.models.add(normalizedModel);
              if (session.model === 'unknown' || session.model === '') session.model = model;
            } catch {
              // skip malformed lines
            }
          }

          finalizeSession(session);
        } catch {
          // skip unreadable files
        }
      }
    }

    // ── IDE LLM chat usage logs ──────────────────────────────────────────────
    const llmSessionMap = new Map<string, SessionAccumulator>();
    const llmSessionKeysByModel = new Map<string, Set<string>>();
    const llmModelsUsed = new Set<string>();
    let llmMessages = 0;

    try {
      const db = getDb();
      if (!db) return NextResponse.json({});
      const rows = db.select().from(usageLogs).all();
      for (const row of rows) {
        if (row.agentName !== 'llm-chat') continue;
        if (row.requestType && row.requestType !== 'chat') continue;

        const ts = parseDbTimestamp(row.createdAt);
        if (ts < sinceTs) continue;

        const inputTokens = row.inputTokens ?? 0;
        const outputTokens = row.outputTokens ?? 0;
        const cacheTokens = row.cacheReadTokens ?? 0;
        const cacheWriteTokens = row.cacheWriteTokens ?? 0;
        const cost = row.costUsd ?? 0;

        if (cost === 0 && inputTokens === 0 && outputTokens === 0 && cacheTokens === 0 && cacheWriteTokens === 0) {
          continue;
        }

        const model = normalizeModel(row.model);
        recordUsage({
          ts,
          cost,
          inputTokens,
          outputTokens,
          cacheTokens,
          cacheWriteTokens,
          model,
          agent: 'IDE LLM Chat',
          surface: 'IDE LLM Chat',
        });

        llmMessages += 1;
        llmModelsUsed.add(model);

        const sessionKey = row.sessionKey?.trim();
        if (!sessionKey) continue;

        if (!llmSessionMap.has(sessionKey)) {
          llmSessionMap.set(
            sessionKey,
            createSession(
              sessionKey,
              'IDE LLM Chat',
              'IDE LLM Chat',
              (Date.now() - ts) < ACTIVE_WINDOW_MS,
            ),
          );
        }

        const session = llmSessionMap.get(sessionKey)!;
        session.active = session.active || (Date.now() - ts) < ACTIVE_WINDOW_MS;
        session.cost += cost;
        session.messages += 1;
        session.inputTokens += inputTokens;
        session.outputTokens += outputTokens;
        session.cacheTokens += cacheTokens;
        session.cacheWriteTokens += cacheWriteTokens;
        session.models.add(model);
        if (session.model === 'unknown' || session.model === '') session.model = model;

        if (!llmSessionKeysByModel.has(model)) llmSessionKeysByModel.set(model, new Set<string>());
        llmSessionKeysByModel.get(model)!.add(sessionKey);
      }
    } catch {
      // database unavailable or unreadable
    }

    if (llmMessages > 0) {
      if (llmSessionMap.size > 0) {
        for (const session of llmSessionMap.values()) {
          finalizeSession(session);
        }
      } else {
        const ideChatSessions = discoverIdeChatSessions(sinceTs);
        const sessionCount = ideChatSessions.length > 0 ? ideChatSessions.length : 1;

        totalSessions += sessionCount;
        ensureBreakdown(agentMap, 'IDE LLM Chat').sessions += sessionCount;
        ensureBreakdown(surfaceMap, 'IDE LLM Chat').sessions += sessionCount;

        if (ideChatSessions.length > 0) {
          const sessionsByModel = new Map<string, number>();
          for (const session of ideChatSessions) {
            const model = normalizeModel(session.model);
            sessionsByModel.set(model, (sessionsByModel.get(model) ?? 0) + 1);
          }
          for (const [model, count] of sessionsByModel) {
            ensureModelBreakdown(modelMap, model).sessions += count;
          }
        } else {
          for (const model of llmModelsUsed) {
            ensureModelBreakdown(modelMap, model).sessions += 1;
          }
        }
      }
    }

    topSessions.sort((a, b) => {
      if (b.cost !== a.cost) return b.cost - a.cost;
      if (b.messages !== a.messages) return b.messages - a.messages;
      return a.id.localeCompare(b.id);
    });

    const hourly = Array.from(hourlyMap.values()).sort((a, b) => a.hour.localeCompare(b.hour));
    const byModel = Array.from(modelMap.values()).sort((a, b) => {
      if (b.cost !== a.cost) return b.cost - a.cost;
      if (b.messages !== a.messages) return b.messages - a.messages;
      return a.model.localeCompare(b.model);
    });

    const totalTokens = tokenTotal(totalInput, totalOutput, totalCache, totalCacheWrite);
    const cacheHitRate = (totalInput + totalCache) > 0
      ? (totalCache / (totalInput + totalCache)) * 100
      : 0;

    return NextResponse.json({
      totals: {
        cost: totalCost,
        messages: totalMessages,
        inputTokens: totalInput,
        outputTokens: totalOutput,
        cacheTokens: totalCache,
        cacheWriteTokens: totalCacheWrite,
        sessions: totalSessions,
        cacheHitRate,
        avgCostPerMessage: totalMessages > 0 ? totalCost / totalMessages : 0,
        totalTokens,
      },
      byAgent: Object.fromEntries(agentMap.entries()),
      bySurface: Object.fromEntries(visibleSurfaces.map((surface) => [surface, surfaceMap.get(surface) ?? createBreakdown()])),
      byModel,
      hourly,
      topSessions: topSessions.slice(0, 10),
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unknown' },
      { status: 500 },
    );
  }
}
