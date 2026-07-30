/**
 * Client wrapper for the codebase-memory-mcp `trace_path` tool.
 *
 * #742 — surfaces a small, typed call-graph helper for the Context Recall
 * Card so it can render a "Symbol graph" row alongside directives and
 * recent outcomes. Related trace/search calls share one MCP session because
 * process initialization dominates the underlying graph queries.
 */

import 'server-only';

import { resolveCodebaseMemoryBin } from './binary';
import {
  withCodebaseMemoryToolSession,
  type CodebaseMemoryToolCaller,
} from './mcp-client';

const TRACE_TOOL_NAME = 'trace_path';
const SEARCH_TOOL_NAME = 'search_graph';

/**
 * Derive the codebase-memory project name from a repo's absolute path.
 *
 * #854 — `trace_path` requires a `project` parameter; the binary does NOT
 * auto-detect from `cwd`. The binary names projects as the absolute path
 * with the leading slash stripped and remaining slashes replaced with
 * hyphens, e.g. `/Users/example/UGC` → `Users-example-UGC`.
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
 * Priority order — ordered so the strongest "this is code" signals win when
 * we hit `MAX_SYMBOLS`:
 *
 *   1. Backtick-quoted identifiers: \`extractSymbols\` — operator explicitly
 *      marks something as code, so it's the strongest signal we have.
 *   2. lower_snake / lowerCamel followed by `(`: `findCurrentPacketBranch(`,
 *      `extract_symbols(`. The trailing `(` strongly implies a function call.
 *   3. Multi-cap identifiers (PascalCase with ≥2 caps): `PacketCard`,
 *      `ContextRecallCard`. Weakest signal — could match a TS interface name
 *      that has no graph entry, so it goes last.
 *   4. Dotted member access: `ClassName.method` — captured as part of patterns
 *      1 and 3.
 *
 * Phase-2 audit fix (#897 sibling): a body with 4 valid backticked refs +
 * 1 PascalCase TS interface used to yield only 1 graph entry because the
 * PascalCase regex ran first and burned a slot on a useless symbol.
 */
const SYMBOL_RES: RegExp[] = [
  // Backtick-quoted identifiers (strongest signal)
  /`([A-Za-z_][A-Za-z0-9_.]{2,})`/g,
  // lower / snake / camel followed by `(`
  /\b([a-z_][A-Za-z0-9_]{2,})(?=\s*\()/g,
  // PascalCase with at least 2 capitals, optional .method suffix
  /\b([A-Z][a-z]+(?:[A-Z][A-Za-z0-9]+)+(?:\.[a-z_][A-Za-z0-9_]*)?)\b/g,
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

/**
 * Phase-2 audit fix — trace a wider candidate set, then keep only the
 * first `limit` symbols whose trace resolved against the project graph.
 *
 * Bug being fixed: callers used to do
 *
 *   const symbols = extractSymbols(body, 3);   // priority order picks 3
 *   const { edges } = await traceSymbols(...);  // many resolve to errors
 *
 * which wasted slots on TS interface names like `SymbolEdge` that have
 * no graph entry. Now we mine 5x the budget, trace once, and only count
 * symbols whose trace returned a file/line or at least one neighbour.
 *
 * Returns both the resolved symbol names AND the trace edges so callers
 * don't have to call `traceSymbols` again — saves the second MCP round-
 * trip.
 *
 * Failure modes:
 *   - empty text / repoPath  → `{ symbols: [], edges: [], unavailable: false }`
 *   - binary missing         → returns the first `limit` candidates with
 *                              `unavailable: true` and `edges: []` so the
 *                              recall card can still hide its row.
 *   - all candidates fail    → `{ symbols: [], edges: [], unavailable: false }`
 */
export interface ExtractGraphResolvedSymbolsResult {
  symbols: string[];
  edges: SymbolEdge[];
  unavailable: boolean;
}

export async function extractGraphResolvedSymbols(
  text: string,
  repoPath: string,
  limit = 3,
): Promise<ExtractGraphResolvedSymbolsResult> {
  if (!text || !repoPath) return { symbols: [], edges: [], unavailable: false };

  // Cast a wider net so we can drop symbols that don't resolve without
  // dropping below `limit`. 5x is enough to recover from the worst common
  // case (e.g. a TS interface name slipping into the candidate list) while
  // keeping the trace cost bounded.
  const candidates = extractSymbols(text, Math.max(limit, limit * 5));
  if (candidates.length === 0) return { symbols: [], edges: [], unavailable: false };

  const traced = await traceSymbols({
    repoPath,
    symbols: candidates,
    resolvedLimit: limit,
  });
  if (traced.unavailable) {
    return {
      symbols: candidates.slice(0, limit),
      edges: [],
      unavailable: true,
    };
  }

  const resolvedSymbols: string[] = [];
  const resolvedEdges: SymbolEdge[] = [];
  for (const edge of traced.edges) {
    if (edge.error) continue;
    const hasDefinition = Boolean(edge.file) || Boolean(edge.line);
    const hasNeighbours = edge.neighbours.length > 0;
    if (!hasDefinition && !hasNeighbours) continue;
    resolvedSymbols.push(edge.symbol);
    resolvedEdges.push(edge);
    if (resolvedSymbols.length >= limit) break;
  }
  return { symbols: resolvedSymbols, edges: resolvedEdges, unavailable: false };
}

/**
 * Why a SymbolEdge has no `file`/`line` set. Surfaced so the UI and the
 * orchestrator-context renderer can differentiate "we don't know what this
 * is" from "this is a known symbol that doesn't carry a definition site"
 * (e.g. labels like File/Folder/Route which the indexer stores without a
 * `start_line`). Phase 4 #739–#741 polish.
 */
export type SymbolEdgeReason =
  /** Symbol matched the index but the indexer doesn't record a line for
   *  this label — File/Folder/Route/Channel/Project nodes. */
  | 'no-definition-recorded'
  /** Symbol was not found in the project graph at all. */
  | 'unknown-symbol'
  /** trace_path returned an explicit error for this symbol. */
  | 'trace-error';

export interface SymbolEdge {
  /** The symbol we asked about. */
  symbol: string;
  /** Indexer label (Function / Interface / Type / etc.) when known. */
  kind?: string | null;
  /** File path of the definition, repo-relative. */
  file?: string | null;
  /** Line number of the definition. */
  line?: number | null;
  /** Names of callers / callees / neighbours discovered by trace_path. */
  neighbours: string[];
  /** Raw error string when the lookup failed for this symbol. */
  error?: string | null;
  /** Why `file`/`line` is unset, when it is. Drives a clearer UI hint. */
  reason?: SymbolEdgeReason | null;
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

/**
 * #898 — codebase-memory-mcp v0.6.0's `trace_path` response omits the
 * subject symbol's `file` and `line` at the top level; only `callers` and
 * `callees` arrays come back, and even those don't carry file/line in
 * practice (just `name`/`qualified_name`/`hop`). Without a fallback,
 * every SymbolEdge in the Recall Card renders "no definition recorded"
 * even when the DB row has the path/line. We try, in order:
 *   1. top-level `file` / `filePath` and `line` / `startLine`
 *   2. first caller's file/line (in case future binary versions emit it)
 *   3. first callee's file/line
 *
 * Convention: when the binary ships a fix in v0.6.1+ the top-level fields
 * win, so this helper degrades gracefully. The remaining gap (when the
 * trace_path response carries no location at all) is filled by an out-of-
 * band `search_graph` lookup in `traceSymbols`.
 */
function pluckDefinitionLocation(payload: RawTracePath): {
  file: string | null;
  line: number | null;
} {
  const topFile = payload.file ?? payload.filePath ?? null;
  const topLine = payload.line ?? payload.startLine ?? null;
  if (topFile && topLine != null) return { file: topFile, line: topLine };

  const fromItem = (item?: RawTracePathItem): { file: string | null; line: number | null } => ({
    file: item?.file ?? item?.filePath ?? null,
    line: item?.line ?? item?.startLine ?? null,
  });

  for (const candidate of payload.callers ?? []) {
    const loc = fromItem(candidate);
    if (loc.file && loc.line != null) return loc;
  }
  for (const candidate of payload.callees ?? []) {
    const loc = fromItem(candidate);
    if (loc.file && loc.line != null) return loc;
  }
  // Partial: if we only have one of the two, return what we have rather
  // than nothing — the UI can still show the file label.
  return { file: topFile, line: topLine };
}

interface RawSearchGraphResult {
  name?: string;
  qualified_name?: string;
  label?: string;
  file_path?: string;
  start_line?: number;
}

interface RawSearchGraphResponse {
  total?: number;
  results?: RawSearchGraphResult[];
}

function parseSearchGraphResult(raw: unknown): RawSearchGraphResponse | null {
  if (!raw || typeof raw !== 'object') return null;
  const result = raw as { content?: Array<{ type?: string; text?: string }> };
  const text = result.content?.[0]?.text;
  if (!text) return null;
  try {
    return JSON.parse(text) as RawSearchGraphResponse;
  } catch {
    return null;
  }
}

interface FindSymbolResult {
  file: string | null;
  line: number | null;
  kind: string | null;
  /** Set when we deliberately didn't return a file/line. */
  reason: SymbolEdgeReason | null;
}

/**
 * Resolve a symbol's definition file/line via `search_graph`. Used as the
 * #898 fallback when `trace_path` doesn't carry the location. The binary
 * indexes file_path + start_line per node; this lookup just reads them.
 *
 * Phase 4 polish (#739–#741): we now require an EXACT name match before
 * returning a location. Previously we fell back to `parsed.results[0]`,
 * which silently returned the wrong file/line for any fuzzy bm25 hit
 * (e.g. searching "async" returned `ghExecAsync` as the definition).
 *
 * Some indexer labels — File / Folder / Route / Channel / Project — are
 * stored without `start_line` by design. When we hit one of those we
 * return the file path but flag the absent line with reason
 * `no-definition-recorded` so the caller can render a clearer hint than
 * the prior "no definition recorded" string-on-falsy.
 */
async function findSymbolDefinition(
  callTool: CodebaseMemoryToolCaller,
  project: string,
  symbol: string,
  timeoutMs: number,
): Promise<FindSymbolResult> {
  const callResult = await callTool({
    toolName: SEARCH_TOOL_NAME,
    args: { query: symbol, project },
    timeoutMs,
  });
  if (!callResult.ok) return { file: null, line: null, kind: null, reason: null };
  const parsed = parseSearchGraphResult(callResult.result);
  if (!parsed?.results?.length) {
    return { file: null, line: null, kind: null, reason: 'unknown-symbol' };
  }
  const exact = parsed.results.find((r) => r.name === symbol);
  if (!exact) {
    // bm25 returned only fuzzy matches — don't lie about the location.
    return { file: null, line: null, kind: null, reason: 'unknown-symbol' };
  }
  const file = exact.file_path ?? null;
  const line = typeof exact.start_line === 'number' && exact.start_line > 0
    ? exact.start_line
    : null;
  const kind = exact.label ?? null;
  // File/Folder/Route/Channel/Project labels carry no line by design —
  // surface that as a structured reason instead of a misleading null.
  const reason: SymbolEdgeReason | null = !line ? 'no-definition-recorded' : null;
  return { file, line, kind, reason };
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
  /** Stop once this many graph-backed symbols resolve. The context builder
   * only renders three, so tracing later candidates would waste tool calls. */
  resolvedLimit?: number;
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
  resolvedLimit,
}: TraceSymbolsOptions): Promise<TraceSymbolsResult> {
  const binPath = resolveCodebaseMemoryBin();
  if (!binPath) return { unavailable: true, edges: [] };

  const edges: SymbolEdge[] = [];
  // #854: trace_path requires `project` — the binary doesn't infer it from
  // cwd, so without this every call returned "project not found or not
  // indexed" and the SYMBOL GRAPH row was permanently unavailable.
  const project = repoPathToProjectName(repoPath);
  let resolvedCount = 0;
  const session = await withCodebaseMemoryToolSession(
    { binPath, cwd: repoPath, timeoutMs },
    async (callTool) => {
      for (const symbol of symbols) {
        const callResult = await callTool({
          toolName: TRACE_TOOL_NAME,
          args: { function_name: symbol, project },
          timeoutMs,
        });
        let edge: SymbolEdge;

        // Phase 4 (#739–#741): when trace_path errors out — including the
        // common "function not found" path for non-callable symbols — still
        // try search_graph, but keep it on this initialized MCP process.
        if (!callResult.ok) {
          const fallback = await findSymbolDefinition(callTool, project, symbol, timeoutMs);
          edge = {
            symbol,
            kind: fallback.kind,
            file: fallback.file,
            line: fallback.line,
            neighbours: [],
            reason: fallback.reason ?? 'trace-error',
            error: fallback.reason ? null : callResult.error,
          };
        } else {
          const parsed = parseTracePathResult(callResult.result);
          if (!parsed) {
            edge = { symbol, neighbours: [] };
          } else if (parsed.error) {
            const fallback = await findSymbolDefinition(callTool, project, symbol, timeoutMs);
            edge = {
              symbol,
              kind: fallback.kind,
              file: fallback.file,
              line: fallback.line,
              neighbours: [],
              reason: fallback.reason ?? 'trace-error',
              error: fallback.reason ? null : parsed.error,
            };
          } else {
            let { file, line } = pluckDefinitionLocation(parsed);
            let kind: string | null = null;
            let reason: SymbolEdgeReason | null = null;
            // #898: v0.6.0 trace responses omit the subject location, so use
            // search_graph on the same session to recover file/start_line.
            if (!file || line == null) {
              const fallback = await findSymbolDefinition(callTool, project, symbol, timeoutMs);
              file = file ?? fallback.file;
              line = line ?? fallback.line;
              kind = fallback.kind;
              reason = fallback.reason;
            }
            edge = {
              symbol,
              kind,
              file,
              line,
              neighbours: pluckNeighbours(parsed),
              reason,
            };
          }
        }

        edges.push(edge);
        if (!edge.error && (Boolean(edge.file) || Boolean(edge.line) || edge.neighbours.length > 0)) {
          resolvedCount += 1;
          if (resolvedLimit && resolvedCount >= resolvedLimit) break;
        }
      }
    },
  );

  if (!session.ok) {
    return {
      unavailable: false,
      edges: symbols.map((symbol) => ({
        symbol,
        neighbours: [],
        error: session.error,
        reason: 'trace-error',
      })),
    };
  }

  return { unavailable: false, edges };
}
