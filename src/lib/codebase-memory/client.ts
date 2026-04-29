/**
 * Client wrapper for the codebase-memory-mcp `trace_path` tool.
 *
 * #742 — surfaces a small, typed call-graph helper for the Context Recall
 * Card so it can render a "Symbol graph" row alongside directives and
 * recent outcomes. We piggyback on `callCodebaseMemoryTool` rather than
 * wiring a dedicated MCP transport; the boot indexer already proves the
 * spawn-per-call pattern is fast enough for sub-second UI use.
 */

import 'server-only';

import { resolveCodebaseMemoryBin } from './binary';
import { callCodebaseMemoryTool } from './mcp-client';

const TRACE_TOOL_NAME = 'trace_path';

/**
 * Derive the codebase-memory project name from a repo's absolute path.
 *
 * #854 — `trace_path` requires a `project` parameter; the binary does NOT
 * auto-detect from `cwd`. The binary names projects as the absolute path
 * with the leading slash stripped and remaining slashes replaced with
 * hyphens, e.g. `/Users/marquisehurtt/UGC` → `Users-marquisehurtt-UGC`.
 * Confirmed against `cli list_projects` on a freshly indexed repo.
 *
 * Windows paths (drive letter + backslashes) are normalized to slashes
 * first so the same convention applies cross-platform.
 */
function repoPathToProjectName(repoPath: string): string {
  return repoPath
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\//g, '-');
}

/**
 * Symbol patterns we mine from packet titles / summaries / issue bodies.
 *
 *   1. Multi-cap identifiers (PascalCase with ≥2 caps): `PacketCard`,
 *      `ContextRecallCard`, `ThoughtsMissionPanel`. Single-cap words like
 *      "Refactor" or "Update" are ignored.
 *   2. lower_snake / lowerCamel followed by `(`: `findCurrentPacketBranch(`,
 *      `extract_symbols(`. The trailing `(` is a strong signal that this
 *      is a function call rather than prose.
 *   3. Dotted member access: `ClassName.method` — captured as a unit.
 *   4. Backtick-quoted identifiers: \`extractSymbols\` — when the operator
 *      explicitly marks code in the prose.
 */
const SYMBOL_RES: RegExp[] = [
  // PascalCase with at least 2 capitals, optional .method suffix
  /\b([A-Z][a-z]+(?:[A-Z][A-Za-z0-9]+)+(?:\.[a-z_][A-Za-z0-9_]*)?)\b/g,
  // lower / snake / camel followed by `(`
  /\b([a-z_][A-Za-z0-9_]{2,})(?=\s*\()/g,
  // Backtick-quoted identifiers
  /`([A-Za-z_][A-Za-z0-9_.]{2,})`/g,
];

const FILE_EXTENSIONS = ['.tsx', '.ts', '.jsx', '.js', '.mts', '.cts', '.json', '.md'];

function stripExtension(name: string): string {
  for (const ext of FILE_EXTENSIONS) {
    if (name.endsWith(ext)) return name.slice(0, -ext.length);
  }
  return name;
}

/**
 * Pull at most `limit` candidate symbols out of an issue body / packet
 * summary. We deliberately accept false positives — `trace_path` returns
 * an empty result for unknown symbols, which the UI just hides.
 */
export function extractSymbols(text: string, limit = 3): string[] {
  if (!text) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  // Strip code fences first so we don't mine prose words inside ``` blocks.
  const cleaned = text.replace(/```[\s\S]*?```/g, ' ');

  for (const re of SYMBOL_RES) {
    for (const match of cleaned.matchAll(re)) {
      let raw = match[1];
      if (!raw) continue;
      raw = stripExtension(raw);
      if (raw.length < 4) continue;
      if (seen.has(raw)) continue;
      seen.add(raw);
      out.push(raw);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

export interface SymbolEdge {
  /** The symbol we asked about. */
  symbol: string;
  /** File path of the definition, repo-relative. */
  file?: string | null;
  /** Line number of the definition. */
  line?: number | null;
  /** Names of callers / callees / neighbours discovered by trace_path. */
  neighbours: string[];
  /** Raw error string when the lookup failed for this symbol. */
  error?: string | null;
}

interface RawTracePathItem {
  function?: string;
  name?: string;
  file?: string;
  filePath?: string;
  line?: number;
  startLine?: number;
}

interface RawTracePath {
  function?: string;
  file?: string;
  filePath?: string;
  line?: number;
  startLine?: number;
  callers?: RawTracePathItem[];
  callees?: RawTracePathItem[];
  paths?: Array<{ nodes?: RawTracePathItem[] }>;
  edges?: RawTracePathItem[];
  error?: string;
}

function pluckNeighbours(payload: RawTracePath): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  const push = (item?: RawTracePathItem) => {
    const label = item?.function ?? item?.name;
    if (!label || seen.has(label)) return;
    seen.add(label);
    names.push(label);
  };
  for (const c of payload.callers ?? []) push(c);
  for (const c of payload.callees ?? []) push(c);
  for (const p of payload.paths ?? []) for (const n of p.nodes ?? []) push(n);
  for (const e of payload.edges ?? []) push(e);
  return names.slice(0, 6);
}

function parseTracePathResult(raw: unknown): RawTracePath | null {
  if (!raw || typeof raw !== 'object') return null;
  const result = raw as { content?: Array<{ type?: string; text?: string }> };
  const text = result.content?.[0]?.text;
  if (!text) return null;
  try {
    return JSON.parse(text) as RawTracePath;
  } catch {
    return null;
  }
}

export interface TraceSymbolsOptions {
  /** Repo root — `cwd` for the MCP child. */
  repoPath: string;
  /** Symbols to trace (output of `extractSymbols`). */
  symbols: string[];
  /** Per-symbol timeout. Defaults to 4 s — well under the 100 ms target
   *  (#742 acceptance criteria) gets clamped to whatever the binary returns
   *  in practice; this is the worst-case ceiling. */
  timeoutMs?: number;
}

export interface TraceSymbolsResult {
  /** True when the binary couldn't be located on disk. */
  unavailable: boolean;
  edges: SymbolEdge[];
}

/**
 * Trace each symbol against the repo's indexed graph. Failures degrade —
 * the edge entry carries an `error` so the UI can show partial results.
 */
export async function traceSymbols({
  repoPath,
  symbols,
  timeoutMs = 4000,
}: TraceSymbolsOptions): Promise<TraceSymbolsResult> {
  const binPath = resolveCodebaseMemoryBin();
  if (!binPath) return { unavailable: true, edges: [] };

  const edges: SymbolEdge[] = [];
  // #854: trace_path requires `project` — the binary doesn't infer it from
  // cwd, so without this every call returned "project not found or not
  // indexed" and the SYMBOL GRAPH row was permanently unavailable.
  const project = repoPathToProjectName(repoPath);

  for (const symbol of symbols) {
    const callResult = await callCodebaseMemoryTool({
      binPath,
      cwd: repoPath,
      toolName: TRACE_TOOL_NAME,
      args: { function_name: symbol, project },
      timeoutMs,
    });

    if (!callResult.ok) {
      edges.push({ symbol, neighbours: [], error: callResult.error });
      continue;
    }

    const parsed = parseTracePathResult(callResult.result);
    if (!parsed) {
      edges.push({ symbol, neighbours: [] });
      continue;
    }
    if (parsed.error) {
      edges.push({ symbol, neighbours: [], error: parsed.error });
      continue;
    }

    edges.push({
      symbol,
      file: parsed.file ?? parsed.filePath ?? null,
      line: parsed.line ?? parsed.startLine ?? null,
      neighbours: pluckNeighbours(parsed),
    });
  }

  return { unavailable: false, edges };
}
