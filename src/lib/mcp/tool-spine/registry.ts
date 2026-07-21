/**
 * Tool-Spine Registry — the single neutral source of truth for MCP server config.
 *
 * o8 used to hand-maintain the same server list in ~7 places across 4+ runtimes
 * (Claude orchestrator, Codex orchestrator, Claude Desktop, OpenClaw, Gemini).
 * That duplication caused a real config-drift outage. This module is the catalog;
 * the `emit-*.ts` files are pure projections of it into each runtime's native
 * format. Adding a new CLI is one ~25-line emitter, not a 7-file change.
 *
 * `source` (provenance/trust) is orthogonal to transport (stdio/http, inside
 * `config`) — a future gateway is just `source:'gateway', config:{type:'http'}`,
 * zero schema change. `surfaceNames` is the drift killer: the operator→"o8"
 * rename (previously implicit across 3 copies) becomes data. `secretRefs` is
 * inert in Phase 1 but reserves the vault-phase join point.
 */

import type { OrchestratorMcpServerConfig } from '@/lib/mcp/external-servers';

export type ServerSource = 'builtin' | 'external' | 'gateway';

export type ToolSurface =
  | 'claude-orchestrator' // Claude --mcp-config JSON   (Set A)
  | 'codex-orchestrator' //  Codex config.toml          (Set A)
  | 'claude-desktop' //      ~/.claude.json             (Set B)
  | 'openclaw' //            ~/.openclaw-o8/openclaw.json (Set B)
  | 'gemini' //              ~/.gemini/settings.json     (Set B)
  | 'opencode'; //           ~/.config/opencode/opencode.json (Set B)

/**
 * Tool profile — which trust class of servers a surface receives for one turn.
 *  - `'full'`    → every server the surface is a member of (today's behavior).
 *  - `'propose'` → the read-only proposer profile (Collide/MoA): the operator
 *    server — which carries dispatch_mission / create_mission / approve_and_merge
 *    — is OMITTED so a proposer physically cannot dispatch work. cortex is a
 *    MIXED surface (read tools + mutators like `cortex_launch_agent`, which
 *    dispatches a worker), so it is relaunched read-only (CORTEX_READONLY=1) —
 *    only its allowlisted read tools survive. The #1075 dispatch lockout, as data.
 *  - `'solo'`   → the selected orchestrator works directly: operator dispatch
 *    and external MCP servers are omitted, while native repo tools remain.
 *  - `'fable'`   → the Fable orchestrator profile: KEEPS operator (dispatch) +
 *    cortex (ask) so Fable can still orchestrate, but STRIPS every external
 *    (user-configured) server. The real token lever is Layer B — Claude's native
 *    read/write tools are locked out at the CLI (see `fable-profile.ts`); this
 *    profile only shapes the MCP surface. cortex stays at full read for now.
 *  - `'fable-solo'` combines Fable billing/model selection with the Solo MCP
 *    projection and direct native repo tools.
 */
export type ToolProfile = 'full' | 'propose' | 'solo' | 'fable' | 'fable-solo';

/** Inert in Phase 1; the vault-phase credential-injection hook. */
export interface SecretRef {
  vaultKey: string;
  inject: { kind: 'env'; name: string } | { kind: 'header'; name: string };
}

export interface ServerEntry {
  /** Stable identity, NOT the wire key. */
  id: string;
  /** Default wire key. */
  name: string;
  source: ServerSource;
  label: string;
  /** Which emitters include this entry. */
  surfaces: ToolSurface[];
  /** Per-surface key override (e.g. operator→"o8" on external surfaces). */
  surfaceNames?: Partial<Record<ToolSurface, string>>;
  /** The SAME stdio|http union the DB already uses. */
  config: OrchestratorMcpServerConfig;
  /** Undefined in Phase 1. */
  secretRefs?: SecretRef[];
}

/** Entry order is load-bearing — emitters preserve it. */
export interface ToolRegistry {
  repoPath: string;
  entries: ServerEntry[];
}

export interface ResolvedEntry {
  /** The per-surface wire key (surfaceNames override applied). */
  name: string;
  config: OrchestratorMcpServerConfig;
  entry: ServerEntry;
}

/**
 * Project the registry onto a single surface: filter to entries that list the
 * surface, in registry order, with the per-surface name applied. An entry can't
 * leak to a surface it doesn't list — the gate is data on the catalog, evaluated
 * identically by every emitter.
 */
export function entriesForSurface(registry: ToolRegistry, surface: ToolSurface): ResolvedEntry[] {
  return registry.entries
    .filter((e) => e.surfaces.includes(surface))
    .map((e) => ({ name: e.surfaceNames?.[surface] ?? e.name, config: e.config, entry: e }));
}
