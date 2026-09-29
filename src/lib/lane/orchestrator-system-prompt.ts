import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

import { buildFirstRunClarifyNote } from './clarify-first';
import { getDataDir } from '@/lib/data-dir-migration';
import { ORCHESTRATOR_OUTCOME_OWNERSHIP_FALLBACK_V1 } from '@/lib/prompts/v1';
import { toolProfileCanDispatch, type ToolProfile } from '@/lib/mcp/tool-spine/registry';

/**
 * Shared o8 orchestrator system prompt assembly.
 *
 * Claude can receive this through `--append-system-prompt`; Codex cannot, so
 * the Codex backend prepends this same assembled prompt to each user turn.
 */

const PROMPT_FILE_NAME = 'orchestrator.md';
const FALLBACK_PROMPT = [
  'You are the orchestrator for o8. The markdown prompt file could not be loaded.',
  'Primary repo: "{{REPO_NAME}}" at {{REPO_PATH}}.',
  ORCHESTRATOR_OUTCOME_OWNERSHIP_FALLBACK_V1,
  'Work carefully, use cortex_* MCP tools for fleet awareness, and always end your',
  'review turns with a VERDICT block so the user has an actionable summary.',
].join('\n');

function resolvePromptFilePath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, PROMPT_FILE_NAME);
}

/**
 * True when at least one lane (dispatched packet) exists for the repo.
 * Read-only direct open of the main DB — this module stays a lightweight
 * string builder (no @/lib/db import chain), and a missing DB file is a
 * fresh install, which IS a first run.
 */
function repoHasDispatchHistory(repoPath: string): boolean {
  try {
    const db = new Database(join(getDataDir(), 'cortex-ide.db'), { readonly: true, fileMustExist: true });
    try {
      return db.prepare('SELECT 1 FROM lanes WHERE repo_path = ? LIMIT 1').get(repoPath) !== undefined;
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
}

/** The tool surface a turn actually has, which decides the prompt sections it gets. */
export interface OrchestratorPromptSurface {
  /** Operator server and full cortex: dispatch, review, merge, render. */
  dispatch: boolean;
  /** Cortex read tools: fleet status, issues, PRs, packets, transcripts. */
  cortexReads: boolean;
}

export function orchestratorPromptSurface(opts?: {
  toolProfile?: ToolProfile;
  /** False when the backend launches with no MCP servers at all (Codex single mode). */
  mcpServers?: boolean;
}): OrchestratorPromptSurface {
  const mcpServers = opts?.mcpServers !== false;
  return {
    dispatch: mcpServers && toolProfileCanDispatch(opts?.toolProfile),
    cortexReads: mcpServers,
  };
}

const SCOPED_SECTION = /^<!-- o8:(dispatch|cortex-reads) -->\n([\s\S]*?)^<!-- o8:\/\1 -->\n/gm;

/**
 * `orchestrator.md` wraps sections that need a tool surface in
 * `<!-- o8:dispatch -->` or `<!-- o8:cortex-reads -->` markers. Keep a section
 * only when the turn has that surface, so a Solo turn is never taught tools its
 * profile removed (#2898). Marker lines never reach the model.
 */
export function scopeOrchestratorPrompt(template: string, surface: OrchestratorPromptSurface): string {
  return template.replace(SCOPED_SECTION, (_match, kind: string, body: string) => {
    const kept = kind === 'dispatch' ? surface.dispatch : surface.cortexReads;
    return kept ? body : '';
  });
}

export function buildOrchestratorSystemPrompt(
  repoPath: string,
  opts?: {
    /** Test override — production callers omit and it's computed from the lanes table. */
    firstRunClarify?: boolean;
    /** The MCP tool profile the turn runs with. Defaults to the full surface. */
    toolProfile?: ToolProfile;
    /** False when the backend launches with no MCP servers at all (Codex single mode). */
    mcpServers?: boolean;
  },
): string {
  const repoName = repoPath.split('/').filter(Boolean).pop() ?? repoPath;

  let allRepos: Array<{ name: string; localPath: string }> = [];
  try {
    const reposFile = join(getDataDir(), 'repos.json');
    if (existsSync(reposFile)) {
      const parsed = JSON.parse(readFileSync(reposFile, 'utf-8'));
      allRepos = (parsed.repos ?? []).map((r: { name?: string; localPath: string }) => ({
        name: r.name ?? r.localPath.split('/').filter(Boolean).pop() ?? r.localPath,
        localPath: r.localPath,
      }));
    }
  } catch {
    // Best effort; a missing/corrupt repo registry should not break a turn.
  }

  const repoList = allRepos.length > 0
    ? allRepos.map((r) => `  - ${r.name} → ${r.localPath}`).join('\n')
    : `  - ${repoName} → ${repoPath}`;

  let template: string;
  try {
    template = readFileSync(resolvePromptFilePath(), 'utf-8');
  } catch (err) {
    console.warn(
      `[orchestrator-session] Failed to load ${PROMPT_FILE_NAME}: ${(err as Error).message}. Using minimal fallback prompt.`,
    );
    template = FALLBACK_PROMPT;
  }

  // Clarify-first, first-mission trigger (silent — system prompt only, never
  // the transcript): a repo with no dispatch history gets the interview note.
  const firstRun = opts?.firstRunClarify ?? !repoHasDispatchHistory(repoPath);

  return scopeOrchestratorPrompt(template, orchestratorPromptSurface(opts))
    .replaceAll('{{REPO_NAME}}', repoName)
    .replaceAll('{{REPO_PATH}}', repoPath)
    .replaceAll('{{REPO_LIST}}', repoList)
    .replaceAll('{{CLARIFY_FIRST_RUN_NOTE}}', firstRun ? buildFirstRunClarifyNote() : '');
}
