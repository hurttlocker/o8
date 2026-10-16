import 'server-only';
import { mkdirSync, readFileSync, renameSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { getDataDir } from '@/lib/data-dir-migration';

export interface LocalAcpConnection { name: string; command: string; args: string[]; useOpenRouter: boolean }
const file = () => join(getDataDir(), 'local-acp.json');
export function parseLocalAcpConnection(value: unknown): LocalAcpConnection {
  const v = value as Partial<LocalAcpConnection> | null;
  if (!v || typeof v.name !== 'string' || !v.name.trim() || v.name.length > 80
    || typeof v.command !== 'string' || !v.command.trim() || v.command.length > 1024 || /[\r\n\0]/.test(v.command)
    || !Array.isArray(v.args) || v.args.length > 128 || v.args.some(arg => typeof arg !== 'string' || arg.length > 4096 || arg.includes('\0'))
    || typeof v.useOpenRouter !== 'boolean') throw new Error('Enter a name, executable, and one literal argument per line.');
  return { name: v.name.trim(), command: v.command.trim(), args: v.args, useOpenRouter: v.useOpenRouter };
}
export function readLocalAcpConnection(): LocalAcpConnection | null {
  try { return parseLocalAcpConnection(JSON.parse(readFileSync(file(), 'utf8'))); } catch { return null; }
}
export function saveLocalAcpConnection(value: unknown): LocalAcpConnection | null {
  const parsed = value === null ? null : parseLocalAcpConnection(value);
  mkdirSync(getDataDir(), { recursive: true });
  const temp = `${file()}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(parsed), { mode: 0o600 });
  renameSync(temp, file());
  rmSync(join(getDataDir(), 'acp-models', 'acp.json'), { force: true });
  return parsed;
}
export function resolveLocalAcpLaunch() {
  const command = process.env.O8_ACP_COMMAND?.trim();
  if (command) {
    const raw = process.env.O8_ACP_ARGS?.trim() ?? '';
    const args = raw.startsWith('[') ? JSON.parse(raw) : raw.split(' ').filter(Boolean);
    return parseLocalAcpConnection({ name: 'Local ACP', command, args, useOpenRouter: false });
  }
  return readLocalAcpConnection();
}

/** Resolve explicit credential forwarding at both probe and conversation spawns. */
export function localAcpProcessLaunch() {
  const connection = resolveLocalAcpLaunch();
  return connection ? { ...connection, omitEnv: connection.useOpenRouter ? [] : ['OPENROUTER_API_KEY'] } : null;
}

export function acpLaunchFingerprint(launch: { command: string; args: string[]; env?: Record<string, string>; omitEnv?: string[] }): string {
  return createHash('sha256').update(JSON.stringify([launch.command, launch.args, launch.env, launch.omitEnv])).digest('hex');
}
