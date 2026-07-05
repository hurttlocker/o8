import { existsSync, lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname } from 'node:path';
import { execFileSync } from 'node:child_process';

export interface CliInstallCandidate {
  path: string;
  directoryOnPath: boolean;
  status: 'linked' | 'already-linked' | 'blocked' | 'failed' | 'skipped';
  detail: string;
}

export interface CliInstallResult {
  source: string;
  installedAt: string | null;
  onPath: boolean;
  nodeResolvable: boolean;
  nodeBin: string | null;
  candidates: CliInstallCandidate[];
}

function cliCandidates(): string[] {
  const home = homedir();
  const candidates: string[] = [];
  if (process.platform === 'darwin' && process.arch === 'arm64') {
    candidates.push('/opt/homebrew/bin/o8');
  }
  if (process.platform === 'darwin' || process.platform === 'linux') {
    candidates.push('/usr/local/bin/o8');
  }
  candidates.push(`${home}/.local/bin/o8`);
  return [...new Set(candidates)];
}

function directoryOnPath(target: string): boolean {
  const dir = dirname(target);
  return (process.env.PATH ?? '').split(':').includes(dir);
}

function findNode(): { ok: boolean; path: string | null } {
  if (process.env.O8_NODE_BIN && existsSync(process.env.O8_NODE_BIN)) {
    return { ok: true, path: process.env.O8_NODE_BIN };
  }
  try {
    const out = execFileSync('sh', ['-lc', 'command -v node'], { encoding: 'utf8' }).trim();
    return out ? { ok: true, path: out } : { ok: false, path: null };
  } catch {
    return { ok: false, path: null };
  }
}

export function repairCliInstall(source: string): CliInstallResult {
  const candidates: CliInstallCandidate[] = [];
  let installedAt: string | null = null;

  for (const target of cliCandidates()) {
    const candidate: CliInstallCandidate = {
      path: target,
      directoryOnPath: directoryOnPath(target),
      status: 'skipped',
      detail: '',
    };

    try {
      mkdirSync(dirname(target), { recursive: true });
      if (existsSync(target)) {
        const meta = lstatSync(target);
        if (meta.isSymbolicLink()) {
          const existing = readlinkSync(target);
          if (existing === source) {
            candidate.status = 'already-linked';
            candidate.detail = `already points to ${source}`;
            installedAt = target;
            candidates.push(candidate);
            break;
          }
          if (
            existing.includes('/Applications/o8.app/')
            || existing.includes('/server/bin/o8')
            || existing.includes('/server/bin/o8.mjs')
          ) {
            rmSync(target);
          } else {
            candidate.status = 'blocked';
            candidate.detail = `existing symlink points to ${existing}`;
            candidates.push(candidate);
            continue;
          }
        } else {
          candidate.status = 'blocked';
          candidate.detail = 'existing path is not a symlink';
          candidates.push(candidate);
          continue;
        }
      }

      symlinkSync(source, target);
      candidate.status = 'linked';
      candidate.detail = `linked to ${source}`;
      installedAt = target;
      candidates.push(candidate);
      break;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      candidate.status = 'failed';
      candidate.detail = target.startsWith('/usr/local/bin/')
        ? `${message}; retry with: sudo ln -sf "${source}" "${target}"`
        : message;
      candidates.push(candidate);
    }
  }

  const node = findNode();
  return {
    source,
    installedAt,
    onPath: installedAt ? directoryOnPath(installedAt) : false,
    nodeResolvable: node.ok,
    nodeBin: node.path,
    candidates,
  };
}
