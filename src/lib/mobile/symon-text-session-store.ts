import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';
import type { SymonClientSubject, SymonWorkspaceMode } from '@/lib/mobile/symon-agent-registry';
import { DEFAULT_SYMON_MACHINE, type SymonMachineIdentity } from '@/lib/symon/machine-registry';

export const SYMON_TEXT_SESSION_STALE_MS = 10 * 60 * 1_000;
const MAX_SESSIONS = 20;
const MAX_TRANSCRIPT_MESSAGES = 24;
const MAX_TRANSCRIPT_CHARS = 32_000;

export interface SymonTextTranscriptEntry {
  role: 'user' | 'assistant';
  text: string;
}

export interface SymonTextSessionRecord extends SymonClientSubject {
  sessionId: string;
  model: string;
  effort: string;
  engine: 'claude' | 'codex';
  workspaceMode: SymonWorkspaceMode;
  repoId: string | null;
  repoPath: string | null;
  allowedTools: string[];
  createdAt: number;
  lastActivityAt: number;
  transcript: SymonTextTranscriptEntry[];
  activeMachine: SymonMachineIdentity;
}

function path(): string {
  return join(getDataDir(), 'symon-text-sessions.json');
}

function loadAll(): SymonTextSessionRecord[] {
  try {
    const parsed = JSON.parse(readFileSync(path(), 'utf8')) as unknown;
    return Array.isArray(parsed) ? parsed as SymonTextSessionRecord[] : [];
  } catch {
    return [];
  }
}

function persist(records: SymonTextSessionRecord[]): void {
  const target = path();
  mkdirSync(getDataDir(), { recursive: true });
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(records)}\n`, { mode: 0o600 });
  renameSync(temp, target);
}

function active(records: SymonTextSessionRecord[], now: number): SymonTextSessionRecord[] {
  return records
    .filter((record) => now - record.lastActivityAt <= SYMON_TEXT_SESSION_STALE_MS)
    .map((record) => ({ ...record, activeMachine: record.activeMachine ?? DEFAULT_SYMON_MACHINE }));
}

export function createSymonTextSession(
  input: Omit<SymonTextSessionRecord, 'sessionId' | 'createdAt' | 'lastActivityAt' | 'transcript' | 'activeMachine'>,
  now: number = Date.now(),
): SymonTextSessionRecord {
  const record: SymonTextSessionRecord = {
    ...input,
    sessionId: randomUUID(),
    createdAt: now,
    lastActivityAt: now,
    transcript: [],
    activeMachine: DEFAULT_SYMON_MACHINE,
  };
  persist([record, ...active(loadAll(), now)].slice(0, MAX_SESSIONS));
  return record;
}

export function createSymonTextSessionFromTranscript(
  input: Omit<SymonTextSessionRecord, 'sessionId' | 'createdAt' | 'lastActivityAt' | 'transcript' | 'activeMachine'>,
  transcript: SymonTextTranscriptEntry[],
  now: number = Date.now(),
): SymonTextSessionRecord {
  const record: SymonTextSessionRecord = {
    ...input,
    sessionId: randomUUID(),
    createdAt: now,
    lastActivityAt: now,
    transcript: capTranscript(transcript),
    activeMachine: DEFAULT_SYMON_MACHINE,
  };
  persist([record, ...active(loadAll(), now)].slice(0, MAX_SESSIONS));
  return record;
}

export function updateSymonTextMachine(
  sessionId: string,
  activeMachine: SymonMachineIdentity,
  now: number = Date.now(),
): SymonTextSessionRecord | null {
  const records = active(loadAll(), now);
  const index = records.findIndex((record) => record.sessionId === sessionId);
  if (index < 0) return null;
  records[index] = { ...records[index], activeMachine, lastActivityAt: now };
  persist(records);
  return records[index];
}

export function loadSymonTextSession(sessionId: string, now: number = Date.now()): SymonTextSessionRecord | null {
  const records = loadAll();
  const live = active(records, now);
  if (live.length !== records.length) persist(live);
  return live.find((record) => record.sessionId === sessionId) ?? null;
}

function capTranscript(entries: SymonTextTranscriptEntry[]): SymonTextTranscriptEntry[] {
  const capped = entries.slice(-MAX_TRANSCRIPT_MESSAGES);
  let chars = capped.reduce((total, entry) => total + entry.text.length, 0);
  while (capped.length > 1 && chars > MAX_TRANSCRIPT_CHARS) {
    chars -= capped.shift()?.text.length ?? 0;
  }
  return capped;
}

export function appendSymonTextTranscript(
  sessionId: string,
  entries: SymonTextTranscriptEntry[],
  now: number = Date.now(),
): SymonTextSessionRecord | null {
  const records = active(loadAll(), now);
  const index = records.findIndex((record) => record.sessionId === sessionId);
  if (index < 0) return null;
  records[index] = {
    ...records[index],
    lastActivityAt: now,
    transcript: capTranscript([...records[index].transcript, ...entries]),
  };
  persist(records);
  return records[index];
}

export function dropSymonTextSession(sessionId: string): boolean {
  const records = loadAll();
  const next = records.filter((record) => record.sessionId !== sessionId);
  if (next.length === records.length) return false;
  persist(next);
  return true;
}

export function formatSymonTextPlannerPrompt(record: SymonTextSessionRecord, nextText: string): string {
  const history = record.transcript.map((entry) => `${entry.role === 'user' ? 'User' : 'Symon'}: ${entry.text}`);
  const scope = record.workspaceMode === 'code' && record.repoPath
    ? `This text session is scoped to the registered repository ${record.repoPath}.`
    : 'This text session uses the general o8 workspace scope.';
  return [
    scope,
    history.length > 0 ? `Conversation so far:\n${history.join('\n')}` : '',
    `User: ${nextText}`,
    'Reply to the newest user message. Preserve context from the transcript above.',
  ].filter(Boolean).join('\n\n');
}
