import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';

interface TerminalSessionRegistryEntry {
  sessionName: string;
  runtime: 'claude-code' | 'codex';
  cwd?: string;
  updatedAt: string;
}

type TerminalSessionRegistry = Record<string, TerminalSessionRegistryEntry>;

const STATE_DIR = getDataDir();
const REGISTRY_PATH = path.join(STATE_DIR, 'runtime-terminal-sessions.json');

function readRegistry(): TerminalSessionRegistry {
  try {
    if (!existsSync(REGISTRY_PATH)) return {};
    return JSON.parse(readFileSync(REGISTRY_PATH, 'utf-8')) as TerminalSessionRegistry;
  } catch {
    return {};
  }
}

function writeRegistry(next: TerminalSessionRegistry) {
  if (!existsSync(STATE_DIR)) {
    mkdirSync(STATE_DIR, { recursive: true });
  }
  writeFileSync(REGISTRY_PATH, JSON.stringify(next, null, 2));
}

function normalizeScopePath(value?: string | null) {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return path.resolve(trimmed.replace(/^~(?=\/|$)/, homedir())).replace(/\/+$/, '');
}

function pathBelongsToRepoScope(candidatePath?: string | null, repoPath?: string | null) {
  const candidate = normalizeScopePath(candidatePath);
  const repo = normalizeScopePath(repoPath);
  if (!candidate || !repo) return false;
  return candidate === repo || candidate.startsWith(`${repo}/`);
}

export function registerRuntimeTerminalSession(
  sessionKey: string,
  entry: Omit<TerminalSessionRegistryEntry, 'updatedAt'>,
) {
  const registry = readRegistry();
  registry[sessionKey] = {
    ...entry,
    updatedAt: new Date().toISOString(),
  };
  writeRegistry(registry);
}

export function getRuntimeTerminalSession(sessionKey: string) {
  return readRegistry()[sessionKey] ?? null;
}

export function removeRuntimeTerminalSessionsForRepoPath(repoPath: string) {
  const registry = readRegistry();
  const removedSessionKeys: string[] = [];

  for (const [sessionKey, entry] of Object.entries(registry)) {
    if (!pathBelongsToRepoScope(entry.cwd, repoPath)) continue;
    removedSessionKeys.push(sessionKey);
    delete registry[sessionKey];
  }

  if (removedSessionKeys.length > 0) {
    writeRegistry(registry);
  }

  return removedSessionKeys;
}
