import type { CSSProperties } from 'react';
import { APP_FONT_STACK } from '../shared';

export type ExternalMcpTransport = 'stdio' | 'http';

export interface ExternalMcpServer {
  id: string;
  name: string;
  transport: ExternalMcpTransport;
  command: string;
  args: string[];
  argsJson: string;
  envJson: string | null;
  enabled: boolean;
  workerInjection: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ExternalMcpFormState {
  name: string;
  transport: ExternalMcpTransport;
  command: string;
  argsJson: string;
  envJson: string;
  enabled: boolean;
}

export const MONO_FONT = '"SF Mono", ui-monospace, SFMono-Regular, Menlo, monospace';

export const EMPTY_EXTERNAL_SERVER_FORM: ExternalMcpFormState = {
  name: '',
  transport: 'stdio',
  command: '',
  argsJson: '[]',
  envJson: '{}',
  enabled: true,
};

export function parseArgsInput(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed) {
    return [];
  }

  const parsed = JSON.parse(trimmed);
  if (!Array.isArray(parsed)) {
    throw new Error('Args must be a JSON array of strings');
  }

  const args = parsed
    .map((entry) => typeof entry === 'string' ? entry.trim() : '')
    .filter(Boolean);

  if (args.length !== parsed.length) {
    throw new Error('Args must be a JSON array of strings');
  }

  return args;
}

export function parseEnvInput(raw: string): Record<string, string> | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  const parsed = JSON.parse(trimmed);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Env must be a JSON object of string values');
  }

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== 'string') {
      throw new Error('Env must be a JSON object of string values');
    }
    const trimmedKey = key.trim();
    if (!trimmedKey) {
      continue;
    }
    env[trimmedKey] = value;
  }

  return Object.keys(env).length > 0 ? env : null;
}

export function formatServerDetail(server: ExternalMcpServer): string {
  if (server.transport === 'http') {
    return server.command;
  }

  const args = server.args.length > 0 ? ` ${server.args.join(' ')}` : '';
  return `${server.command}${args}`;
}

export function countEnvKeys(raw: string | null): number {
  if (!raw?.trim()) {
    return 0;
  }

  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return 0;
    }
    return Object.keys(parsed).length;
  } catch {
    return 0;
  }
}

export const INPUT_STYLE: CSSProperties = {
  width: '100%',
  height: 40,
  paddingTop: 0,
  paddingRight: 12,
  paddingBottom: 0,
  paddingLeft: 12,
  borderRadius: 10,
  border: '1px solid var(--t-panel-border)',
  background: 'var(--t-input-bg)',
  color: 'var(--t-text)',
  fontSize: 13,
  fontFamily: APP_FONT_STACK,
  outline: 'none',
  boxSizing: 'border-box',
};

export const TEXTAREA_STYLE: CSSProperties = {
  width: '100%',
  minHeight: 94,
  paddingTop: 10,
  paddingRight: 12,
  paddingBottom: 10,
  paddingLeft: 12,
  borderRadius: 10,
  border: '1px solid var(--t-panel-border)',
  background: 'var(--t-input-bg)',
  color: 'var(--t-text)',
  fontSize: 12,
  fontFamily: MONO_FONT,
  outline: 'none',
  boxSizing: 'border-box',
  resize: 'vertical',
  lineHeight: 1.5,
};
