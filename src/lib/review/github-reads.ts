import { childEnvironment } from '@/lib/providers/spawn-environment';
import { createHash } from 'node:crypto';
import path from 'node:path';

// Local workspace changes can refresh every second; remote metadata cannot.
const READ_TTL_MS = 120_000;
const ERROR_TTL_MS = 60_000;
const MAX_ENTRIES = 64;
interface Result { raw: string; warning?: string }
interface Entry {
  raw?: string;
  readAt?: number;
  retryAt: number;
  failed?: boolean;
  pending?: Promise<Result>;
}
interface Budget { until: number; failures: number }
interface State { entries: Map<string, Entry>; budgets: Map<string, Budget> }
// Route chunks and development module reloads share one process-local budget.
const shared = globalThis as typeof globalThis & { __o8WorkspaceGitHubReadsV1?: State };
const state = shared.__o8WorkspaceGitHubReadsV1 ??= { entries: new Map(), budgets: new Map() };

type Runner = (args: string[], env: NodeJS.ProcessEnv) => Promise<string>;

/** Resolve locally once per snapshot and pin the exact credential used by every remote read. */
export function createWorkspaceGitHubReader(cwd: string, run: Runner) {
  let access: Promise<{ scope: string; env: NodeJS.ProcessEnv }> | undefined;
  return async (args: string[]): Promise<Result> => {
    access ??= (async () => {
      const env = childEnvironment();
      const host = env.GH_HOST || 'github.com';
      // This CLI command reads environment/config/keychain only; it makes no API request.
      const token = (await run(['auth', 'token', '--hostname', host], env)).trim();
      if (!token) throw new Error('GitHub credential unavailable');
      const scope = createHash('sha256').update(JSON.stringify([host, token, env.PATH, env.GH_CONFIG_DIR])).digest('hex');
      return { scope, env: { ...env, GH_TOKEN: token, GH_ENTERPRISE_TOKEN: token,
        GITHUB_TOKEN: undefined, GITHUB_ENTERPRISE_TOKEN: undefined } };
    })();
    try {
      const { scope, env } = await access;
      return await readWorkspaceGitHub(cwd, args, scope, () => run(args, env));
    } catch {
      return { raw: '', warning: 'GitHub review details are unavailable. Check the GitHub CLI connection, then refresh.' };
    }
  };
}

function validAnswer(args: string[], raw: string): boolean {
  const data: unknown = JSON.parse(raw);
  const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  const issue = (value: unknown) => record(value) && Number.isInteger(value.number) && Number(value.number) > 0
    && ['title', 'url', 'state'].every((name) => typeof value[name] === 'string');
  if (args[0] === 'issue') return issue(data);
  const optional = (value: unknown, type: string) => value === undefined || value === null || typeof value === type;
  if (args[0] === 'pr') return Array.isArray(data) && data.every((item) => record(item) && issue(item)
    && ['body', 'reviewDecision', 'headRefName', 'baseRefName'].every((name) => optional(item[name], 'string'))
    && optional(item.isDraft, 'boolean'));
  if (args[0] === 'api') return Array.isArray(data) && data.every((file) => record(file) && typeof file.filename === 'string'
    && ['status', 'previous_filename'].every((name) => optional(file[name], 'string'))
    && ['additions', 'deletions'].every((name) => file[name] == null || typeof file[name] === 'number' && Number.isFinite(file[name])));
  return false;
}

function paused(entry: Entry | undefined, until: number): Result {
  const retained = entry?.raw !== undefined;
  return {
    raw: entry?.raw ?? '',
    warning: `GitHub review refresh paused until ${new Date(until).toISOString()}. ${retained
      ? `Showing cached details (last read ${new Date(entry!.readAt!).toISOString()}).`
      : 'Remote details are unavailable.'}`,
  };
}

function addEntry(key: string, entry: Entry): boolean {
  if (state.entries.size >= MAX_ENTRIES) {
    const idle = [...state.entries].find(([, value]) => !value.pending);
    if (!idle) return false;
    state.entries.delete(idle[0]);
  }
  state.entries.set(key, entry);
  return true;
}

/** Background review reads always honor their remote TTL, including fresh local snapshots. */
async function readWorkspaceGitHub(
  cwd: string,
  args: string[],
  scope: string,
  run: () => Promise<string>,
): Promise<Result> {
  const key = JSON.stringify([scope, path.resolve(cwd), args]);
  let entry = state.entries.get(key);
  const now = Date.now();
  const budget = state.budgets.get(scope);
  if (entry?.pending) return entry.pending;
  if ((budget?.until ?? 0) > now) return paused(entry, budget!.until);
  if (entry && entry.retryAt > now) return entry.failed ? paused(entry, entry.retryAt) : { raw: entry.raw! };
  if (!entry) {
    entry = { retryAt: 0 };
    if (!addEntry(key, entry)) return paused(undefined, now + ERROR_TTL_MS);
  }
  const current = entry;
  const pending = Promise.resolve().then(run).then((raw) => {
    // A malformed answer is a failed read, never a successful empty list.
    if (!validAnswer(args, raw)) throw new Error('GitHub review answer is invalid');
    current.raw = raw;
    current.readAt = Date.now();
    current.retryAt = current.readAt + READ_TTL_MS;
    current.failed = false;
    if ((state.budgets.get(scope)?.until ?? 0) <= Date.now()) state.budgets.delete(scope);
    return { raw };
  }).catch((error: unknown) => {
    const stderr = (error as { stderr?: unknown })?.stderr;
    const limited = /(?:rate.?limit|abuse detection)/i.test(`${String(error)} ${String(stderr ?? '')}`);
    const failedAt = Date.now();
    let retryAt = failedAt + ERROR_TTL_MS;
    if (limited) {
      const previous = state.budgets.get(scope);
      const failures = (previous?.failures ?? 0) + (previous && previous.until > failedAt ? 0 : 1);
      retryAt = Math.max(previous?.until ?? 0, failedAt + Math.min(15 * ERROR_TTL_MS, ERROR_TTL_MS * 2 ** (failures - 1)));
      if (!previous && state.budgets.size >= MAX_ENTRIES) state.budgets.delete(state.budgets.keys().next().value!);
      state.budgets.set(scope, { until: retryAt, failures });
    }
    current.failed = true;
    current.retryAt = retryAt;
    return paused(current, retryAt);
  }).finally(() => { current.pending = undefined; });
  current.pending = pending;
  return pending;
}
