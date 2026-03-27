import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

interface TerminalSessionRegistryEntry {
  sessionName: string;
  runtime: 'claude-code' | 'codex';
  cwd?: string;
  updatedAt: string;
}

type TerminalSessionRegistry = Record<string, TerminalSessionRegistryEntry>;

const STATE_DIR = path.join(homedir(), '.cortex-ide');
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
