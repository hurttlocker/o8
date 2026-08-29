import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { apiFetch, CliError, EXIT } from '../../api.js';
import { resolveConfig } from '../../config.js';
import { printHumanHeading, printHumanKv, printJson, type OutputMode } from '../../output.js';
import type { PacketReceipt } from '../../../../src/lib/receipts/types.js';
import {
  parsePacketArguments,
  requirePacketId,
  resolvePacketTarget,
} from './target.js';

interface ReceiptRouteItem {
  id: string;
  relPath: string;
  bytes: number | null;
  createdAt: string;
  receipt: PacketReceipt;
}

interface ReceiptMutationResponse {
  ok: true;
  result: ReceiptRouteItem;
}

interface ReceiptListResponse {
  ok: true;
  result: {
    packetId: string;
    count: number;
    receipts: ReceiptRouteItem[];
  };
}

export async function runPacketReceipt(mode: OutputMode, rest: string[]): Promise<number> {
  const args = parsePacketArguments(rest, {
    command: 'receipt',
    valueFlags: ['out'],
  });
  const packetId = requirePacketId(await resolvePacketTarget(args.target), 'receipt');
  const response = await apiFetch<ReceiptMutationResponse>(
    resolveConfig(),
    '/api/orchestrator/receipts',
    { method: 'POST', body: { packetId } },
  );
  const result = response.data?.result;
  if (!result?.receipt) {
    throw new CliError('receipt_unavailable', 'Receipt route returned no receipt.', EXIT.CONFLICT);
  }
  const outputPath = resolve(args.values.out?.trim() || `${result.receipt.receiptId}.json`);
  try {
    writeFileSync(outputPath, `${JSON.stringify(result.receipt, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
  } catch (error) {
    throw new CliError(
      'receipt_write_failed',
      `Unable to write ${outputPath}: ${error instanceof Error ? error.message : String(error)}`,
      EXIT.CONFLICT,
      'Pass --out with a new path. Existing files are never overwritten.',
    );
  }

  if (mode.human) {
    printHumanHeading('packet receipt');
    printHumanKv([
      ['packet', packetId],
      ['receipt', result.receipt.receiptId],
      ['key id', result.receipt.keyId],
      ['disposition', result.receipt.disposition.kind],
      ['file', outputPath],
    ]);
  } else {
    printJson({
      schema: 'o8/cli/packet.receipt/v1',
      packetId,
      path: outputPath,
      artifact: {
        id: result.id,
        relPath: result.relPath,
        bytes: result.bytes,
        createdAt: result.createdAt,
      },
      receipt: result.receipt,
    });
  }
  return EXIT.OK;
}

export async function runPacketReceipts(mode: OutputMode, rest: string[]): Promise<number> {
  const args = parsePacketArguments(rest, { command: 'receipts' });
  const packetId = requirePacketId(await resolvePacketTarget(args.target), 'receipts');
  const response = await apiFetch<ReceiptListResponse>(
    resolveConfig(),
    '/api/orchestrator/receipts',
    { query: { packetId } },
  );
  const result = response.data?.result;
  if (!result) throw new CliError('receipt_list_failed', 'Receipt route returned no list.', EXIT.CONFLICT);

  if (mode.human) {
    printHumanHeading('packet receipts');
    if (result.receipts.length === 0) {
      process.stdout.write('No receipts recorded.\n');
    } else {
      for (const item of result.receipts) {
        printHumanKv([
          ['receipt', item.receipt.receiptId],
          ['disposition', item.receipt.disposition.kind],
          ['key id', item.receipt.keyId],
          ['created', item.receipt.createdAt],
          ['artifact', item.relPath],
        ]);
      }
    }
  } else {
    printJson({ schema: 'o8/cli/packet.receipts/v1', ...result });
  }
  return EXIT.OK;
}
