import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname } from 'node:path';

export interface CliAccessStatus {
  installedAt: string | null;
  installStatus: string | null;
  onPath: boolean;
  nodeResolvable: boolean;
  nodeBin: string | null;
  candidates: Array<{
    path: string;
    exists: boolean;
    isSymlink: boolean;
    target: string | null;
    directoryOnPath: boolean;
  }>;
}

export function cliInstallCandidates(): string[] {
  const candidates: string[] = [];
  if (process.platform === 'darwin' && process.arch === 'arm64') {
    candidates.push('/opt/homebrew/bin/o8');
  }
  if (process.platform === 'darwin' || process.platform === 'linux') {
    candidates.push('/usr/local/bin/o8');
  }
  candidates.push(`${homedir()}/.local/bin/o8`);
  return [...new Set(candidates)];
}

function directoryOnPath(path: string): boolean {
  return (process.env.PATH ?? '').split(':').includes(dirname(path));
}

function resolveNode(): { path: string | null; ok: boolean } {
  if (process.env.O8_NODE_BIN && existsSync(process.env.O8_NODE_BIN)) {
    return { path: process.env.O8_NODE_BIN, ok: true };
  }
  try {
    const out = execFileSync('sh', ['-lc', 'command -v node'], { windowsHide: true, encoding: 'utf8' }).trim();
    return out ? { path: out, ok: true } : { path: null, ok: false };
  } catch {
    return { path: null, ok: false };
  }
}

export function getCliAccessStatus(): CliAccessStatus {
  const candidates = cliInstallCandidates().map((path) => {
    try {
      const stat = lstatSync(path);
      const isSymlink = stat.isSymbolicLink();
      return {
        path,
        exists: true,
        isSymlink,
        target: isSymlink ? readlinkSync(path) : null,
        directoryOnPath: directoryOnPath(path),
      };
    } catch {
      return {
        path,
        exists: false,
        isSymlink: false,
        target: null,
        directoryOnPath: directoryOnPath(path),
      };
    }
  });
  const installed = candidates.find((candidate) => candidate.isSymlink) ?? null;
  const node = resolveNode();
  return {
    installedAt: process.env.O8_CLI_INSTALL_PATH || installed?.path || null,
    installStatus: process.env.O8_CLI_INSTALL_STATUS || null,
    onPath: installed ? installed.directoryOnPath : false,
    nodeResolvable: node.ok,
    nodeBin: node.path,
    candidates,
  };
}
