import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

import { buildFirstRunClarifyNote } from './clarify-first';
import { getDataDir } from '@/lib/data-dir-migration';

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

export function buildOrchestratorSystemPrompt(
  repoPath: string,
  opts?: {
    /** Test override — production callers omit and it's computed from the lanes table. */
    firstRunClarify?: boolean;
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

  return template
    .replaceAll('{{REPO_NAME}}', repoName)
    .replaceAll('{{REPO_PATH}}', repoPath)
    .replaceAll('{{REPO_LIST}}', repoList)
    .replaceAll('{{CLARIFY_FIRST_RUN_NOTE}}', firstRun ? buildFirstRunClarifyNote() : '');
}
