/**
 * Shared GitHub utilities — all `gh` CLI calls go through here
 * so they pick up the PAT from ~/.cortex-ide/.env.local
 */
import { execSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

let _cachedToken: string | null = null;
let _tokenCheckedAt = 0;

/** Get GitHub token from config or environment */
export function getGitHubToken(): string | undefined {
  // Cache for 30s
  if (_cachedToken !== null && Date.now() - _tokenCheckedAt < 30_000) {
    return _cachedToken || undefined;
  }

  // Check env first
  if (process.env.GH_TOKEN) {
    _cachedToken = process.env.GH_TOKEN;
    _tokenCheckedAt = Date.now();
    return _cachedToken;
  }
  if (process.env.GITHUB_TOKEN) {
    _cachedToken = process.env.GITHUB_TOKEN;
    _tokenCheckedAt = Date.now();
    return _cachedToken;
  }

  // Check ~/.cortex-ide/.env.local
  const envFile = join(homedir(), '.cortex-ide', '.env.local');
  if (existsSync(envFile)) {
    const content = readFileSync(envFile, 'utf-8');
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

  // Check project .env.local
  const localEnv = join(process.cwd(), '.env.local');
  if (existsSync(localEnv)) {
    const content = readFileSync(localEnv, 'utf-8');
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

/** Execute a gh CLI command with the PAT injected */
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
