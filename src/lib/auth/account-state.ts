import 'server-only';

import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { getDataDir } from '@/lib/data-dir-migration';
import { isMetadataLockProcessIdentity, probeMetadataLockProcessIdentity,
  probeMetadataLockProcessIdentitySync, sameMetadataLockProcessIdentity,
  type MetadataLockProcessIdentity } from '@/lib/worktree/metadata-lock-process-identity';

export class AccountStateUnavailableError extends Error {
  constructor() { super('Desktop account state is unavailable or changed.'); }
}
interface Authority { root: string; reservation: string; active: boolean; mutated: boolean; failed: boolean; admitting: boolean }
interface LeaseOwner { reservation: string; pid: number; identity: string }
interface StateRow { generation: string; status: string; account_id: string | null; epoch: string | null; license_digest: string | null; signed_out: number }
export interface AccountState {
  generation: string; status: 'blocked' | 'ready'; accountId: string | null;
  epoch: string | null; licenseDigest: string | null; signedOut: boolean;
}
const authority = new AsyncLocalStorage<Authority>();
const inactiveReservations = new Set<string>();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function root(): string {
  const directory = getDataDir();
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return realpathSync(directory);
}
function database<T>(directory: string, action: (db: Database.Database) => T): T {
  const file = join(directory, 'account-state.sqlite');
  const db = new Database(file, { timeout: 0 });
  try {
    db.pragma('synchronous = FULL');
    db.exec(`CREATE TABLE IF NOT EXISTS account_lease (
      id INTEGER PRIMARY KEY CHECK (id = 1), reservation TEXT NOT NULL, pid INTEGER NOT NULL, identity TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS account_state (
      id INTEGER PRIMARY KEY CHECK (id = 1), generation TEXT NOT NULL, status TEXT NOT NULL,
      account_id TEXT, epoch TEXT, license_digest TEXT, signed_out INTEGER NOT NULL DEFAULT 0);`);
    chmodSync(file, 0o600);
    return action(db);
  } finally { db.close(); }
}
function rowState(row: StateRow | undefined): AccountState | null {
  if (!row) return null;
  if (![0, 1].includes(row.signed_out) || !UUID.test(row.generation) || !['ready', 'blocked'].includes(row.status)
    || (row.status === 'ready' && (!row.account_id || !row.epoch || !/^[a-f0-9]{64}$/.test(row.license_digest ?? '')))) {
    throw new AccountStateUnavailableError();
  }
  return { generation: row.generation, status: row.status as AccountState['status'],
    accountId: row.account_id, epoch: row.epoch, licenseDigest: row.license_digest, signedOut: row.signed_out === 1 };
}
function readState(directory: string): AccountState | null {
  return database(directory, (db) => rowState(db.prepare('SELECT * FROM account_state WHERE id = 1').get() as StateRow | undefined));
}
export function readAccountState(): AccountState | null {
  try { return readState(root()); } catch { return null; }
}
function requireAuthority(): Authority {
  const held = authority.getStore();
  if (!held?.active || held.root !== root()) throw new AccountStateUnavailableError();
  const owner = database(held.root, (db) => db.prepare('SELECT reservation FROM account_lease WHERE id = 1').get() as { reservation: string } | undefined);
  if (owner?.reservation !== held.reservation) throw new AccountStateUnavailableError();
  return held;
}
function claim(directory: string, reservation: string, identity: MetadataLockProcessIdentity): LeaseOwner | null {
  return database(directory, (db) => db.transaction(() => {
    const inserted = db.prepare('INSERT OR IGNORE INTO account_lease VALUES (1, ?, ?, ?)')
      .run(reservation, process.pid, JSON.stringify(identity));
    if (inserted.changes === 1) return null;
    const owner = db.prepare('SELECT reservation, pid, identity FROM account_lease WHERE id = 1').get() as LeaseOwner | undefined;
    if (!owner) throw new AccountStateUnavailableError();
    return owner;
  }).immediate());
}
function ownerIdentity(owner: LeaseOwner): MetadataLockProcessIdentity {
  const parsed: unknown = JSON.parse(owner.identity);
  if (!isMetadataLockProcessIdentity(parsed)) throw new AccountStateUnavailableError();
  return parsed;
}
function reclaim(directory: string, owner: LeaseOwner): void {
  database(directory, (db) => db.prepare('DELETE FROM account_lease WHERE id = 1 AND reservation = ?').run(owner.reservation));
}
function reservationKey(held: Pick<Authority, 'root' | 'reservation'>): string {
  return `${held.root}\0${held.reservation}`;
}
function releaseOnce(held: Authority): void {
  // A recovered inactive reservation may already be gone. Never delete a
  // different reservation, including another call from this same process.
  database(held.root, (db) => db.prepare('DELETE FROM account_lease WHERE id = 1 AND reservation = ?').run(held.reservation));
  inactiveReservations.delete(reservationKey(held));
}
async function release(held: Authority): Promise<void> {
  held.active = false;
  inactiveReservations.add(reservationKey(held));
  const deadline = Date.now() + 10_000;
  for (;;) {
    try { releaseOnce(held); return; }
    catch (error) { if (!busy(error) || Date.now() >= deadline) throw error; }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
function releaseSynchronous(held: Authority): void {
  held.active = false;
  inactiveReservations.add(reservationKey(held));
  try { releaseOnce(held); }
  catch (error) {
    if (!busy(error)) throw error;
    // Do not block the event loop. Authority is already retired, and the exact
    // reservation remains recoverable by this process if bounded retry fails.
    void release(held).catch(() => console.warn('[auth] account lease release requires recovery'));
  }
}
function busy(error: unknown): boolean {
  return (error as { code?: string })?.code === 'SQLITE_BUSY';
}

/** One installation-wide lease. Unknown owner identity never permits takeover. */
export async function withAccountStateLease<T>(action: () => Promise<T> | T): Promise<T> {
  if (authority.getStore()) { requireAuthority(); return action(); }
  const directory = root();
  const probe = await probeMetadataLockProcessIdentity(process.pid);
  if (probe.state !== 'live') throw new AccountStateUnavailableError();
  const held = { root: directory, reservation: randomUUID(), active: true, mutated: false, failed: false, admitting: false };
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      const owner = claim(directory, held.reservation, probe.identity);
      if (!owner) break;
      if (owner.pid === process.pid && inactiveReservations.has(reservationKey({ root: directory, reservation: owner.reservation }))) {
        reclaim(directory, owner);
        continue;
      }
      const identity = ownerIdentity(owner);
      const ownerProbe = await probeMetadataLockProcessIdentity(owner.pid);
      if (ownerProbe.state === 'absent' || (ownerProbe.state === 'live'
        && !sameMetadataLockProcessIdentity(identity, ownerProbe.identity))) {
        reclaim(directory, owner);
        continue;
      }
    } catch (error) { if (!busy(error)) throw error; }
    if (Date.now() >= deadline) throw new AccountStateUnavailableError();
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  try { return await authority.run(held, action); } finally { await release(held); }
}

/** Journal invalidation commits before any legacy account file is changed. */
export function invalidateAccountState(): void {
  const held = requireAuthority();
  if (held.admitting) throw new AccountStateUnavailableError();
  if (held.mutated) return;
  database(held.root, (db) => {
    db.prepare(`INSERT INTO account_state VALUES (1, ?, 'blocked', NULL, NULL, NULL, 0)
      ON CONFLICT(id) DO UPDATE SET generation = excluded.generation, status = 'blocked',
      account_id = NULL, epoch = NULL, license_digest = NULL`).run(randomUUID());
  });
  held.mutated = true;
}

/** Synchronous callers never block the event loop waiting for a live owner. */
export function withSynchronousAccountStateLease<T>(action: () => T): T {
  if (authority.getStore()) { requireAuthority(); return action(); }
  const directory = root();
  const probe = probeMetadataLockProcessIdentitySync(process.pid);
  if (probe.state !== 'live') throw new AccountStateUnavailableError();
  const held = { root: directory, reservation: randomUUID(), active: true, mutated: false, failed: false, admitting: false };
  for (;;) {
    const owner = claim(directory, held.reservation, probe.identity);
    if (!owner) break;
    if (owner.pid === process.pid && inactiveReservations.has(reservationKey({ root: directory, reservation: owner.reservation }))) {
      reclaim(directory, owner);
      continue;
    }
    const identity = ownerIdentity(owner);
    const ownerProbe = probeMetadataLockProcessIdentitySync(owner.pid);
    if (ownerProbe.state !== 'absent' && (ownerProbe.state !== 'live'
      || sameMetadataLockProcessIdentity(identity, ownerProbe.identity))) throw new AccountStateUnavailableError();
    reclaim(directory, owner);
  }
  try { return authority.run(held, action); } finally { releaseSynchronous(held); }
}
export function mutateAccountState<T>(action: () => T): T {
  return withSynchronousAccountStateLease(() => {
    invalidateAccountState();
    try { return action(); } catch (error) { requireAuthority().failed = true; throw error; }
  });
}
/** Explicit sign-out cannot expire or be retired by an ordinary refresh. */
export function holdAccountRefresh(): void {
  invalidateAccountState();
  database(requireAuthority().root, (db) => db.prepare('UPDATE account_state SET signed_out = 1 WHERE id = 1').run());
}
/** Only the completed operator fresh-sign-in transition calls this. */
export function allowAccountRefresh(): void {
  const held = requireAuthority();
  if (held.failed || held.admitting) throw new AccountStateUnavailableError();
  database(held.root, (db) => db.prepare('UPDATE account_state SET signed_out = 0 WHERE id = 1').run());
}
export function accountRefreshIsBlocked(): boolean {
  const state = readAccountState();
  return !state || state.signedOut;
}
export function currentAccountGeneration(): string {
  const held = requireAuthority();
  let state = readState(held.root);
  if (!state) { invalidateAccountState(); state = readState(held.root); }
  if (!state) throw new AccountStateUnavailableError();
  return state.generation;
}
export async function captureAccountGeneration(): Promise<string> {
  return withAccountStateLease(currentAccountGeneration);
}
export function requireAccountGeneration(generation: string): void {
  if (currentAccountGeneration() !== generation) throw new AccountStateUnavailableError();
}
function fingerprint(): { accountId: string; epoch: string; licenseDigest: string } | null {
  try {
    const directory = root();
    try { readFileSync(join(directory, 'auth-signed-out-at')); return null; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null; }
    const accountId = readFileSync(join(directory, 'active-identity'), 'utf8').trim();
    const epoch = readFileSync(join(directory, 'github-signin-epoch'), 'utf8').trim();
    const cache: unknown = JSON.parse(readFileSync(join(directory, 'entitlement.json'), 'utf8'));
    const license = (cache as { licenseKey?: unknown } | null)?.licenseKey;
    if (!accountId || !epoch || typeof license !== 'string' || !license) return null;
    return { accountId, epoch, licenseDigest: createHash('sha256').update(license).digest('hex') };
  } catch { return null; }
}
export function accountStateMatches(state: AccountState): boolean {
  const value = fingerprint();
  return !state.signedOut && state.status === 'ready' && value !== null && value.accountId === state.accountId
    && value.epoch === state.epoch && value.licenseDigest === state.licenseDigest;
}
/** Caller must first strictly verify the exact persisted license and subject. */
export function publishReadyAccountState(accountId: string, epoch: string, license: string): void {
  const held = requireAuthority();
  const value = fingerprint();
  if (held.failed || accountRefreshIsBlocked() || !value || value.accountId !== accountId || value.epoch !== epoch
    || value.licenseDigest !== createHash('sha256').update(license).digest('hex')) throw new AccountStateUnavailableError();
  const changed = database(held.root, (db) => db.prepare(`UPDATE account_state SET status = 'ready',
    account_id = ?, epoch = ?, license_digest = ? WHERE id = 1 AND generation = ?`)
    .run(accountId, epoch, value.licenseDigest, currentAccountGeneration()));
  if (changed.changes !== 1) throw new AccountStateUnavailableError();
  held.mutated = false;
}

/** Credential housekeeping may preserve readiness only for the exact same verified binding. */
export async function withPreservedAccountState<T>(action: () => Promise<T> | T): Promise<T> {
  return withAccountStateLease(async () => {
    const prior = readState(requireAuthority().root);
    const preserve = prior && accountStateMatches(prior);
    const result = await action();
    if (preserve && !requireAuthority().failed && accountStateMatches(prior)) {
      const directory = requireAuthority().root;
      const license = (JSON.parse(readFileSync(join(directory, 'entitlement.json'), 'utf8')) as { licenseKey: string }).licenseKey;
      publishReadyAccountState(prior.accountId!, prior.epoch!, license);
    }
    return result;
  });
}

/** Admission is immutable, including nested work in the same asynchronous context. */
export async function withAccountStateAdmission<T>(action: () => Promise<T> | T): Promise<T> {
  return withAccountStateLease(async () => {
    const held = requireAuthority();
    const prior = held.admitting;
    held.admitting = true;
    try { return await action(); } finally { held.admitting = prior; }
  });
}
