import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, lstatSync, mkdirSync, openSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import Database from 'better-sqlite3';

/** Host-trusted billing evidence, never accepted from worker/request arguments.
 * Bounds must cover the entire serialized request, hidden tokens, fees, failed
 * requests and any upstream work. There is deliberately no live contract yet.
 */
export interface ManagedPiBillingContract {
  id: string;
  modelId: string;
  endpoint: string;
  evidence: string;
  expiresAt: number;
  coverage: 'all-including-failed-requests';
  contextWindow: number;
  maxRequestBytes: number;
  maxBillableInputTokens: number;
  maxBillableOutputTokens: number;
  inputMicroUsdPerMillion: number;
  outputMicroUsdPerMillion: number;
  fixedMicroUsdPerRequest: number;
  maxCalls: number;
}
export interface PiTestBudgetSnapshot {
  limitMicroUsd: number;
  reservedMicroUsd: number;
  calls: number;
  pending: number;
  unknown: number;
}
const MAX_APPROVED_MICRO_USD = 1_000_000;

export function validatePiBillingContract(contract: ManagedPiBillingContract) {
  if (!contract || !/^[a-zA-Z0-9._-]{1,128}$/.test(contract.id)
    || !/^[a-zA-Z0-9/._:-]{1,200}$/.test(contract.modelId)
    || typeof contract.evidence !== 'string' || !contract.evidence.trim()
    || contract.coverage !== 'all-including-failed-requests') throw new Error('Trusted all-in billing contract is required');
  const url = new URL(contract.endpoint);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('Billing contract endpoint is invalid');
  }
  for (const value of [contract.expiresAt, contract.contextWindow, contract.maxRequestBytes,
    contract.maxBillableInputTokens, contract.maxBillableOutputTokens, contract.maxCalls]) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Billing contract bound is invalid');
  }
  for (const value of [contract.inputMicroUsdPerMillion, contract.outputMicroUsdPerMillion, contract.fixedMicroUsdPerRequest]) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('Billing rate is invalid');
  }
  if (contract.expiresAt <= Date.now() || contract.maxCalls > 8 || contract.maxRequestBytes > 65_536
    || contract.contextWindow > contract.maxBillableInputTokens || contract.maxBillableOutputTokens > 4096) {
    throw new Error('Billing contract is expired or outside the bounded test scope');
  }
  if (maximumPiRequestCost(contract) <= 0) throw new Error('Unknown or zero-charge contracts are not enabled for paid tests');
}
export function maximumPiRequestCost(contract: ManagedPiBillingContract): number {
  const roundUp = (tokens: number, rate: number) => (BigInt(tokens) * BigInt(rate) + BigInt(999_999)) / BigInt(1_000_000);
  const cost = roundUp(contract.maxBillableInputTokens, contract.inputMicroUsdPerMillion)
    + roundUp(contract.maxBillableOutputTokens, contract.outputMicroUsdPerMillion)
    + BigInt(contract.fixedMicroUsdPerRequest);
  if (cost > BigInt(MAX_APPROVED_MICRO_USD)) throw new Error('One request exceeds the approved maximum');
  return Number(cost);
}
function fingerprint(contract: ManagedPiBillingContract) {
  return createHash('sha256').update(JSON.stringify([
    contract.id, contract.modelId, contract.endpoint, contract.evidence, contract.expiresAt,
    contract.coverage, contract.contextWindow, contract.maxRequestBytes, contract.maxBillableInputTokens,
    contract.maxBillableOutputTokens, contract.inputMicroUsdPerMillion, contract.outputMicroUsdPerMillion,
    contract.fixedMicroUsdPerRequest, contract.maxCalls,
  ])).digest('hex');
}
function openLedger(file: string) {
  if (!isAbsolute(file)) throw new Error('Budget ledger must use an owned absolute path');
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('Budget ledger is not an owned regular file');
  const db = new Database(file, { fileMustExist: true, timeout: 2000 });
  db.pragma('busy_timeout = 2000');
  db.pragma('synchronous = FULL');
  return db;
}

/** Explicit one-time initialization. Never recreate/reset a missing ledger on a request. */
export function initializePiTestBudget(file: string, limitMicroUsd: number, contract: ManagedPiBillingContract) {
  validatePiBillingContract(contract);
  if (!Number.isSafeInteger(limitMicroUsd) || limitMicroUsd <= 0 || limitMicroUsd > MAX_APPROVED_MICRO_USD) {
    throw new Error('Approved test limit must be between one micro-dollar and one USD');
  }
  if (!isAbsolute(file)) throw new Error('Budget ledger must use an owned absolute path');
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const fd = openSync(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  closeSync(fd);
  const db = openLedger(file);
  try {
    db.exec(`
      CREATE TABLE budget (singleton INTEGER PRIMARY KEY CHECK(singleton=1), limit_micro INTEGER NOT NULL,
        contract_hash TEXT NOT NULL, reserved_micro INTEGER NOT NULL DEFAULT 0, calls INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE reservations (id TEXT PRIMARY KEY, amount_micro INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending','complete','unknown')));
    `);
    db.prepare('INSERT INTO budget(singleton, limit_micro, contract_hash) VALUES(1, ?, ?)')
      .run(limitMicroUsd, fingerprint(contract));
  } finally { db.close(); }
}

/** SQLite immediate transaction serializes admission across processes. No refunds. */
export function reservePiTestRequest(file: string, contract: ManagedPiBillingContract): string {
  validatePiBillingContract(contract);
  const amount = maximumPiRequestCost(contract);
  const db = openLedger(file);
  try {
    return db.transaction(() => {
      validatePiBillingContract(contract); // Lock acquisition may have waited past expiry.
      const row = db.prepare('SELECT * FROM budget WHERE singleton=1').get() as {
        limit_micro: number; contract_hash: string; reserved_micro: number; calls: number;
      } | undefined;
      if (!row || row.contract_hash !== fingerprint(contract)) throw new Error('Budget billing contract changed');
      if (![row.limit_micro, row.reserved_micro, row.calls].every(Number.isSafeInteger)
        || row.limit_micro <= 0 || row.limit_micro > MAX_APPROVED_MICRO_USD
        || row.reserved_micro < 0 || row.reserved_micro > row.limit_micro || row.calls < 0) {
        throw new Error('Budget state is invalid');
      }
      const totals = db.prepare('SELECT count(*) AS count, COALESCE(sum(amount_micro),0) AS total FROM reservations').get() as { count: number; total: number };
      if (totals.count !== row.calls || totals.total !== row.reserved_micro) throw new Error('Budget state is inconsistent');
      const unresolved = db.prepare("SELECT count(*) AS count FROM reservations WHERE status != 'complete'").get() as { count: number };
      if (unresolved.count) throw new Error('A pending or unknown charge blocks this test budget');
      if (row.calls >= contract.maxCalls || row.reserved_micro + amount > row.limit_micro) throw new Error('Approved test budget exhausted');
      const id = randomUUID();
      db.prepare("INSERT INTO reservations(id, amount_micro, status) VALUES(?, ?, 'pending')").run(id, amount);
      db.prepare('UPDATE budget SET reserved_micro=reserved_micro+?, calls=calls+1 WHERE singleton=1').run(amount);
      return id;
    }).immediate();
  } finally { db.close(); }
}

export function finishPiTestRequest(file: string, id: string, successfulStream: boolean) {
  const db = openLedger(file);
  try {
    const changed = db.prepare("UPDATE reservations SET status=? WHERE id=? AND status='pending'")
      .run(successfulStream ? 'complete' : 'unknown', id).changes;
    if (changed !== 1) throw new Error('Budget reservation could not be finalized');
    // Even complete requests retain their entire maximum reservation. Usage
    // estimates cannot release money; no invoice reconciliation is claimed.
  } finally { db.close(); }
}
export function readPiTestBudget(file: string): PiTestBudgetSnapshot {
  const db = openLedger(file);
  try {
    return db.transaction(() => {
      const budget = db.prepare('SELECT limit_micro, reserved_micro, calls FROM budget WHERE singleton=1').get() as {
        limit_micro: number; reserved_micro: number; calls: number;
      };
      const statuses = db.prepare("SELECT sum(status='pending') AS pending, sum(status='unknown') AS unknown FROM reservations").get() as { pending: number | null; unknown: number | null };
      if (!budget || ![budget.limit_micro, budget.reserved_micro, budget.calls].every(Number.isSafeInteger)
        || budget.limit_micro <= 0 || budget.limit_micro > MAX_APPROVED_MICRO_USD
        || budget.reserved_micro < 0 || budget.reserved_micro > budget.limit_micro || budget.calls < 0) {
        throw new Error('Budget state is invalid');
      }
      const totals = db.prepare('SELECT count(*) AS count, COALESCE(sum(amount_micro),0) AS total FROM reservations').get() as { count: number; total: number };
      if (totals.count !== budget.calls || totals.total !== budget.reserved_micro) throw new Error('Budget state is inconsistent');
      return { limitMicroUsd: budget.limit_micro, reservedMicroUsd: budget.reserved_micro, calls: budget.calls,
        pending: statuses.pending ?? 0, unknown: statuses.unknown ?? 0 };
    })();
  } finally { db.close(); }
}
