import { latestBroadcastAttentionReceipt } from '@/lib/broadcast/attention-ledger';
import { broadcastNoStore, requireBroadcastOperator } from '@/lib/broadcast/route-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(request: Request) {
  const denied = requireBroadcastOperator(request);
  if (denied) return denied;
  const receipt = latestBroadcastAttentionReceipt();
  return broadcastNoStore({
    schema: 'o8/broadcast.attention-why/v1',
    receipt,
    note: receipt
      ? undefined
      : 'Symon has no successfully heard proactive update in the durable attention ledger yet.',
  });
}
