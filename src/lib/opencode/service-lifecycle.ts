import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const COMMAND_TIMEOUT_MS = 5_000;

interface OpenCodeSession {
  id?: unknown;
}

interface OpenCodeSessionList {
  data?: OpenCodeSession[];
}

interface OpenCodeActiveSessions {
  data?: Record<string, unknown>;
}

interface OpenCodeLocation {
  directory?: unknown;
}

export interface OpenCodeWorkspaceReleaseResult {
  released: boolean;
  reason: 'service-stopped' | 'location-not-cached' | 'location-active' | 'released' | 'release-unconfirmed' | 'unavailable';
  activeSessionIds: string[];
  note: string;
}

function binaryName(): string {
  return process.env.O8_OPENCODE_BIN?.trim() || 'opencode2';
}

function normalizeDirectory(directory: string): string {
  return path.resolve(directory);
}

function parseJson<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

async function runOpenCode(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(binaryName(), args, {
    windowsHide: true,
    timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: 2 * 1024 * 1024,
  });
  return stdout.trim();
}

async function cachedLocations(): Promise<OpenCodeLocation[] | null> {
  const output = await runOpenCode(['api', 'get', '/api/debug/location']);
  const parsed = parseJson<unknown>(output);
  return Array.isArray(parsed) ? parsed as OpenCodeLocation[] : null;
}

function locationIsCached(locations: OpenCodeLocation[], directory: string): boolean {
  const normalized = normalizeDirectory(directory);
  return locations.some((location) => (
    typeof location.directory === 'string'
    && normalizeDirectory(location.directory) === normalized
  ));
}

async function activeSessionIdsForDirectory(directory: string): Promise<string[] | null> {
  const activeOutput = await runOpenCode(['api', 'get', '/api/session/active']);
  const active = parseJson<OpenCodeActiveSessions>(activeOutput)?.data;
  if (!active || typeof active !== 'object' || Array.isArray(active)) return null;
  const activeIds = new Set(Object.keys(active));
  if (activeIds.size === 0) return [];

  const query = new URLSearchParams({ directory, limit: '200' });
  const sessionsOutput = await runOpenCode(['api', 'get', `/api/session?${query.toString()}`]);
  const sessions = parseJson<OpenCodeSessionList>(sessionsOutput)?.data;
  if (!Array.isArray(sessions)) return null;
  return sessions
    .map((session) => typeof session.id === 'string' ? session.id : '')
    .filter((sessionId) => activeIds.has(sessionId));
}

/**
 * Evict one idle location from the shared OpenCode service. The service CLI
 * owns discovery and authentication; raw HTTP calls cannot safely reproduce it.
 */
export async function releaseOpenCodeWorkspace(directory: string): Promise<OpenCodeWorkspaceReleaseResult> {
  const target = directory.trim();
  if (!target) {
    return {
      released: false,
      reason: 'unavailable',
      activeSessionIds: [],
      note: 'OpenCode workspace release requires a non-empty directory.',
    };
  }

  try {
    const status = await runOpenCode(['service', 'status']);
    if (!status || status === 'stopped') {
      return {
        released: true,
        reason: 'service-stopped',
        activeSessionIds: [],
        note: 'The shared OpenCode service is stopped.',
      };
    }

    const before = await cachedLocations();
    if (!before) throw new Error('OpenCode returned an unreadable location inventory.');
    if (!locationIsCached(before, target)) {
      return {
        released: true,
        reason: 'location-not-cached',
        activeSessionIds: [],
        note: 'The OpenCode service does not retain this workspace.',
      };
    }

    const activeSessionIds = await activeSessionIdsForDirectory(target);
    if (!activeSessionIds) throw new Error('OpenCode returned unreadable active-session state.');
    if (activeSessionIds.length > 0) {
      return {
        released: false,
        reason: 'location-active',
        activeSessionIds,
        note: `OpenCode still reports ${activeSessionIds.length} active session${activeSessionIds.length === 1 ? '' : 's'} in this workspace.`,
      };
    }

    const query = new URLSearchParams({ 'location[directory]': target });
    await runOpenCode(['api', 'delete', `/api/debug/location?${query.toString()}`]);
    const after = await cachedLocations();
    if (!after) throw new Error('OpenCode did not confirm its location inventory after release.');
    const released = !locationIsCached(after, target);
    return {
      released,
      reason: released ? 'released' : 'release-unconfirmed',
      activeSessionIds: [],
      note: released
        ? 'The OpenCode service released the workspace.'
        : 'The OpenCode service still reports the workspace after release.',
    };
  } catch (error) {
    return {
      released: false,
      reason: 'unavailable',
      activeSessionIds: [],
      note: `OpenCode workspace release was unavailable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
