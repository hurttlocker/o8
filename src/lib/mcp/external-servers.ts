import { randomUUID } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import { externalMcpServers, getDb } from '@/lib/db';

export type ExternalMcpTransport = 'stdio' | 'http';

type ExternalMcpEnv = Record<string, string>;

export interface ExternalMcpServerRecord {
  id: string;
  name: string;
  transport: ExternalMcpTransport;
  command: string;
  args: string[];
  argsJson: string;
  env: ExternalMcpEnv | null;
  envJson: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface InsertExternalMcpServerInput {
  name: string;
  transport: ExternalMcpTransport;
  command: string;
  args?: string[];
  env?: ExternalMcpEnv | null;
  enabled?: boolean;
}

interface ExternalMcpServerRow {
  id: string;
  name: string;
  transport: ExternalMcpTransport;
  command: string;
  args: string;
  envJson: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export type OrchestratorMcpServerConfig =
  | {
    type: 'stdio';
    command: string;
    args: string[];
    env?: Record<string, string>;
  }
  | {
    type: 'http';
    url: string;
  };

function requireDb() {
  const db = getDb();
  if (!db) {
    throw new Error('Database unavailable');
  }
  return db;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sanitizeArgs(args: string[] | null | undefined): string[] {
  if (!Array.isArray(args)) {
    return [];
  }
  return args
    .map((value) => typeof value === 'string' ? value.trim() : '')
    .filter(Boolean);
}

function parseArgsJson(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .map((value) => typeof value === 'string' ? value : '')
      .filter(Boolean);
  } catch {
    return [];
  }
}

function sanitizeEnv(env: ExternalMcpEnv | null | undefined): ExternalMcpEnv | null {
  if (!env || !isRecord(env)) {
    return null;
  }

  const next: ExternalMcpEnv = {};
  for (const [key, value] of Object.entries(env)) {
    const trimmedKey = key.trim();
    if (!trimmedKey || typeof value !== 'string') {
      continue;
    }
    next[trimmedKey] = value;
  }

  return Object.keys(next).length > 0 ? next : null;
}

function parseEnvJson(raw: string | null): ExternalMcpEnv | null {
  if (!raw?.trim()) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw);
    return sanitizeEnv(isRecord(parsed) ? parsed as ExternalMcpEnv : null);
  } catch {
    return null;
  }
}

function serializeArgs(args: string[] | null | undefined): string {
  return JSON.stringify(sanitizeArgs(args));
}

function serializeEnv(env: ExternalMcpEnv | null | undefined): string | null {
  const sanitized = sanitizeEnv(env);
  return sanitized ? JSON.stringify(sanitized) : null;
}

function toRecord(row: ExternalMcpServerRow): ExternalMcpServerRecord {
  const args = parseArgsJson(row.args);
  const env = parseEnvJson(row.envJson);
  return {
    ...row,
    args,
    argsJson: JSON.stringify(args),
    env,
    envJson: env ? JSON.stringify(env, null, 2) : null,
  };
}

export function listExternalMcpServers(): ExternalMcpServerRecord[] {
  const db = requireDb();
  return db.select()
    .from(externalMcpServers)
    .orderBy(asc(externalMcpServers.createdAt), asc(externalMcpServers.name))
    .all()
    .map((row) => toRecord(row as ExternalMcpServerRow));
}

export function listEnabledExternalMcpServers(): ExternalMcpServerRecord[] {
  const db = requireDb();
  return db.select()
    .from(externalMcpServers)
    .where(eq(externalMcpServers.enabled, true))
    .orderBy(asc(externalMcpServers.createdAt), asc(externalMcpServers.name))
    .all()
    .map((row) => toRecord(row as ExternalMcpServerRow));
}

export function insertExternalMcpServer(input: InsertExternalMcpServerInput): ExternalMcpServerRecord {
  const db = requireDb();
  const now = new Date().toISOString();
  const name = input.name.trim();
  const command = input.command.trim();

  if (!name) {
    throw new Error('Server name is required');
  }
  if (!command) {
    throw new Error(input.transport === 'http' ? 'Server URL is required' : 'Command is required');
  }

  const existing = db.select()
    .from(externalMcpServers)
    .where(eq(externalMcpServers.name, name))
    .get();
  if (existing) {
    throw new Error(`An MCP server named "${name}" already exists`);
  }

  const id = randomUUID();
  db.insert(externalMcpServers).values({
    id,
    name,
    transport: input.transport,
    command,
    args: serializeArgs(input.args),
    envJson: serializeEnv(input.env),
    enabled: input.enabled ?? true,
    createdAt: now,
    updatedAt: now,
  }).run();

  const row = db.select().from(externalMcpServers).where(eq(externalMcpServers.id, id)).get();
  if (!row) {
    throw new Error('Failed to create MCP server');
  }
  return toRecord(row as ExternalMcpServerRow);
}

export function setExternalMcpServerEnabled(id: string, enabled: boolean): ExternalMcpServerRecord | null {
  const db = requireDb();
  const now = new Date().toISOString();
  const result = db.update(externalMcpServers)
    .set({ enabled, updatedAt: now })
    .where(eq(externalMcpServers.id, id))
    .run();

  if ((result.changes ?? 0) <= 0) {
    return null;
  }

  const row = db.select().from(externalMcpServers).where(eq(externalMcpServers.id, id)).get();
  return row ? toRecord(row as ExternalMcpServerRow) : null;
}

export function removeExternalMcpServer(id: string): boolean {
  const db = requireDb();
  const result = db.delete(externalMcpServers)
    .where(eq(externalMcpServers.id, id))
    .run();
  return (result.changes ?? 0) > 0;
}

export function externalServerToMcpConfig(server: ExternalMcpServerRecord): OrchestratorMcpServerConfig {
  if (server.transport === 'http') {
    return {
      type: 'http',
      url: server.command,
    };
  }

  const env = server.env ?? undefined;
  return {
    type: 'stdio',
    command: server.command,
    args: server.args,
    ...(env ? { env } : {}),
  };
}
