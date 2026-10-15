import { execFileSync } from 'node:child_process';
import { getDataDir } from '@/lib/data-dir-migration';
import { selectOrphanDashSessions, type DashGcOptions, type DashSessionInfo } from '@/lib/terminal/dash-gc';
import { collectPersistedTmuxSessions } from '@/lib/terminal/state-store';
import { DASH_PROFILE_OWNER_OPTION, dashProfileOwnerId } from '@/lib/terminal/dash-session-owner';
import { dashTmuxArgs } from './dash-terminal-persistence';
import { resolveTmuxBinary, sanitizePtyEnv } from './pty-support';

interface DashSessionInventory extends DashSessionInfo {
  profileOwner?: string;
  sessionId: string;
  serverPid: string;
}

/** Full inventory: restoration and snapshots also need legacy sessions. */
export function listDashTmuxSessionsWithAge(): DashSessionInventory[] {
  try {
    const output = execFileSync(
      resolveTmuxBinary(), dashTmuxArgs('list-sessions', '-F', `#{session_name}\t#{session_created}\t#{${DASH_PROFILE_OWNER_OPTION}}\t#{session_id}\t#{pid}`),
      { windowsHide: true, timeout: 4000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: sanitizePtyEnv() as NodeJS.ProcessEnv },
    );
    return output.split('\n').flatMap((line) => {
      const [name, created, profileOwner, sessionId, serverPid] = line.split('\t');
      if (!name?.startsWith('cortex-dash-')) return [];
      const seconds = Number(created);
      return [{ name, createdMs: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0, profileOwner, sessionId, serverPid }];
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
  let sessions: DashSessionInventory[];
  let owner: string;
  let referenced: Set<string>;
  try {
    owner = dashProfileOwnerId(dataDir);
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
  const byName = new Map(sessions.map(session => [session.name, session]));
  let killed = 0;
  for (const name of toKill) {
    const session = byName.get(name);
    if (!session || !/^\$\d+$/.test(session.sessionId) || !/^[1-9]\d*$/.test(session.serverPid)
      || session.createdMs <= 0) continue;
    options.beforeKill(name);
    try {
      // Reused names and restarted servers are new work. Evaluate ownership
      // and the inventoried identity inside tmux's command queue, then retire
      // that session id only, never whichever session now has its old name.
      const guard = `#{&&:#{==:#{pid},${session.serverPid}},#{&&:#{==:#{session_created},${session.createdMs / 1000}},#{==:#{${DASH_PROFILE_OWNER_OPTION}},${owner}}}}`;
      const output = execFileSync(resolveTmuxBinary(), dashTmuxArgs('if-shell', '-F', '-t', session.sessionId, guard,
        `kill-session -t '${session.sessionId}' ; display-message -p o8-gc-retired`, ''), {
        windowsHide: true, timeout: 3000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: sanitizePtyEnv() as NodeJS.ProcessEnv,
      });
      if (output.trim() === 'o8-gc-retired') killed += 1;
    } catch { /* already gone */ }
  }
  return killed;
}
