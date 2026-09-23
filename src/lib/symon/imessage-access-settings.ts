import 'server-only';

import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, lstatSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const PHONE = /^\+[1-9]\d{6,14}$/;
const GROUP_ID = /^[A-Za-z0-9:_-]{1,160}$/;

function normalizedPhone(value: unknown): string {
  return String(value ?? '').replace(/^imessage:/i, '').replace(/[().\s-]/g, '');
}

interface BridgeConfig {
  enabled: boolean;
  directSender: string;
  knowledgeRepoPath: string;
  groupSenders: string[];
  groupConversationIds: string[];
  groupMembers?: Record<string, string[]>;
  groupFullAccess?: Record<string, string[]>;
  groupLabels?: Record<string, string>;
  [key: string]: unknown;
}

export interface IMessageGroupAccess {
  id: string;
  label: string;
  memberSuffixes: string[];
  approvalVersion: string;
  fullAccess: boolean;
  canGrant: boolean;
}

function configPath(): string {
  if (process.env.NODE_ENV === 'test' && process.env.O8_SYMON_IMESSAGE_TEST_CONFIG) {
    return process.env.O8_SYMON_IMESSAGE_TEST_CONFIG;
  }
  return join(homedir(), '.o8', 'symon-imessage-bridge.json');
}

function readConfig(): { path: string; config: BridgeConfig } | null {
  const path = configPath();
  try {
    if (!lstatSync(path).isFile()) return null;
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as BridgeConfig;
    if (typeof parsed.enabled !== 'boolean' || !PHONE.test(normalizedPhone(parsed.directSender))
      || typeof parsed.knowledgeRepoPath !== 'string' || !parsed.knowledgeRepoPath.startsWith('/')
      || !Array.isArray(parsed.groupSenders)
      || !parsed.groupSenders.every((sender) => typeof sender === 'string' && PHONE.test(sender))
      || !Array.isArray(parsed.groupConversationIds)
      || !parsed.groupConversationIds.every((id) => typeof id === 'string' && GROUP_ID.test(id))) return null;
    return { path, config: parsed };
  } catch {
    return null;
  }
}

function membersFor(config: BridgeConfig, id: string): string[] {
  const members = config.groupMembers?.[id];
  if (!Array.isArray(members) || !members.length) return [];
  if (!members.every((sender) => typeof sender === 'string' && PHONE.test(sender)
    && config.groupSenders.includes(sender))) return [];
  return [...new Set(members)];
}

function approvalVersion(id: string, members: string[]): string {
  return createHash('sha256').update([id, ...[...members].sort()].join('\0')).digest('hex');
}

export class IMessageMembershipChangedError extends Error {}

export function readIMessageAccessSettings(): { configured: boolean; enabled: boolean; directSenderSuffix: string | null; groups: IMessageGroupAccess[] } {
  const loaded = readConfig();
  if (!loaded) return { configured: false, enabled: false, directSenderSuffix: null, groups: [] };
  const { config } = loaded;
  return {
    configured: true,
    enabled: config.enabled,
    directSenderSuffix: normalizedPhone(config.directSender).slice(-4),
    groups: config.groupConversationIds.map((id) => {
      const members = membersFor(config, id);
      const grants = config.groupFullAccess?.[id] ?? [];
      return {
        id,
        label: typeof config.groupLabels?.[id] === 'string'
          ? config.groupLabels[id].slice(0, 80) : `iMessage group ${id}`,
        memberSuffixes: members.map((member) => member.slice(-4)),
        approvalVersion: approvalVersion(id, members),
        fullAccess: members.length > 0 && Array.isArray(grants)
          && grants.length === members.length && members.every((member) => grants.includes(member)),
        canGrant: members.length > 0,
      };
    }),
  };
}

function writeConfig(path: string, config: BridgeConfig): void {
  const temporary = join(dirname(path), `.symon-imessage-bridge.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* The temporary file was never created or already moved. */ }
    throw error;
  }
}

export function setIMessageBridgeEnabled(enabled: boolean): boolean | null {
  const loaded = readConfig();
  if (!loaded) return null;
  writeConfig(loaded.path, { ...loaded.config, enabled });
  return readIMessageAccessSettings().enabled;
}

export function setIMessageGroupFullAccess(
  id: string,
  fullAccess: boolean,
  expectedVersion?: string,
): IMessageGroupAccess | null {
  const loaded = readConfig();
  if (!loaded || !GROUP_ID.test(id) || !loaded.config.groupConversationIds.includes(id)) return null;
  const { path, config } = loaded;
  const members = membersFor(config, id);
  if (fullAccess && !members.length) return null;
  if (fullAccess && expectedVersion !== approvalVersion(id, members)) {
    throw new IMessageMembershipChangedError('The approved group membership changed.');
  }
  const groupFullAccess = { ...config.groupFullAccess };
  if (fullAccess) groupFullAccess[id] = members;
  else delete groupFullAccess[id];
  const next: BridgeConfig = { ...config, groupFullAccess };
  writeConfig(path, next);
  return readIMessageAccessSettings().groups.find((group) => group.id === id) ?? null;
}
