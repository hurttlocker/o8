import { accessSync, constants, statSync } from 'node:fs';
import path from 'node:path';

let cached: { key: string; binary: string } | undefined;

/** Resolve outside repository cwd, so a minimal service PATH still finds Git. */
export function resolveGitBinary(): string {
  const searchPath = process.env.PATH ?? '';
  const key = JSON.stringify([process.platform, searchPath, process.env.ProgramFiles, process.env.LOCALAPPDATA]);
  if (cached?.key === key) return cached.binary;

  const name = process.platform === 'win32' ? 'git.exe' : 'git';
  const candidates = searchPath.split(path.delimiter)
    // Relative/empty PATH entries would select code from a packet checkout.
    .filter((directory) => path.isAbsolute(directory))
    .map((directory) => path.join(directory, name));
  if (process.platform === 'win32') {
    for (const root of [process.env.ProgramFiles, process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs')]) {
      if (root && path.isAbsolute(root)) candidates.push(path.join(root, 'Git', 'cmd', name), path.join(root, 'Git', 'bin', name));
    }
  } else {
    candidates.push('/usr/bin/git', '/opt/homebrew/bin/git', '/usr/local/bin/git');
  }
  for (const binary of new Set(candidates)) {
    try {
      if (!statSync(binary).isFile()) continue;
      accessSync(binary, constants.X_OK);
      cached = { key, binary };
      return binary;
    } catch {
      // Missing or non-executable candidates do not hide later installations.
    }
  }
  throw new Error('Git executable is unavailable. Install Git or add its executable directory to PATH, then retry.');
}
