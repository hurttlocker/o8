import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname } from 'node:path';
import path from 'node:path';
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

// #1741 (part of #1673): Windows has no PATH-lookup symlink model (no
// shebang, no execute bit) and file symlinks need elevation/Developer Mode —
// same risk the Windows port audit already flagged for node_modules
// symlinks. So the single Windows candidate is a directory we own and copy
// a `.cmd`/`.ps1` wrapper into, not a symlink target. `<home>/.o8/bin`
// matches the `.o8` data-dir convention the rest of the app already uses
// (see `resolveCliDataDir` in config.ts and `well_known_cli_bin_dirs` in the
// Rust CLI locator).
export function cliCandidates(platform: NodeJS.Platform = process.platform, home: string = homedir()): string[] {
  if (platform === 'win32') {
    // path.win32 (not the bare `join`) so this stays correct when tested on
    // a POSIX host with an injected 'win32' platform, not just at runtime.
    return [path.win32.join(home, '.o8', 'bin', 'o8.cmd')];
  }
  const candidates: string[] = [];
  if (platform === 'darwin' && process.arch === 'arm64') {
    candidates.push('/opt/homebrew/bin/o8');
  }
  if (platform === 'darwin' || platform === 'linux') {
    candidates.push('/usr/local/bin/o8');
  }
  candidates.push(`${home}/.local/bin/o8`);
  return [...new Set(candidates)];
}

export function directoryOnPath(target: string, pathEnv: string = process.env.PATH ?? '', platform: NodeJS.Platform = process.platform): boolean {
  if (platform === 'win32') {
    const dir = path.win32.dirname(target).replace(/\\+$/, '').toLowerCase();
    return pathEnv
      .split(path.win32.delimiter)
      .some((entry) => entry.replace(/\\+$/, '').toLowerCase() === dir);
  }
  const dir = dirname(target);
  return pathEnv.split(delimiter).includes(dir);
}

// Content for the Windows `.cmd` shim, templated with the resolved path to the
// currently-running o8.mjs bundle (mirrors the one baked at build time in
// scripts/tauri-export.mjs, but re-derived here so `doctor --repair` can
// re-point it at a moved/updated install).
//
// No `.ps1` counterpart on purpose: PowerShell resolves a bare `o8` to a
// sibling .ps1 ahead of the .cmd, and an unsigned .ps1 is refused under the
// default execution policy, so shipping one breaks `o8` in PowerShell on a
// stock Windows install. Without it, PATHEXT falls through to this .cmd, which
// runs in both shells.
export function windowsShimContents(source: string): { cmd: string } {
  return {
    cmd: `@echo off\r\nsetlocal\r\nset "NODE_BIN=%O8_NODE_BIN%"\r\nif not defined NODE_BIN set "NODE_BIN=node"\r\n"%NODE_BIN%" "${source}" %*\r\n`,
  };
}

function findNode(): { ok: boolean; path: string | null } {
  if (process.env.O8_NODE_BIN && existsSync(process.env.O8_NODE_BIN)) {
    return { ok: true, path: process.env.O8_NODE_BIN };
  }
  try {
    // `where` is a real Windows executable (System32\where.exe), not a shell
    // builtin, so it runs the same way `sh -lc` does below: no shell needed.
    const out = process.platform === 'win32'
      ? execFileSync('where', ['node'], { windowsHide: true, encoding: 'utf8' }).trim().split(/\r?\n/)[0]
      : execFileSync('sh', ['-lc', 'command -v node'], { windowsHide: true, encoding: 'utf8' }).trim();
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

      // Windows: no shebang/execute-bit/symlink-without-elevation model, so
      // write the `.cmd` wrapper directly instead of the POSIX symlink dance
      // below (#1741). Repair also clears any `.ps1` a previous version wrote,
      // since that file shadows the .cmd in PowerShell and cannot execute
      // under the default execution policy.
      if (process.platform === 'win32') {
        const { cmd } = windowsShimContents(source);
        const stalePs1 = target.replace(/\.cmd$/, '.ps1');
        const alreadyCurrent = existsSync(target) && readFileSync(target, 'utf8') === cmd;
        writeFileSync(target, cmd);
        try { rmSync(stalePs1, { force: true }); } catch { /* best-effort cleanup */ }
        candidate.status = alreadyCurrent ? 'already-linked' : 'linked';
        candidate.detail = alreadyCurrent ? `already points to ${source}` : `wrote shim pointing to ${source}`;
        installedAt = target;
        candidates.push(candidate);
        break;
      }

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
