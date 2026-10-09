/**
 * Reads new inbound messages from the macOS Messages database (#3454).
 *
 * The authorization filter runs inside the SQL query: a row from a handle the
 * operator did not authorize never leaves SQLite, so its text is never read
 * into o8. Only rows after the stored cursor are read, and history from
 * before the receiver was enabled is never read.
 */

import Database from 'better-sqlite3';
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface ChatDbMessage {
  rowId: number;
  guid: string;
  handle: string;
  text: string;
}

export type ChatDbOpenFailure = 'missing_permission' | 'unavailable';

export class ChatDbError extends Error {
  constructor(readonly reason: ChatDbOpenFailure) {
    super(reason === 'missing_permission'
      ? 'o8 needs Full Disk Access to read Messages.'
      : 'The Messages database could not be read.');
  }
}

const MAX_BATCH = 50;
const MAX_TEXT = 8_000;

export function defaultChatDbPath(): string {
  return join(homedir(), 'Library', 'Messages', 'chat.db');
}

/**
 * Text of a message whose `text` column is empty. Newer macOS versions keep it
 * only in `attributedBody`, an archived NSAttributedString whose string follows
 * the `NSString` class marker as a length-prefixed UTF-8 run.
 */
export function textFromAttributedBody(body: Buffer | null | undefined): string {
  if (!body?.length) return '';
  const marker = body.indexOf('NSString');
  if (marker < 0) return '';
  // Skip the marker and the five bytes of class and object headers after it.
  let index = marker + 'NSString'.length + 5;
  if (index >= body.length) return '';
  let length = body[index];
  index += 1;
  if (length === 0x81) {
    if (index + 2 > body.length) return '';
    length = body.readUInt16LE(index);
    index += 2;
  } else if (length === 0x82) {
    if (index + 4 > body.length) return '';
    length = body.readUInt32LE(index);
    index += 4;
  }
  if (index + length > body.length) return '';
  return body.subarray(index, index + length).toString('utf8');
}

function openChatDb(path: string): Database.Database {
  try {
    statSync(path);
  } catch (error) {
    // Without Full Disk Access, macOS refuses even a stat of the Messages folder.
    const code = (error as { code?: unknown }).code;
    throw new ChatDbError(code === 'EPERM' || code === 'EACCES' ? 'missing_permission' : 'unavailable');
  }
  try {
    return new Database(path, { readonly: true, fileMustExist: true });
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    // macOS refuses the open (EPERM) or SQLite reports it cannot open the file
    // when the reading app lacks Full Disk Access.
    if (code === 'SQLITE_CANTOPEN' || code === 'SQLITE_AUTH' || code === 'EPERM' || code === 'EACCES') {
      throw new ChatDbError('missing_permission');
    }
    throw new ChatDbError('unavailable');
  }
}

function query(path: string, run: (db: Database.Database) => unknown): unknown {
  const db = openChatDb(path);
  try {
    return run(db);
  } catch (error) {
    if (error instanceof ChatDbError) throw error;
    const code = (error as { code?: unknown }).code;
    throw new ChatDbError(code === 'SQLITE_AUTH' || code === 'SQLITE_CANTOPEN' ? 'missing_permission' : 'unavailable');
  } finally {
    db.close();
  }
}

/** The newest message row id; the receiver starts after it when first enabled. */
export function latestRowId(path = defaultChatDbPath()): number {
  return query(path, (db) => {
    const row = db.prepare('SELECT MAX(ROWID) AS id FROM message').get() as { id: number | null } | undefined;
    return row?.id ?? 0;
  }) as number;
}

/**
 * Inbound one-to-one messages after `cursor` from the authorized handles,
 * oldest first. Group chats are not read.
 */
export function readAuthorizedMessages(handles: readonly string[], cursor: number, path = defaultChatDbPath()): ChatDbMessage[] {
  if (!handles.length) return [];
  const placeholders = handles.map(() => '?').join(', ');
  const rows = query(path, (db) => db.prepare(`
    SELECT m.ROWID AS rowId, m.guid AS guid, h.id AS handle, m.text AS text, m.attributedBody AS attributedBody
    FROM message m
    JOIN handle h ON h.ROWID = m.handle_id
    JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
    JOIN chat c ON c.ROWID = cmj.chat_id
    WHERE m.ROWID > ?
      AND m.is_from_me = 0
      AND c.style = 45
      AND h.id IN (${placeholders})
    ORDER BY m.ROWID ASC
    LIMIT ${MAX_BATCH}
  `).all(cursor, ...handles)) as Array<{ rowId: number; guid: string; handle: string; text: string | null; attributedBody: Buffer | null }>;
  return rows.map((row) => ({
    rowId: row.rowId,
    guid: row.guid,
    handle: row.handle,
    text: (row.text?.trim() || textFromAttributedBody(row.attributedBody).trim()).slice(0, MAX_TEXT),
  }));
}
