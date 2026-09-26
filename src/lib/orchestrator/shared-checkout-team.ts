import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';

import { getDataDir } from '@/lib/data-dir-migration';

export interface SharedCheckoutMember {
  surfaceId: string | null;
  runtime: string;
  taskName: string;
  clientMutationId: string;
  launchedAt: string;
  paths: string[];
  state: 'reserved' | 'running' | 'failed';
}

export interface SharedCheckoutTeam {
  id: string;
  path: string;
  branch: string;
  baseHead: string;
  parentThreadId: string;
  createdAt: string;
  initialChangedPaths: string[];
  initialChangedFingerprints: Record<string, string>;
  members: SharedCheckoutMember[];
}

interface TeamInput {
  repoPath: string;
  parentThreadId: string;
  dataDir?: string;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 5_000, windowsHide: true }).trim();
}

function changedPaths(path: string): string[] {
  const tracked = git(path, 'diff', '--name-only', '-z', 'HEAD').split('\0').filter(Boolean);
  const untracked = git(path, 'ls-files', '--others', '--exclude-standard', '-z').split('\0').filter(Boolean);
  return [...new Set([...tracked, ...untracked])].sort();
}

function changedFingerprint(root: string, relativePath: string): string {
  const file = join(root, relativePath);
  const digest = createHash('sha256');
  digest.update(git(root, 'status', '--porcelain', '-z', '--', relativePath));
  digest.update(git(root, 'diff', '--binary', 'HEAD', '--', relativePath));
  if (!existsSync(file)) return digest.update('missing').digest('hex');
  const info = lstatSync(file);
  digest.update(String(info.mode));
  if (info.isSymbolicLink()) digest.update(readlinkSync(file));
  else if (info.isFile()) digest.update(readFileSync(file));
  else digest.update(info.isDirectory() ? 'directory' : 'special');
  return digest.digest('hex');
}

function changedFingerprints(root: string, paths: string[]): Record<string, string> {
  return Object.fromEntries(paths.map((path) => [path, changedFingerprint(root, path)]));
}

function committedPaths(path: string, baseHead: string): string[] {
  return git(path, 'diff', '--name-only', '-z', baseHead, 'HEAD').split('\0').filter(Boolean).sort();
}

function teamLocation(input: TeamInput): { id: string; file: string; lock: string; path: string } {
  const path = realpathSync(input.repoPath);
  const id = createHash('sha256').update(path).digest('hex').slice(0, 24);
  const directory = join(input.dataDir ?? getDataDir(), 'shared-checkout-teams');
  return { id, path, file: join(directory, `${id}.json`), lock: join(directory, `${id}.lock`) };
}

function currentCheckout(path: string): { branch: string; head: string } {
  if (realpathSync(git(path, 'rev-parse', '--show-toplevel')) !== path) {
    throw new Error('Fast mode requires the exact checkout root.');
  }
  let branch: string;
  try {
    branch = git(path, 'symbolic-ref', '--quiet', '--short', 'HEAD');
  } catch {
    throw new Error('Shared checkout branch changed or is detached; refusing launch.');
  }
  return { branch, head: git(path, 'rev-parse', 'HEAD') };
}

function readFile(file: string): SharedCheckoutTeam | null {
  if (!existsSync(file)) return null;
  const value = JSON.parse(readFileSync(file, 'utf8')) as SharedCheckoutTeam;
  if (!value || !Array.isArray(value.members) || typeof value.parentThreadId !== 'string') {
    throw new Error('Shared checkout ownership receipt is invalid.');
  }
  return value;
}

async function withLock<T>(lock: string, operation: () => Promise<T>): Promise<T> {
  await mkdir(join(lock, '..'), { recursive: true });
  const started = Date.now();
  for (;;) {
    try {
      await mkdir(lock);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const age = Date.now() - (await stat(lock)).mtimeMs;
      if (age > 30_000) throw new Error('Shared checkout lock is stale; inspect the owner before retrying.');
      if (Date.now() - started > 10_000) throw new Error('Shared checkout is busy; retry after its current operation.');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  try {
    return await operation();
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

function assertOwner(team: SharedCheckoutTeam, input: TeamInput, path: string, branch: string): void {
  if (team.path !== path) throw new Error('Shared checkout path changed; refusing launch.');
  if (team.parentThreadId !== input.parentThreadId) {
    throw new Error('This checkout is owned by another orchestrator. Open a separate worktree or return to its owner.');
  }
  if (team.branch !== branch) throw new Error('Shared checkout branch changed; refusing launch.');
}

function writeTeam(file: string, team: SharedCheckoutTeam): void {
  mkdirSync(join(file, '..'), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(team, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, file);
}

export function readSharedCheckoutTeam(input: TeamInput): SharedCheckoutTeam | null {
  return readFile(teamLocation(input).file);
}

/** Read-only workspace restoration. No branch check: a drifted team still needs to be visible. */
export function readActiveSharedCheckoutTeam(repoPath: string): SharedCheckoutTeam | null {
  return readFile(teamLocation({ repoPath, parentThreadId: '' }).file);
}

export function inspectSharedCheckoutTeam(input: TeamInput) {
  const team = readSharedCheckoutTeam(input);
  if (!team) return null;
  const checkout = currentCheckout(team.path);
  assertOwner(team, input, team.path, checkout.branch);
  const current = changedPaths(team.path);
  const baseline = new Set(team.initialChangedPaths);
  const baselineDrift = team.initialChangedPaths.filter((path) =>
    team.initialChangedFingerprints?.[path] !== changedFingerprint(team.path, path));
  const newPaths = current.filter((path) => !baseline.has(path));
  const committed = committedPaths(team.path, team.baseHead);
  const claimed = team.members.filter((member) => member.state !== 'failed' || member.surfaceId).flatMap((member) => member.paths);
  const outsideClaims = [...new Set([...newPaths, ...committed])]
    .filter((path) => !claimed.some((scope) => pathsOverlap(path, scope))).sort();
  return {
    team,
    currentHead: checkout.head,
    changedPaths: current,
    initialChangedPaths: team.initialChangedPaths,
    baselineDrift,
    newPaths,
    committedPaths: committed,
    outsideClaims,
    scopeClean: outsideClaims.length === 0 && baselineDrift.length === 0,
    baselineClean: team.initialChangedPaths.length === 0,
  };
}

export function findSharedCheckoutMemberByMutation(input: TeamInput, clientMutationId: string): SharedCheckoutMember | null {
  return readSharedCheckoutTeam(input)?.members.find((member) => member.clientMutationId === clientMutationId) ?? null;
}

function normalizeClaim(path: string): string {
  const normalized = path.trim().replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (!normalized || normalized.startsWith('/') || normalized.includes('\0') || normalized.includes(':')
    || normalized.split('/').some((part) => !part || part === '..' || part === '.' || part === '.git')) {
    throw new Error(`Invalid shared worker path claim: ${path}`);
  }
  return normalized;
}

function assertScopeInsideCheckout(root: string, scope: string): void {
  let candidate = join(root, scope);
  while (!existsSync(candidate) && candidate !== root) candidate = dirname(candidate);
  const resolved = realpathSync(candidate);
  if (resolved !== root && !resolved.startsWith(`${root}${sep}`)) {
    throw new Error(`Shared worker scope escapes the checkout through a symlink: ${scope}`);
  }
}

function pathsOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

export function validateSharedCheckoutPaths(paths: string[]): string[] {
  const normalized = [...new Set(paths.map(normalizeClaim))];
  if (normalized.length === 0) throw new Error('Fast workers need explicit, non-overlapping file or directory scopes.');
  return normalized;
}

export async function reserveSharedCheckoutMember(input: TeamInput & {
  clientMutationId: string;
  runtime: string;
  taskName: string;
  paths: string[];
}): Promise<SharedCheckoutTeam> {
  const location = teamLocation(input);
  return withLock(location.lock, async () => {
    const paths = validateSharedCheckoutPaths(input.paths);
    if (!/^thoughts-[A-Za-z0-9_-]{1,80}$/.test(input.parentThreadId)) {
      throw new Error('Fast mode requires a durable orchestrator chat.');
    }
    const checkout = currentCheckout(location.path);
    const existingTeam = readFile(location.file);
    if (existingTeam) assertOwner(existingTeam, input, location.path, checkout.branch);
    const initialChangedPaths = existingTeam ? [] : changedPaths(location.path);
    const team = existingTeam ?? {
      id: location.id,
      path: location.path,
      branch: checkout.branch,
      baseHead: checkout.head,
      parentThreadId: input.parentThreadId,
      createdAt: new Date().toISOString(),
      initialChangedPaths,
      initialChangedFingerprints: changedFingerprints(location.path, initialChangedPaths),
      members: [],
    };
    for (const path of paths) assertScopeInsideCheckout(team.path, path);
    const existing = team.members.find((member) => member.clientMutationId === input.clientMutationId);
    if (existing) {
      if (existing.runtime !== input.runtime || existing.taskName !== input.taskName
        || JSON.stringify(existing.paths) !== JSON.stringify(paths)) {
        throw new Error('Shared worker mutation was reused with different scope or runtime.');
      }
      return team;
    }
    if (paths.some((path) => team.initialChangedPaths.some((changed) => pathsOverlap(path, changed)))) {
      throw new Error('Fast worker scope overlaps files that were dirty before the team started. Assign a clean scope.');
    }
    // A failed launch with a created surface may still be running after an
    // unknown post-effect. Hold its scope until the entire team is reviewed.
    for (const member of team.members.filter((candidate) => candidate.state !== 'failed' || candidate.surfaceId)) {
      if (paths.some((path) => member.paths.some((claimed) => pathsOverlap(path, claimed)))) {
        throw new Error(`Shared checkout path overlaps worker ${member.taskName}; assign separate paths or wait for group review.`);
      }
    }
    team.members.push({
      surfaceId: null,
      runtime: input.runtime,
      taskName: input.taskName,
      clientMutationId: input.clientMutationId,
      launchedAt: new Date().toISOString(),
      paths,
      state: 'reserved',
    });
    writeTeam(location.file, team);
    return team;
  });
}

export async function failSharedCheckoutMember(input: TeamInput & { clientMutationId: string }): Promise<void> {
  const location = teamLocation(input);
  await withLock(location.lock, async () => {
    const team = readFile(location.file);
    const member = team?.members.find((candidate) => candidate.clientMutationId === input.clientMutationId);
    if (!team || !member) return;
    member.state = 'failed';
    writeTeam(location.file, team);
  });
}

export async function ensureSharedCheckoutTeam(input: TeamInput): Promise<SharedCheckoutTeam> {
  if (!/^thoughts-[A-Za-z0-9_-]{1,80}$/.test(input.parentThreadId)) {
    throw new Error('Fast mode requires a durable orchestrator chat.');
  }
  const location = teamLocation(input);
  return withLock(location.lock, async () => {
    const checkout = currentCheckout(location.path);
    const existing = readFile(location.file);
    if (existing) {
      assertOwner(existing, input, location.path, checkout.branch);
      return existing;
    }
    const team: SharedCheckoutTeam = {
      id: location.id,
      path: location.path,
      branch: checkout.branch,
      baseHead: checkout.head,
      parentThreadId: input.parentThreadId,
      createdAt: new Date().toISOString(),
      initialChangedPaths: changedPaths(location.path),
      initialChangedFingerprints: changedFingerprints(location.path, changedPaths(location.path)),
      members: [],
    };
    writeTeam(location.file, team);
    return team;
  });
}

export async function recordSharedCheckoutMember(input: TeamInput & {
  surfaceId: string;
  runtime: string;
  taskName: string;
  clientMutationId: string;
}): Promise<SharedCheckoutTeam> {
  const location = teamLocation(input);
  return withLock(location.lock, async () => {
    const team = readFile(location.file);
    if (!team) throw new Error('Shared checkout team was not created.');
    assertOwner(team, input, location.path, currentCheckout(location.path).branch);
    const existing = team.members.find((member) => member.clientMutationId === input.clientMutationId);
    if (!existing) throw new Error('Shared worker has no path reservation.');
    if (existing.surfaceId && existing.surfaceId !== input.surfaceId) throw new Error('Shared worker mutation was reused for another surface.');
    existing.surfaceId = input.surfaceId;
    existing.state = 'running';
    writeTeam(location.file, team);
    return team;
  });
}

/** Release checkout ownership only after every owned worker has settled and
 * the orchestrator has committed/reviewed the team's scoped work. */
export async function finishSharedCheckoutTeam(input: TeamInput & {
  reviewSummary: string;
  verification: string;
}): Promise<{ team: SharedCheckoutTeam; reviewedHead: string; committedPaths: string[] }> {
  if (!input.reviewSummary.trim() || !input.verification.trim()) {
    throw new Error('Finishing a Fast team requires a review summary and verification receipt.');
  }
  const location = teamLocation(input);
  return withLock(location.lock, async () => {
    const team = readFile(location.file);
    if (!team) throw new Error('There is no active Fast team in this checkout.');
    const checkout = currentCheckout(location.path);
    assertOwner(team, input, location.path, checkout.branch);
    const { findOwnedLaunchByMutationId, lookupOwnedActiveRunFresh } = await import('@/lib/runtimes/shared/owned-session-index');
    for (const member of team.members) {
      if (member.state === 'failed' && !member.surfaceId) continue;
      if (!member.surfaceId) throw new Error(`Worker ${member.taskName} has no settled launch receipt.`);
      const launch = await findOwnedLaunchByMutationId(member.clientMutationId);
      if (!launch || launch.surfaceId !== member.surfaceId || launch.cwd !== team.path) {
        throw new Error(`Worker ${member.taskName} has no matching owned runtime completion receipt.`);
      }
      const active = await lookupOwnedActiveRunFresh(member.surfaceId);
      if (launch.outcome === 'running' || active?.pid !== undefined || active?.tmuxSession !== undefined) {
        throw new Error(`Worker ${member.taskName} is still active. Wait for it to finish or interrupt it first.`);
      }
    }
    const status = inspectSharedCheckoutTeam(input);
    if (!status) throw new Error('Shared team review state disappeared.');
    if (status.outsideClaims.length > 0) {
      throw new Error(`Changes outside worker scopes need review: ${status.outsideClaims.join(', ')}`);
    }
    if (status.baselineDrift.length > 0) {
      throw new Error(`Pre-existing operator edits changed during this team: ${status.baselineDrift.join(', ')}`);
    }
    if (status.newPaths.length > 0) {
      throw new Error(`Team edits are still uncommitted: ${status.newPaths.join(', ')}`);
    }
    const archive = join(location.file, '..', 'archive');
    mkdirSync(archive, { recursive: true });
    writeFileSync(join(archive, `${team.id}-${Date.now()}.json`), `${JSON.stringify({
      ...team,
      finishedAt: new Date().toISOString(),
      reviewedHead: status.currentHead,
      committedPaths: status.committedPaths,
      reviewSummary: input.reviewSummary.trim(),
      verification: input.verification.trim(),
    }, null, 2)}\n`, { mode: 0o600 });
    await rm(location.file);
    return { team, reviewedHead: status.currentHead, committedPaths: status.committedPaths };
  });
}
