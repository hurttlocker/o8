import { realpathSync } from 'node:fs';
import { parse, resolve } from 'node:path';

import type Database from 'better-sqlite3';

export function normalizeAgentBusRepoPath(repo: string): string {
  const absolute = resolve(repo);
  try {
    const canonical = realpathSync.native(absolute);
    return canonical === parse(canonical).root ? canonical : canonical.replace(/\/+$/, '');
  } catch {
    return absolute === parse(absolute).root ? absolute : absolute.replace(/\/+$/, '');
  }
}

export function reconcilePersistedAgentBusRepoPaths(sqlite: Database.Database): void {
  const rows = sqlite.prepare(`
    SELECT repo_path FROM agent_presence
    UNION
    SELECT repo_path FROM agent_messages
    UNION
    SELECT repo_path FROM agent_conversations
    UNION
    SELECT repo_path FROM agent_inbox_state
  `).all() as Array<{ repo_path: string }>;
  const aliases = rows.map((row) => ({ source: row.repo_path, canonical: normalizeAgentBusRepoPath(row.repo_path) }))
    .filter(({ source, canonical }) => source !== canonical);
  if (aliases.length === 0) return;

  const hasPresenceConflict = sqlite.prepare(`
    SELECT 1
    FROM agent_presence AS alias
    JOIN agent_presence AS canonical
      ON canonical.repo_path = ? AND canonical.name = alias.name COLLATE NOCASE
    WHERE alias.repo_path = ?
    LIMIT 1
  `);
  const hasInboxConflict = sqlite.prepare(`
    SELECT 1
    FROM agent_inbox_state AS alias
    JOIN agent_inbox_state AS canonical
      ON canonical.repo_path = ? AND canonical.agent_name = alias.agent_name COLLATE NOCASE
    WHERE alias.repo_path = ?
    LIMIT 1
  `);
  const rewrite = sqlite.transaction(() => {
    for (const { source, canonical } of aliases) {
      // Keep ambiguous legacy scopes isolated until their names are resolved.
      if (hasPresenceConflict.get(canonical, source) || hasInboxConflict.get(canonical, source)) continue;
      sqlite.prepare('UPDATE agent_messages SET repo_path = ? WHERE repo_path = ?').run(canonical, source);
      sqlite.prepare('UPDATE agent_conversations SET repo_path = ? WHERE repo_path = ?').run(canonical, source);
      sqlite.prepare('UPDATE agent_presence SET repo_path = ? WHERE repo_path = ?').run(canonical, source);
      sqlite.prepare('UPDATE agent_inbox_state SET repo_path = ? WHERE repo_path = ?').run(canonical, source);
    }
  });
  rewrite();
}
