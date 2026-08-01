import 'server-only';

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { getSqlite } from '@/lib/db';
import { getDataDir } from '@/lib/data-dir-migration';
import { persistCanonicalChatHistoryRecord } from '@/lib/llm/chat-history-store';

function stateDirs() {
  return Array.from(new Set([getDataDir(), getDataDir({}, homedir())]));
}

export interface RepoPathRepointStats {
  databaseRows: number;
  jsonFiles: number;
  terminalStateFiles: number;
}

function normalizeRepoPath(repoPath: string) {
  return path.resolve(repoPath.trim().replace(/^~(?=\/|$)/, homedir())).replace(/\/+$/, '');
}

function replacementForPath(value: string, previousPath: string, nextPath: string) {
  if (value === previousPath) return nextPath;
  if (value.startsWith(`${previousPath}/`)) return `${nextPath}${value.slice(previousPath.length)}`;
  return value;
}

function repointJsonValue(value: unknown, previousPath: string, nextPath: string): [unknown, boolean] {
  if (typeof value === 'string') {
    const next = replacementForPath(value, previousPath, nextPath);
    return [next, next !== value];
  }
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const [repointed, itemChanged] = repointJsonValue(item, previousPath, nextPath);
      changed ||= itemChanged;
      return repointed;
    });
    return [next, changed];
  }
  if (!value || typeof value !== 'object') return [value, false];

  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const [repointed, itemChanged] = repointJsonValue(item, previousPath, nextPath);
    const nextKey = replacementForPath(key, previousPath, nextPath);
    next[nextKey] = repointed;
    changed ||= itemChanged || nextKey !== key;
  }
  return [next, changed];
}

function migrateJsonFile(filePath: string, previousPath: string, nextPath: string) {
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
    const [repointed, changed] = repointJsonValue(parsed, previousPath, nextPath);
    if (!changed) return false;
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, `${JSON.stringify(repointed, null, 2)}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

function migrateChatHistoryFile(filePath: string, previousPath: string, nextPath: string) {
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
    const [repointed, changed] = repointJsonValue(parsed, previousPath, nextPath);
    if (!changed || !repointed || typeof repointed !== 'object') return false;
    const record = repointed as Record<string, unknown>;
    if (!Array.isArray(record.messages)) return false;
    persistCanonicalChatHistoryRecord(path.basename(filePath, '.json'), {
      ...record,
      messages: record.messages,
    });
    return true;
  } catch {
    return false;
  }
}

function hashScopeKey(value: string) {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) + hash) ^ value.charCodeAt(index);
  }
  return Math.abs(hash >>> 0).toString(36);
}

function migrateTerminalStateScopes(stateDir: string, previousPath: string, nextPath: string) {
  const terminalStateDir = path.join(stateDir, 'terminal-states');
  if (!existsSync(terminalStateDir)) return { files: 0, migrated: 0 };

  const files = readdirSync(terminalStateDir)
    .filter((file) => file.endsWith('.json'))
    .map((file) => path.join(terminalStateDir, file));
  let migrated = 0;
  for (const filePath of files) {
    if (migrateJsonFile(filePath, previousPath, nextPath)) migrated += 1;
  }

  const previousScopePath = path.join(terminalStateDir, `repo-${hashScopeKey(previousPath)}.json`);
  const nextScopePath = path.join(terminalStateDir, `repo-${hashScopeKey(nextPath)}.json`);
  if (previousScopePath !== nextScopePath && existsSync(previousScopePath)) {
    if (!existsSync(nextScopePath)) {
      renameSync(previousScopePath, nextScopePath);
    } else {
      try {
        const previous = JSON.parse(readFileSync(previousScopePath, 'utf8')) as { tabs?: unknown[]; activeTabId?: string };
        const current = JSON.parse(readFileSync(nextScopePath, 'utf8')) as { tabs?: unknown[]; activeTabId?: string };
        const tabs = [...(current.tabs ?? []), ...(previous.tabs ?? [])];
        const seen = new Set<string>();
        const uniqueTabs = tabs.filter((tab) => {
          const id = typeof tab === 'object' && tab !== null && 'id' in tab ? String(tab.id ?? '') : '';
          if (!id || seen.has(id)) return !id;
          seen.add(id);
          return true;
        });
        writeFileSync(nextScopePath, `${JSON.stringify({
          ...current,
          activeTabId: current.activeTabId ?? previous.activeTabId,
          tabs: uniqueTabs,
        }, null, 2)}\n`, 'utf8');
        rmSync(previousScopePath, { force: true });
      } catch {
        // Keep both files when historical terminal state cannot be parsed.
      }
    }
  }

  return { files: files.length, migrated };
}

function quoteIdentifier(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
}

function migrateDatabasePaths(previousPath: string, nextPath: string) {
  const sqlite = getSqlite();
  const tables = sqlite.prepare(
    "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
  ).all() as Array<{ name: string; sql: string | null }>;
  let databaseRows = 0;

  sqlite.transaction(() => {
    for (const table of tables) {
      if (table.sql?.toUpperCase().includes('CREATE VIRTUAL TABLE')) continue;
      const quotedTable = quoteIdentifier(table.name);
      const columns = sqlite.prepare(`PRAGMA table_info(${quotedTable})`).all() as Array<{ name: string }>;
      const names = new Set(columns.map((column) => column.name));
      const updatePathColumn = (column: string) => {
        const result = sqlite.prepare(
          `UPDATE ${quotedTable}
             SET ${quoteIdentifier(column)} = CASE
               WHEN ${quoteIdentifier(column)} = ? THEN ?
               ELSE ? || substr(${quoteIdentifier(column)}, ?)
             END
           WHERE ${quoteIdentifier(column)} = ? OR ${quoteIdentifier(column)} LIKE ?`,
        ).run(previousPath, nextPath, nextPath, previousPath.length + 1, previousPath, `${previousPath}/%`);
        databaseRows += result.changes;
      };
      for (const column of columns) {
        if (column.name.endsWith('_path')) updatePathColumn(column.name);
      }
      if (names.has('doc_id')) {
        const result = sqlite.prepare(
          `UPDATE ${quotedTable} SET "doc_id" = ? || substr("doc_id", ?) WHERE "doc_id" LIKE ?`,
        ).run(nextPath, previousPath.length + 1, `${previousPath}:%`);
        databaseRows += result.changes;
      }
      if (names.has('source_id')) {
        const result = sqlite.prepare(
          `UPDATE ${quotedTable} SET "source_id" = replace("source_id", ?, ?) WHERE instr("source_id", ?) > 0`,
        ).run(previousPath, nextPath, previousPath);
        databaseRows += result.changes;
      }
      if (table.name === 'docs' && names.has('id')) {
        const result = sqlite.prepare(
          `UPDATE ${quotedTable} SET "id" = ? || substr("id", ?) WHERE "id" LIKE ?`,
        ).run(nextPath, previousPath.length + 1, `${previousPath}:%`);
        databaseRows += result.changes;
      }

      for (const column of columns) {
        if (!column.name.endsWith('_json')) continue;
        const quotedColumn = quoteIdentifier(column.name);
        const rows = sqlite.prepare(`SELECT rowid, ${quotedColumn} AS value FROM ${quotedTable}`).all() as Array<{ rowid: number; value: string | null }>;
        const write = sqlite.prepare(`UPDATE ${quotedTable} SET ${quotedColumn} = ? WHERE rowid = ?`);
        for (const row of rows) {
          if (typeof row.value !== 'string') continue;
          try {
            const [repointed, changed] = repointJsonValue(JSON.parse(row.value), previousPath, nextPath);
            if (!changed) continue;
            write.run(JSON.stringify(repointed), row.rowid);
            databaseRows += 1;
          } catch {
            // A malformed historical JSON field must not block the path migration.
          }
        }
      }
    }
  })();

  return databaseRows;
}

/** Rewrite the durable path-keyed state after a registry entry moves in place. */
export function repointRepoPathReferences(previousLocalPath: string, nextLocalPath: string): RepoPathRepointStats {
  const previousPath = normalizeRepoPath(previousLocalPath);
  const nextPath = normalizeRepoPath(nextLocalPath);
  if (!previousPath || previousPath === nextPath) {
    return { databaseRows: 0, jsonFiles: 0, terminalStateFiles: 0 };
  }

  const terminal = stateDirs().map((stateDir) => migrateTerminalStateScopes(stateDir, previousPath, nextPath));
  let jsonFiles = 0;
  for (const stateDir of stateDirs()) {
    const stateFiles = [
      path.join(stateDir, 'terminal-state.json'),
      path.join(stateDir, 'runtime-terminal-sessions.json'),
      path.join(stateDir, 'workspace-lifecycle.json'),
      path.join(stateDir, 'orchestrator-state.json'),
      path.join(stateDir, 'external-merge-state.json'),
    ];
    for (const filePath of stateFiles) {
      if (existsSync(filePath) && migrateJsonFile(filePath, previousPath, nextPath)) jsonFiles += 1;
    }
    const chatHistoryDir = path.join(stateDir, 'chat-history');
    if (existsSync(chatHistoryDir)) {
      for (const file of readdirSync(chatHistoryDir)) {
        if (file.endsWith('.json') && migrateChatHistoryFile(path.join(chatHistoryDir, file), previousPath, nextPath)) {
          jsonFiles += 1;
        }
      }
    }
  }

  return {
    databaseRows: migrateDatabasePaths(previousPath, nextPath),
    jsonFiles,
    terminalStateFiles: terminal.reduce((count, result) => count + result.migrated, 0),
  };
}
