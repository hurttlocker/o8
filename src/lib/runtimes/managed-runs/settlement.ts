import type { ManagedRunRecord } from './types';
export { parseSettlementBinding, settlementBindingDigest, validProviderSessionId } from './settlement-contract.mjs';

export function externalSettlementQuiet(record: ManagedRunRecord): boolean {
  const settlement = record.settlement;
  if (!settlement) return true;
  const receipt = settlement.receipt;
  return receipt?.state === 'quiet'
    && receipt.bindingDigest === settlement.bindingDigest
    && receipt.receiptId === settlement.binding.receiptId
    && receipt.providerSessionId === settlement.providerSessionId
    && (settlement.providerSessionId !== null || receipt.cancelledBeforeLaunch)
    && (!settlement.stopRequestId || receipt.stopRequestId === settlement.stopRequestId);
}
