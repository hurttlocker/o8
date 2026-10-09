import { getSqlite } from '@/lib/db';
import type { GeneratedOutputBankEntry } from './generated-output-bank';
import type { BankWriteReceipt } from './generated-output-bank-io';
import { readGeneratedOutputResource, type GeneratedOutputResource } from './generated-output-state';

type Phase = 'planned' | 'ready' | 'prepared' | 'written' | 'complete';
interface Row { phase: Phase; receipt_json: string | null; entry_json: string; observed_closed: number }

/** Native child ownership and inode acknowledgements precede every bank write. */
export function recordGeneratedOutputBankEntry(resource: GeneratedOutputResource, index: number,
  entry: GeneratedOutputBankEntry | null, phase: Phase, receipt?: BankWriteReceipt): void {
  if (!resource.bankCapture || !Number.isSafeInteger(index) || index < -1 || index >= 20_000
    || (index === -1 ? entry !== null : !entry || entry.kind !== 'file')) {
    throw new Error('Bank entry has no bounded capture authority.');
  }
  const sqlite = getSqlite();
  sqlite.transaction(() => {
    const current = readGeneratedOutputResource(resource.resourceId);
    if (!current || current.version !== resource.version || current.bankCapture?.state !== 'capturing'
      || current.bankCapture.operationId !== resource.bankCapture!.operationId) {
      throw new Error('Bank entry lost its current capture authority.');
    }
    const key = [resource.resourceId, resource.bankCapture!.operationId, index];
    const prior = sqlite.prepare(`SELECT phase, receipt_json, entry_json, observed_closed
      FROM workspace_generated_output_bank_entries WHERE resource_id = ? AND capture_id = ? AND entry_index = ?`)
      .get(...key) as Row | undefined;
    const order: Phase[] = ['planned', 'ready', 'prepared', 'written', 'complete'];
    if (phase !== order[prior ? order.indexOf(prior.phase) + 1 : 0]
      || (prior && prior.entry_json !== JSON.stringify(entry))) throw new Error('Bank entry journal sequence changed.');
    if (phase !== 'planned') {
      if (!receipt || !Number.isSafeInteger(receipt.pid) || receipt.pid <= 0 || !receipt.processIdentity) {
        throw new Error('Bank entry has no native child birth receipt.');
      }
      const previous = prior?.receipt_json ? JSON.parse(prior.receipt_json) as BankWriteReceipt : null;
      if (previous && (previous.pid !== receipt.pid
        || JSON.stringify(previous.processIdentity) !== JSON.stringify(receipt.processIdentity)
        || (previous.device !== undefined && (previous.device !== receipt.device || previous.inode !== receipt.inode)))) {
        throw new Error('Bank entry child or inode identity changed.');
      }
      if (phase === 'complete' && prior!.receipt_json !== JSON.stringify(receipt)) {
        throw new Error('Bank entry close receipt differs from its written content.');
      }
    }
    const payload = receipt ? JSON.stringify(receipt) : null;
    if (!prior) {
      sqlite.prepare(`INSERT INTO workspace_generated_output_bank_entries
        (resource_id, capture_id, entry_index, entry_json, phase, receipt_json, observed_closed, exit_code)
        VALUES (?, ?, ?, ?, 'planned', NULL, 0, NULL)`).run(...key, JSON.stringify(entry));
    } else {
      const result = sqlite.prepare(`UPDATE workspace_generated_output_bank_entries
        SET phase = ?, receipt_json = ?, observed_closed = ?, exit_code = ?
        WHERE resource_id = ? AND capture_id = ? AND entry_index = ? AND phase = ?`)
        .run(phase, payload, phase === 'complete' ? 1 : 0, phase === 'complete' ? 0 : null, ...key, prior.phase);
      if (result.changes !== 1) throw new Error('Bank entry lost its trusted journal CAS.');
    }
  }).immediate();
}
