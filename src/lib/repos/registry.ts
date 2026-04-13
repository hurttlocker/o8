import 'server-only';

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type {
  RepoRegistryEntry,
  RepoRegistryStore,
  RepoSetupConfig,
  ValidatedRepoCandidate,
} from './types';

const execFileAsync = promisify(execFile);

const REGISTRY_DIR = path.join(os.homedir(), '.o8');
const REGISTRY_PATH = path.join(REGISTRY_DIR, 'repos.json');

function nowIso() {
  return new Date().toISOString();
}

async function pathExists(target: string) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function ensureRegistryDir() {
  await mkdir(REGISTRY_DIR, { recursive: true });
}

async function readJsonFile<T>(filePath: string) {
  const raw = await readFile(filePath, 'utf8');
  return JSON.parse(raw) as T;
}

async function writeJsonFile(filePath: string, value: unknown) {
  await ensureRegistryDir();
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function gitValue(repoRoot: string, args: string[]) {
  try {
    const { stdout } = await execFileAsync('git', ['-C', repoRoot, ...args], {
      maxBuffer: 512 * 1024,
      timeout: 10_000,
    });
    const value = stdout.trim();
    return value || null;
  } catch {
    return null;
  }
}

async function gitCommandSucceeds(repoRoot: string, args: string[]) {
  try {
    await execFileAsync('git', ['-C', repoRoot, ...args], {
      maxBuffer: 256 * 1024,
      timeout: 10_000,
    });
    return true;
  } catch {
    return false;
  }
}

function normalizeBranchRef(value: string | null) {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('refs/remotes/origin/')) {
    return trimmed.slice('refs/remotes/origin/'.length);
  }
  if (trimmed.startsWith('origin/')) {
    return trimmed.slice('origin/'.length);
  }
  return trimmed.split('/').pop() ?? trimmed;
}

async function resolveDefaultBranch(repoRoot: string) {
  const remoteHead = normalizeBranchRef(
    await gitValue(repoRoot, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']),
  );
  if (remoteHead) return remoteHead;

  if (await gitCommandSucceeds(repoRoot, ['show-ref', '--verify', '--quiet', 'refs/heads/main'])) {
    return 'main';
  }
  if (await gitCommandSucceeds(repoRoot, ['show-ref', '--verify', '--quiet', 'refs/heads/master'])) {
    return 'master';
  }

  const current = await gitValue(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (current && current !== 'HEAD') return current;

  return 'main';
}

type PackageJsonShape = {
  packageManager?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

async function detectPackageManager(repoRoot: string, packageJson?: PackageJsonShape) {
  const packageManagerField = packageJson?.packageManager ?? '';
  if (packageManagerField.startsWith('pnpm@')) return 'pnpm';
  if (packageManagerField.startsWith('yarn@')) return 'yarn';
  if (packageManagerField.startsWith('bun@')) return 'bun';
  if (packageManagerField.startsWith('npm@')) return 'npm';

  if (await pathExists(path.join(repoRoot, 'pnpm-lock.yaml'))) return 'pnpm';
  if (await pathExists(path.join(repoRoot, 'yarn.lock'))) return 'yarn';
  if (await pathExists(path.join(repoRoot, 'bun.lockb'))) return 'bun';
  if (await pathExists(path.join(repoRoot, 'bun.lock'))) return 'bun';
  return 'npm';
}

async function detectSetupConfig(repoRoot: string): Promise<RepoSetupConfig> {
  const packageJsonPath = path.join(repoRoot, 'package.json');
  let packageJson: PackageJsonShape | undefined;

  if (await pathExists(packageJsonPath)) {
    try {
      packageJson = await readJsonFile<PackageJsonShape>(packageJsonPath);
    } catch {
      packageJson = undefined;
    }
  }

  const hasPackageJson = Boolean(packageJson);
  const packageManager = await detectPackageManager(repoRoot, packageJson);
  const hasPackageLock = await pathExists(path.join(repoRoot, 'package-lock.json'));
  const hasBuildScript = Boolean(packageJson?.scripts?.build);

  let installCommand: string | null = null;
  if (hasPackageJson) {
    if (packageManager === 'pnpm') installCommand = 'pnpm install --frozen-lockfile';
    else if (packageManager === 'yarn') installCommand = 'yarn install --immutable';
    else if (packageManager === 'bun') installCommand = 'bun install';
    else installCommand = hasPackageLock ? 'npm ci --prefer-offline' : 'npm install';
  }

  let buildCommand: string | null = null;
  if (hasBuildScript) {
    if (packageManager === 'pnpm') buildCommand = 'pnpm build';
    else if (packageManager === 'yarn') buildCommand = 'yarn build';
    else if (packageManager === 'bun') buildCommand = 'bun run build';
    else buildCommand = 'npm run build';
  }

  // Auto-detect dev command
  let devCommand: string | null = null;
  let defaultPort: number | null = null;
  const hasDevScript = Boolean(packageJson?.scripts?.dev);
  const hasStartScript = Boolean(packageJson?.scripts?.start);
  if (hasDevScript) {
    if (packageManager === 'pnpm') devCommand = 'pnpm dev';
    else if (packageManager === 'yarn') devCommand = 'yarn dev';
    else if (packageManager === 'bun') devCommand = 'bun dev';
    else devCommand = 'npm run dev';
  } else if (hasStartScript) {
    if (packageManager === 'pnpm') devCommand = 'pnpm start';
    else if (packageManager === 'yarn') devCommand = 'yarn start';
    else if (packageManager === 'bun') devCommand = 'bun start';
    else devCommand = 'npm start';
  }
  // Try to detect port from scripts
  const devScript = packageJson?.scripts?.dev ?? packageJson?.scripts?.start ?? '';
  const portMatch = devScript.match(/(?:--port|PORT=|-p)\s*(\d+)/);
  if (portMatch) defaultPort = parseInt(portMatch[1], 10);
  // Common framework defaults
  if (!defaultPort && hasDevScript) {
    const deps = { ...packageJson?.dependencies, ...packageJson?.devDependencies };
    if (deps?.next) defaultPort = 3000;
    else if (deps?.vite) defaultPort = 5173;
    else if (deps?.['@angular/core']) defaultPort = 4200;
    else if (deps?.['react-scripts']) defaultPort = 3000;
    else if (deps?.nuxt) defaultPort = 3000;
    else if (deps?.svelte || deps?.['@sveltejs/kit']) defaultPort = 5173;
  }

  // Check for Go projects
  const hasGoMod = await pathExists(path.join(repoRoot, 'go.mod'));
  if (!devCommand && hasGoMod) {
    devCommand = 'go run .';
  }

  return {
    envMode: 'copy',
    envFiles: ['.env', '.env.local'],
    installCommand,
    installOnCreateWorkspace: Boolean(installCommand),
    buildCommand,
    runBuildOnCreateWorkspace: false,
    devCommand,
    defaultPort,
  };
}

async function resolveRepoRoot(inputPath: string) {
  const expanded = inputPath.trim().replace(/^~(?=\/|$)/, os.homedir());
  if (!expanded) {
    throw new Error('Repository path is required.');
  }

  const resolved = path.resolve(expanded);
  const stats = await stat(resolved).catch(() => null);
  if (!stats) {
    throw new Error('Path not found.');
  }
  if (!stats.isDirectory()) {
    throw new Error('Path must point to a local folder.');
  }

  let repoRoot: string;
  try {
    const { stdout } = await execFileAsync('git', ['-C', resolved, 'rev-parse', '--show-toplevel'], {
      maxBuffer: 256 * 1024,
      timeout: 10_000,
    });
    repoRoot = stdout.trim();
  } catch {
    throw new Error('Folder is not a Git repository.');
  }

  const realRoot = await realpath(repoRoot).catch(() => repoRoot);
  return path.resolve(realRoot);
}

async function inspectLocalRepo(localPath: string): Promise<ValidatedRepoCandidate> {
  const repoRoot = await resolveRepoRoot(localPath);
  const [remoteUrl, defaultBranch, setup] = await Promise.all([
    gitValue(repoRoot, ['remote', 'get-url', 'origin']),
    resolveDefaultBranch(repoRoot),
    detectSetupConfig(repoRoot),
  ]);

  return {
    name: path.basename(repoRoot),
    localPath: repoRoot,
    remoteUrl,
    defaultBranch,
    setup,
  };
}

function sortRepos(repos: RepoRegistryEntry[]) {
  return [...repos].sort((a, b) => {
    const aTime = new Date(a.lastOpenedAt ?? a.addedAt).getTime();
    const bTime = new Date(b.lastOpenedAt ?? b.addedAt).getTime();
    if (aTime !== bTime) return bTime - aTime;
    return a.name.localeCompare(b.name);
  });
}

async function readStore(): Promise<RepoRegistryStore> {
  if (!(await pathExists(REGISTRY_PATH))) {
    return { version: 1, repos: [] };
  }

  const parsed = await readJsonFile<Partial<RepoRegistryStore>>(REGISTRY_PATH).catch(() => null);
  if (!parsed || !Array.isArray(parsed.repos)) {
    throw new Error('Repository registry is unreadable. Check ~/.o8/repos.json.');
  }

  return {
    version: 1,
    repos: sortRepos(parsed.repos as RepoRegistryEntry[]),
  };
}

async function writeStore(store: RepoRegistryStore) {
  await writeJsonFile(REGISTRY_PATH, {
    version: 1,
    repos: sortRepos(store.repos),
  });
}

export async function listRepos() {
  const store = await readStore();
  return store.repos;
}

export async function findRepoByLocalPath(localPath: string) {
  const target = path.resolve(localPath);
  const repos = await listRepos();
  return repos.find((repo) => path.resolve(repo.localPath) === target) ?? null;
}

export async function validateRepo(localPath: string) {
  return inspectLocalRepo(localPath);
}

export async function addRepo(localPath: string) {
  const candidate = await inspectLocalRepo(localPath);
  const store = await readStore();
  const now = nowIso();
  const existing = store.repos.find((repo) => repo.localPath === candidate.localPath);

  if (existing) {
    const updated: RepoRegistryEntry = {
      ...existing,
      name: candidate.name,
      remoteUrl: candidate.remoteUrl,
      defaultBranch: candidate.defaultBranch,
      setup: existing.setup ?? candidate.setup,
      lastOpenedAt: now,
    };

    const repos = store.repos.map((repo) => (repo.id === existing.id ? updated : repo));
    await writeStore({ version: 1, repos });
    return updated;
  }

  const entry: RepoRegistryEntry = {
    id: randomUUID(),
    name: candidate.name,
    localPath: candidate.localPath,
    remoteUrl: candidate.remoteUrl,
    defaultBranch: candidate.defaultBranch,
    addedAt: now,
    lastOpenedAt: now,
    setup: candidate.setup,
  };

  await writeStore({
    version: 1,
    repos: [...store.repos, entry],
  });

  return entry;
}

export async function updateRepo(
  id: string,
  updates: {
    setup?: RepoSetupConfig;
    lastOpenedAt?: string | null;
  },
) {
  const store = await readStore();
  const existing = store.repos.find((repo) => repo.id === id);
  if (!existing) {
    throw new Error('Repository not found.');
  }

  const next: RepoRegistryEntry = {
    ...existing,
    setup: updates.setup ?? existing.setup,
    lastOpenedAt: updates.lastOpenedAt === undefined ? existing.lastOpenedAt : updates.lastOpenedAt,
  };

  const repos = store.repos.map((repo) => (repo.id === id ? next : repo));
  await writeStore({ version: 1, repos });
  return next;
}

export async function touchRepo(id: string, timestamp = nowIso()) {
  return updateRepo(id, { lastOpenedAt: timestamp });
}

export async function removeRepo(id: string) {
  const store = await readStore();
  const existing = store.repos.find((repo) => repo.id === id);
  if (!existing) {
    throw new Error('Repository not found.');
  }

  await writeStore({
    version: 1,
    repos: store.repos.filter((repo) => repo.id !== id),
  });
}

export function getRepoRegistryPath() {
  return REGISTRY_PATH;
}
