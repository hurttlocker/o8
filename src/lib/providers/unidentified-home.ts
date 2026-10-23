import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const homes = new Set<string>();
process.once('exit', () => { for (const home of homes) rmSync(home, { recursive: true, force: true }); });

/** No runtime identity means no inherited account/configuration home, even implicitly. */
export function isolateUnidentifiedHome(env: Record<string, string>): void {
  const originalHome = env.HOME || env.USERPROFILE;
  if (originalHome) {
    // Utility service configuration is unrelated to provider authentication.
    env.GIT_CONFIG_GLOBAL ||= join(originalHome, '.gitconfig');
    env.GH_CONFIG_DIR ||= join(env.XDG_CONFIG_HOME || join(originalHome, '.config'), 'gh');
  }
  const home = mkdtempSync(join(tmpdir(), 'o8-unidentified-child-'));
  homes.add(home);
  const directory = (name: string) => {
    const dir = join(home, name); mkdirSync(dir, { recursive: true, mode: 0o700 }); return dir;
  };
  env.HOME = home;
  env.USERPROFILE = home;
  env.CODEX_HOME = directory('.codex');
  env.CODEX_SQLITE_HOME = env.CODEX_HOME;
  // An empty auth object also supports probes which read the file unconditionally.
  writeFileSync(join(env.CODEX_HOME, 'auth.json'), '{}\n', { mode: 0o600 });
  env.CLAUDE_CONFIG_DIR = directory('.claude');
  env.CLAUDE_HOME = env.CLAUDE_CONFIG_DIR;
  env.GEMINI_HOME = directory('.gemini');
  env.HERMES_HOME = directory('.hermes');
  env.XDG_CONFIG_HOME = directory('.config');
  env.XDG_DATA_HOME = directory('.local/share');
  env.XDG_STATE_HOME = directory('.local/state');
  env.XDG_CACHE_HOME = directory('.cache');
  env.OPENCODE_CONFIG_DIR = directory('.config/opencode');
  env.OPENCODE_CONFIG = join(env.OPENCODE_CONFIG_DIR, 'config.json');
  env.PI_CODING_AGENT_DIR = directory('.pi/agent');
  env.OPENCLAW_STATE_DIR = directory('.openclaw');
  env.OPENCLAW_CONFIG_PATH = join(env.OPENCLAW_STATE_DIR, 'openclaw.json');
  env.MUSE_AUTH_PATH = join(directory('.local/share/muse'), 'auth.json');
}
