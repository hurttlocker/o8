import type Database from 'better-sqlite3';

/** Schema v40: bind storage reservations to the exact managed-root directory. */
export function ensureV40StorageRootIdentitySchema(sqlite: Database.Database): void {
  const columns = sqlite.prepare('PRAGMA table_info(storage_admission_reservations)').all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === 'root_identity_json')) {
    try {
      sqlite.exec('ALTER TABLE storage_admission_reservations ADD COLUMN root_identity_json TEXT');
    } catch (error) {
      if (!String(error).toLowerCase().includes('duplicate column name')) throw error;
    }
  }
}
