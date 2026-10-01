import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { orchestratorDataDir } from './orchestrator-session-core';

/**
 * Claude Code keeps a session's system prompt from its first launch. A
 * `--resume` launch reuses that snapshot and ignores `--append-system-prompt`
 * (probed on Claude Code 2.1.284, #2904). This ledger records which o8
 * orchestrator prompt each Claude session last received, so a resumed session
 * whose prompt went stale gets the current one inside its next turn.
 */

const LEDGER_LIMIT = 500;

type LedgerEntries = Record<string, { prompt: string; at: string }>;

function ledgerPath(): string {
  return join(orchestratorDataDir('orchestrator'), 'prompt-ledger.json');
}

function readLedger(): LedgerEntries {
  try {
    const parsed = JSON.parse(readFileSync(ledgerPath(), 'utf8')) as { sessions?: unknown };
    return parsed.sessions && typeof parsed.sessions === 'object' ? parsed.sessions as LedgerEntries : {};
  } catch {
    return {};
  }
}

export function orchestratorPromptFingerprint(prompt: string): string {
  return createHash('sha256').update(prompt).digest('hex').slice(0, 16);
}

/** Fingerprint of the prompt the Claude session last received, or null when unknown. */
export function readDeliveredOrchestratorPrompt(claudeSessionId: string): string | null {
  const prompt = readLedger()[claudeSessionId]?.prompt;
  return typeof prompt === 'string' ? prompt : null;
}

/** Best effort: a failed write only means the prompt is sent again later. */
export function recordDeliveredOrchestratorPrompt(claudeSessionId: string, fingerprint: string): void {
  try {
    const sessions = readLedger();
    if (sessions[claudeSessionId]?.prompt === fingerprint) return;
    sessions[claudeSessionId] = { prompt: fingerprint, at: new Date().toISOString() };
    const kept = Object.entries(sessions)
      .sort(([, a], [, b]) => String(b.at).localeCompare(String(a.at)))
      .slice(0, LEDGER_LIMIT);
    const path = ledgerPath();
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, sessions: Object.fromEntries(kept) }));
    renameSync(tmp, path);
  } catch (error) {
    console.warn('[orchestrator-session] prompt ledger write failed:', error);
  }
}

/** Carries the current prompt in a turn whose resumed session holds an older one. */
export function withCurrentOrchestratorPrompt(message: string, prompt: string): string {
  return [
    '[o8 orchestrator instructions updated]',
    'This session resumed with the o8 orchestrator prompt from an earlier configuration, and a resumed session keeps its first system prompt. The current prompt is below. Where it differs from the o8 orchestrator instructions in your system prompt, follow this one.',
    '',
    '<o8_orchestrator_prompt>',
    prompt,
    '</o8_orchestrator_prompt>',
    '',
    'Operator message:',
    message,
  ].join('\n');
}
