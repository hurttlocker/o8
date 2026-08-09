/**
 * Slash-prefix routing for the orchestrator composer.
 *
 * Lets a user type `/codex add a button` (or `/chat what is X`,
 * `/gemini ...`, `/opencode ...`) and have the message routed to a
 * fresh tab in that mode instead of dispatched on the current Fleet
 * tab. `/orchestrate` and `/fleet` route back to the current Fleet
 * coordinator. The spawned-tab body is carried into the new tab's
 * composer via sessionStorage (see consumePendingComposerDraft) so the
 * user only has to press Enter once more to send.
 *
 * This is intentionally separate from the orchestrator slash command
 * system at `@/lib/slash-commands` — those commands operate on the
 * current orchestrator session (compact, clear, ask the brain). Mode
 * routing operates BETWEEN tabs, not within one.
 */

import type { OrchestratorRuntime } from '@/lib/orchestrator/types';
import type { OrchestratorSlashCommandDefinition } from '@/lib/slash-commands';

export type ModeRoutingTarget =
  | { kind: 'fleet' }
  | { kind: 'chat' }
  | { kind: 'single'; runtime: OrchestratorRuntime };

interface PrefixRule {
  prefix: string;
  target: ModeRoutingTarget;
}

const PREFIX_RULES: PrefixRule[] = [
  { prefix: '/orchestrate', target: { kind: 'fleet' } },
  { prefix: '/fleet', target: { kind: 'fleet' } },
  { prefix: '/chat', target: { kind: 'chat' } },
  { prefix: '/codex', target: { kind: 'single', runtime: 'codex' } },
  { prefix: '/gemini', target: { kind: 'single', runtime: 'gemini' } },
  { prefix: '/opencode', target: { kind: 'single', runtime: 'opencode' } },
];

export const MODE_ROUTING_SLASH_COMMANDS: OrchestratorSlashCommandDefinition[] = [
  {
    command: '/chat',
    name: 'orchestrate',
    title: 'Chat',
    description: 'Open a casual o8 chat tab with tools on this repo.',
    argHint: '<message>',
    requiresArgument: true,
    group: 'route',
  },
  {
    command: '/codex',
    name: 'orchestrate',
    title: 'Codex',
    description: 'Open a one-agent Codex tab for this repo.',
    argHint: '<task>',
    requiresArgument: true,
    group: 'route',
  },
  {
    command: '/gemini',
    name: 'orchestrate',
    title: 'Gemini',
    description: 'Open a one-agent Gemini tab for this repo.',
    argHint: '<task>',
    requiresArgument: true,
    group: 'route',
  },
  {
    command: '/opencode',
    name: 'orchestrate',
    title: 'OpenCode 2',
    description: 'Open a one-agent OpenCode 2 tab for this repo.',
    argHint: '<task>',
    requiresArgument: true,
    group: 'route',
  },
];

export interface ParsedModeRoutingInput {
  target: ModeRoutingTarget;
  body: string;
}

export function parseModeRoutingPrefix(value: string): ParsedModeRoutingInput | null {
  const normalized = value.trimStart();
  if (!normalized.startsWith('/')) return null;

  const lower = normalized.toLowerCase();
  for (const rule of PREFIX_RULES) {
    // Match either `<prefix> <body>` or just `<prefix>` (empty body is OK —
    // the spawned tab opens with an empty composer).
    if (lower === rule.prefix || lower.startsWith(`${rule.prefix} `) || lower.startsWith(`${rule.prefix}\n`)) {
      const body = normalized.slice(rule.prefix.length).trimStart();
      return { target: rule.target, body };
    }
  }
  return null;
}

const STORAGE_KEY = 'o8:pending-composer-draft';
const FRESHNESS_MS = 6_000;

interface StoredDraft {
  ts: number;
  target: ModeRoutingTarget;
  body: string;
}

export function stashPendingComposerDraft(target: ModeRoutingTarget, body: string): void {
  if (typeof window === 'undefined') return;
  try {
    const payload: StoredDraft = { ts: Date.now(), target, body };
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // ignore — failed stash means new tab opens with empty composer
  }
}

/**
 * Pop the pending draft if it matches the caller's mode/runtime AND is
 * still fresh. Returns the body text or null. Always clears the slot —
 * one slash route, one consumer.
 */
export function consumePendingComposerDraft(target: ModeRoutingTarget): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredDraft;
    if (!parsed || typeof parsed.ts !== 'number') return null;
    if (Date.now() - parsed.ts > FRESHNESS_MS) {
      window.sessionStorage.removeItem(STORAGE_KEY);
      return null;
    }
    if (!targetMatches(parsed.target, target)) return null;
    window.sessionStorage.removeItem(STORAGE_KEY);
    return typeof parsed.body === 'string' ? parsed.body : null;
  } catch {
    return null;
  }
}

function targetMatches(stored: ModeRoutingTarget, mine: ModeRoutingTarget): boolean {
  if (stored.kind !== mine.kind) return false;
  if (stored.kind === 'single' && mine.kind === 'single') {
    return stored.runtime === mine.runtime;
  }
  return true;
}
