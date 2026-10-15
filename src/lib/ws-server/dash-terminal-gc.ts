import { execFileSync } from 'node:child_process';
import { getDataDir } from '@/lib/data-dir-migration';
import { selectOrphanDashSessions, type DashGcOptions, type DashSessionInfo } from '@/lib/terminal/dash-gc';
import { collectPersistedTmuxSessions } from '@/lib/terminal/state-store';
import { DASH_PROFILE_OWNER_OPTION, dashProfileOwnerId } from '@/lib/terminal/dash-session-owner';
import { dashTmuxArgs } from './dash-terminal-persistence';
import { resolveTmuxBinary, sanitizePtyEnv } from './pty-support';

/** Full inventory: restoration and snapshots also need legacy sessions. */
export function listDashTmuxSessionsWithAge(): (DashSessionInfo & { profileOwner?: string })[] {
  try {
    const output = execFileSync(
      resolveTmuxBinary(), dashTmuxArgs('list-sessions', '-F', `#{session_name}\t#{session_created}\t#{${DASH_PROFILE_OWNER_OPTION}}`),
      { windowsHide: true, timeout: 4000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: sanitizePtyEnv() },
    );
    return output.split('\n').flatMap((line) => {
      const [name, created, profileOwner] = line.split('\t');
      if (!name?.startsWith('cortex-dash-')) return [];
      const seconds = Number(created);
      return [{ name, createdMs: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0, profileOwner }];
    });
  } catch {
    return [];
  }
}

interface ReapDashSessionsOptions extends DashGcOptions {
  dataDir?: string;
  liveSessionNames: Iterable<string>;
  collectAdditionalReferences: () => Iterable<string>;
  beforeKill: (sessionName: string) => void;
}

/** The bridge's real collector, including durable references and tmux I/O. */
export function reapOrphanDashTmuxSessions(options: ReapDashSessionsOptions): number {
  const dataDir = options.dataDir ?? getDataDir();
  let sessions: DashSessionInfo[];
  let referenced: Set<string>;
  try {
    const owner = dashProfileOwnerId(dataDir);
    // Filtering belongs only to retirement. Shared restoration inventory must
    // continue to see untagged survivors from earlier versions.
    sessions = listDashTmuxSessionsWithAge().filter((session) => session.profileOwner === owner);
    if (!sessions.length) return 0;
    referenced = collectPersistedTmuxSessions(dataDir);
    for (const name of options.collectAdditionalReferences()) referenced.add(name);
  } catch {
    return 0;
  }
  for (const name of options.liveSessionNames) referenced.add(name);
  const toKill = selectOrphanDashSessions(sessions, referenced, options);
  let killed = 0;
  for (const name of toKill) {
    options.beforeKill(name);
    try {
      execFileSync(resolveTmuxBinary(), dashTmuxArgs('kill-session', '-t', `=${name}`), {
        windowsHide: true, timeout: 3000, stdio: 'ignore', env: sanitizePtyEnv(),
      });
      killed += 1;
    } catch { /* already gone */ }
  }
  return killed;
}
