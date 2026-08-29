import { resolveReceiptPublicKey } from '@/lib/receipts/public-key';
import { verifyPacketReceiptFile } from '@/lib/receipts/verify-receipt';
import {
  apiFetch,
  errorText,
  jsonResult,
  optionalString,
  requiredString,
  textResult,
  type McpTool,
  type McpToolResult,
} from './shared';

export const RECEIPT_TOOLS: McpTool[] = [
  {
    name: 'o8_packet_receipt',
    description: 'Build, sign, and store the receipt for one merged or discarded packet from its persisted release/disposition records.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        packetId: { type: 'string', minLength: 1 },
      },
      required: ['packetId'],
    },
  },
  {
    name: 'o8_verify_receipt',
    description: 'Verify a packet receipt locally with an Ed25519 public key and, when repoPath is supplied, confirm the recorded merge commit tree.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        receiptPath: { type: 'string', minLength: 1 },
        key: { type: 'string', description: 'Base64 public key or path to a public-key file.' },
        repoPath: { type: 'string', description: 'Optional repository checkout for merge/tree verification.' },
        showKey: { type: 'boolean' },
      },
      required: ['receiptPath'],
    },
  },
];

export async function handlePacketReceipt(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    return jsonResult(await apiFetch('/api/orchestrator/receipts', {
      method: 'POST',
      body: JSON.stringify({ packetId: requiredString(args, 'packetId') }),
    }));
  } catch (error) {
    return textResult(`o8_packet_receipt failed: ${errorText(error)}`, true);
  }
}

export async function handleVerifyReceipt(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const key = resolveReceiptPublicKey(optionalString(args, 'key'));
    if (!key) throw new Error('No receipt public key was found. Supply key or publish receipt-public.key.');
    const verdict = await verifyPacketReceiptFile({
      receiptPath: requiredString(args, 'receiptPath'),
      publicKeyB64: key,
      repoPath: optionalString(args, 'repoPath') || null,
    });
    return jsonResult({
      ...verdict,
      ...(args.showKey === true ? { publicKey: key } : {}),
    });
  } catch (error) {
    return textResult(`o8_verify_receipt failed: ${errorText(error)}`, true);
  }
}
