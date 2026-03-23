/**
 * Shared GitHub utilities — all `gh` CLI calls go through here.
 * Priority: GitHub App token > PAT (GH_TOKEN) > gh auth
 */
import { execSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { getInstallationToken, isGitHubAppConfigured } from './github-app';

let _cachedToken: string | null = null;
let _tokenCheckedAt = 0;

/** Get GitHub token — prefers App installation token, falls back to PAT */
export async function getGitHubTokenAsync(): Promise<string | undefined> {
  // Try GitHub App first (15k req/hr)
  if (isGitHubAppConfigured()) {
    const appToken = await getInstallationToken();
    if (appToken) return appToken;
  }
  return getGitHubToken();
}

/** Synchronous PAT lookup (for backward compat) */
export function getGitHubToken(): string | undefined {
  if (_cachedToken !== null && Date.now() - _tokenCheckedAt < 30_000) {
    return _cachedToken || undefined;
  }

  for (const envKey of ['GH_TOKEN', 'GITHUB_TOKEN']) {
    if (process.env[envKey]) {
      _cachedToken = process.env[envKey]!;
      _tokenCheckedAt = Date.now();
      return _cachedToken;
    }
  }

  // Check config files
  for (const path of [
    join(homedir(), '.cortex-ide', '.env.local'),
    join(process.cwd(), '.env.local'),
  ]) {
    if (!existsSync(path)) continue;
    const content = readFileSync(path, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('GH_TOKEN=')) {
        let val = trimmed.slice('GH_TOKEN='.length).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        _cachedToken = val;
        _tokenCheckedAt = Date.now();
        return _cachedToken;
      }
    }
  }

  _cachedToken = '';
  _tokenCheckedAt = Date.now();
  return undefined;
}

/** Execute a gh CLI command with token injected (sync — uses PAT or cached app token) */
export function ghExec(command: string, options?: { cwd?: string; timeout?: number }): string {
  const token = getGitHubToken();
  const env = { ...process.env };
  if (token) {
    env.GH_TOKEN = token;
  }

  return execSync(command, {
    encoding: 'utf-8',
    timeout: options?.timeout ?? 15_000,
    cwd: options?.cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

/** Async version — prefers GitHub App installation token */
export async function ghExecAsync(command: string, options?: { cwd?: string; timeout?: number }): Promise<string> {
  const token = await getGitHubTokenAsync();
  const env = { ...process.env };
  if (token) {
    env.GH_TOKEN = token;
  }

  return execSync(command, {
    encoding: 'utf-8',
    timeout: options?.timeout ?? 15_000,
    cwd: options?.cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

/** Detect repo from git remote */
export function detectRepo(cwd?: string): string {
  try {
    const url = execSync('git remote get-url origin 2>/dev/null', {
      encoding: 'utf-8',
      cwd,
      timeout: 5000,
    }).trim();
    // https://github.com/owner/repo.git or git@github.com:owner/repo.git
    const match = url.match(/github\.com[:/]([^/]+\/[^/.]+)/);
    return match ? match[1] : '';
  } catch {
    return '';
  }
}
