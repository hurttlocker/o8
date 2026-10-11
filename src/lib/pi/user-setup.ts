import { constants } from 'node:fs';
import { access, open, opendir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveCli } from '@/lib/runtimes/shared/cli-resolver';
import type { RuntimeSession } from '@/lib/runtimes/types';

const SETTINGS_BYTES = 64 * 1024;
const HEADER_BYTES = 64 * 1024;
const MAX_ENTRIES = 2_000;
export const PI_SESSION_COPY_BYTES = 16 * 1024 * 1024;

export interface PiUserSetup {
  detected: boolean;
  agentDir: string;
  binaryPath?: string;
  version?: string;
  provider?: string;
  model?: string;
  credentialsPresent: boolean;
  extensions: number;
  skills: number;
  sessions: number;
  countsTruncated: boolean;
}

function configuredPath(value: string) {
  return path.resolve(value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value);
}

export function piUserAgentDir() {
  return configuredPath(process.env.PI_CODING_AGENT_DIR?.trim() || path.join(os.homedir(), '.pi', 'agent'));
}

// Never use this reader for auth files. Refuse links and non-regular files.
export async function readPiFile(file: string, maxBytes: number, prefixOnly = false): Promise<Buffer | null> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => null);
  if (!handle) return null;
  try {
    const info = await handle.stat();
    if (!info.isFile() || (!prefixOnly && info.size > maxBytes)) return null;
    const buffer = Buffer.alloc(Math.min(info.size, maxBytes));
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    return buffer.subarray(0, offset);
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 200) : undefined;
}

async function readSettings(agentDir: string): Promise<Record<string, unknown>> {
  try {
    const bytes = await readPiFile(path.join(agentDir, 'settings.json'), SETTINGS_BYTES);
    const settings: unknown = bytes ? JSON.parse(bytes.toString('utf8')) : null;
    return settings && typeof settings === 'object' && !Array.isArray(settings) ? settings as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

async function userConfiguration() {
  const agentDir = piUserAgentDir();
  const settings = await readSettings(agentDir);
  const sessionDir = configuredPath(process.env.PI_CODING_AGENT_SESSION_DIR?.trim()
    || (typeof settings.sessionDir === 'string' && settings.sessionDir.trim())
    || path.join(agentDir, 'sessions'));
  return { agentDir, settings, sessionDir };
}

async function scanFiles(root: string, match: (name: string, depth: number) => boolean) {
  const files: string[] = [];
  let visited = 0;
  let truncated = false;
  async function walk(dir: string, depth: number) {
    const entries = await opendir(dir).catch(() => null);
    if (!entries) return;
    for await (const entry of entries) {
      visited += 1;
      if (visited > MAX_ENTRIES) { truncated = true; break; }
      const file = path.join(dir, entry.name);
      if (entry.isFile() && match(entry.name, depth)) files.push(file);
      if (entry.isDirectory() && entry.name !== 'node_modules' && !entry.name.startsWith('.')) {
        if (depth < 4) await walk(file, depth + 1);
        else truncated = true;
      }
      if (truncated && visited > MAX_ENTRIES) break;
    }
  }
  await walk(root, 0);
  return { files, truncated };
}

async function scanExtensions(root: string) {
  const scan = await scanFiles(root, (name, depth) => depth === 0
    ? /\.(?:ts|js)$/.test(name)
    : depth === 1 && ['index.ts', 'index.js', 'package.json'].includes(name));
  const files = new Set(scan.files.filter((file) => path.dirname(file) === root));
  const directories = new Set(scan.files.map((file) => path.dirname(file)).filter((dir) => dir !== root));
  let declaredEntries = 0;
  for (const dir of directories) {
    let declared: string[] = [];
    try {
      const bytes = await readPiFile(path.join(dir, 'package.json'), SETTINGS_BYTES);
      const manifest = bytes ? JSON.parse(bytes.toString('utf8')) as { pi?: { extensions?: unknown } } : null;
      if (Array.isArray(manifest?.pi?.extensions)) {
        declared = manifest.pi.extensions.filter((entry): entry is string => typeof entry === 'string');
      }
    } catch { /* Fall back to the directory's index. */ }
    const entries: string[] = [];
    for (const entry of declared) {
      declaredEntries += 1;
      if (declaredEntries > MAX_ENTRIES) { scan.truncated = true; break; }
      const file = path.resolve(dir, entry);
      if (await access(file).then(() => true, () => false)) entries.push(file);
    }
    if (!entries.length) {
      const index = ['index.ts', 'index.js'].map((name) => path.join(dir, name)).find((file) => scan.files.includes(file));
      if (index) entries.push(index);
    }
    for (const file of entries) files.add(file);
  }
  return { files: [...files], truncated: scan.truncated };
}

async function scanSkills(root: string) {
  const scan = await scanFiles(root, (name, depth) => name === 'SKILL.md' || (depth === 0 && name.endsWith('.md')));
  const roots = scan.files.filter((file) => path.basename(file) === 'SKILL.md').map((file) => path.dirname(file));
  return {
    files: scan.files.filter((file) => !roots.some((dir) => file !== path.join(dir, 'SKILL.md') && file.startsWith(dir + path.sep))),
    truncated: scan.truncated,
  };
}

function jsonLines(bytes: Buffer) {
  return bytes.toString('utf8').split('\n').flatMap((line): Record<string, unknown>[] => {
    try {
      const value: unknown = JSON.parse(line);
      return value && typeof value === 'object' && !Array.isArray(value) ? [value as Record<string, unknown>] : [];
    } catch { return []; }
  });
}

// Discovery runs on every fleet refresh, so a session file is reread only when
// its size or mtime changes. Holds the files seen by the latest listing.
let headerCache = new Map<string, { mtimeMs: number; size: number; session: RuntimeSession | null }>();

async function sessionsIn(sessionDir: string) {
  const scan = await scanFiles(sessionDir, (name) => name.endsWith('.jsonl'));
  const sessions: RuntimeSession[] = [];
  const seen = new Map<string, { mtimeMs: number; size: number; session: RuntimeSession | null }>();
  for (const file of scan.files) {
    const info = await stat(file).catch(() => null);
    if (!info) continue;
    const cached = headerCache.get(file);
    const session = cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size
      ? cached.session
      : await readSessionHeader(file, info.mtime);
    seen.set(file, { mtimeMs: info.mtimeMs, size: info.size, session });
    if (session) sessions.push(session);
  }
  headerCache = seen;
  return { sessions: sessions.sort((a, b) => a.cwd.localeCompare(b.cwd) || b.lastActivityAt.getTime() - a.lastActivityAt.getTime()), truncated: scan.truncated };
}

async function readSessionHeader(file: string, mtime: Date): Promise<RuntimeSession | null> {
  const bytes = await readPiFile(file, HEADER_BYTES, true);
  if (!bytes) return null;
  const lines = jsonLines(bytes);
  const header = lines[0];
  if (header?.type !== 'session' || typeof header.cwd !== 'string' || !path.isAbsolute(header.cwd)) return null;
  const name = lines.findLast((line) => line.type === 'session_info');
  const model = lines.findLast((line) => line.type === 'model_change');
  return {
    sessionKey: `pi:${file}`,
    runtimeId: 'pi',
    displayName: text(name?.name) ?? `Pi: ${path.basename(header.cwd)}`,
    cwd: header.cwd,
    status: 'idle',
    ownership: 'discovered',
    sessionCapabilities: { canSendInput: true, canInterrupt: false, canReviewDiffs: false },
    lastActivityAt: mtime,
    model: text(model?.modelId),
  };
}

export async function listUserPiSessions(): Promise<RuntimeSession[]> {
  if (process.platform === 'win32') return [];
  return (await sessionsIn((await userConfiguration()).sessionDir)).sessions;
}

export async function findUserPiSession(sessionKey: string) {
  return (await listUserPiSessions()).find((session) => session.sessionKey === sessionKey) ?? null;
}

export async function detectPiUserSetup(): Promise<PiUserSetup> {
  const { agentDir, settings, sessionDir } = await userConfiguration();
  if (process.platform === 'win32') {
    return { detected: false, agentDir, credentialsPresent: false, extensions: 0, skills: 0, sessions: 0, countsTruncated: false };
  }
  const [binary, agent, credentialsPresent, extensions, skills, sessions] = await Promise.all([
    resolveCli({ runtimeId: 'pi', binaryName: 'pi', envOverride: 'O8_PI_BIN', versionArgs: ['--version'], versionTimeoutMs: 1_500 }).catch(() => null),
    stat(agentDir).catch(() => null),
    access(path.join(agentDir, 'auth.json')).then(() => true, () => false),
    scanExtensions(path.join(agentDir, 'extensions')),
    scanSkills(path.join(agentDir, 'skills')),
    sessionsIn(sessionDir),
  ]);
  const configuredCount = (key: string) => Array.isArray(settings[key])
    ? new Set((settings[key] as unknown[]).filter((value) => typeof value === 'string')).size : 0;
  return {
    detected: Boolean(binary || agent?.isDirectory()), agentDir,
    binaryPath: binary?.path, version: binary?.version,
    provider: text(settings.defaultProvider), model: text(settings.defaultModel),
    credentialsPresent,
    extensions: extensions.files.length + configuredCount('extensions'),
    skills: skills.files.length + configuredCount('skills'),
    sessions: sessions.sessions.length,
    countsTruncated: extensions.truncated || skills.truncated || sessions.truncated,
  };
}
