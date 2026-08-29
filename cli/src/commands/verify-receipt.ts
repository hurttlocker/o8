import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { CliError, EXIT } from '../api.js';
import { printHumanHeading, printHumanKv, printJson, type OutputMode } from '../output.js';
import { resolveReceiptPublicKey } from '../../../src/lib/receipts/public-key.js';
import {
  getReceiptIdentityPublicKey,
  receiptKeyIdForPublicKey,
} from '../../../src/lib/receipts/receipt-identity.js';
import { verifyPacketReceiptFile } from '../../../src/lib/receipts/verify-receipt.js';

interface VerifyReceiptArgs {
  receiptPath: string | null;
  key: string | null;
  repoPath: string | null;
  showKey: boolean;
}

function requireValue(rest: string[], index: number, flag: string): string {
  const value = rest[index + 1];
  if (!value || value.startsWith('-')) {
    throw new CliError('invalid_args', `${flag} requires a value.`, EXIT.INVALID_ARGS);
  }
  return value;
}

function parseVerifyReceiptArgs(rest: string[]): VerifyReceiptArgs {
  let receiptPath: string | null = null;
  let key: string | null = null;
  let repoPath: string | null = null;
  let showKey = false;
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === '--show-key') {
      showKey = true;
    } else if (token === '--key' || token === '--repo') {
      const value = requireValue(rest, index, token);
      index += 1;
      if (token === '--key') key = value;
      else repoPath = value;
    } else if (token.startsWith('-')) {
      throw new CliError('invalid_args', `Unknown o8 verify flag: ${token}.`, EXIT.INVALID_ARGS);
    } else if (!receiptPath) {
      receiptPath = token;
    } else {
      throw new CliError('invalid_args', `Unexpected o8 verify argument: ${token}.`, EXIT.INVALID_ARGS);
    }
  }
  return { receiptPath, key, repoPath, showKey };
}

function detectRepoPath(explicit: string | null): string | null {
  if (explicit) return resolve(explicit);
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || null;
  } catch {
    return null;
  }
}

export function isReceiptVerifyInvocation(rest: string[]): boolean {
  if (rest.includes('--show-key') || rest.includes('--key')) return true;
  const positional = rest.find((token) => !token.startsWith('-'));
  return Boolean(positional && (positional.endsWith('.json') || existsSync(positional)));
}

export async function runVerifyReceipt(mode: OutputMode, rest: string[]): Promise<number> {
  const args = parseVerifyReceiptArgs(rest);
  let publicKey = resolveReceiptPublicKey(args.key);
  if (!publicKey && args.showKey) publicKey = getReceiptIdentityPublicKey();
  if (!publicKey) {
    throw new CliError(
      'receipt_key_not_found',
      'No receipt public key was found.',
      EXIT.NOT_FOUND,
      'Supply --key <base64-or-path>, or run `o8 verify --show-key` on the signing machine.',
    );
  }
  const keyId = receiptKeyIdForPublicKey(publicKey);
  if (!args.receiptPath) {
    if (!args.showKey) {
      throw new CliError('invalid_args', 'o8 verify requires a receipt JSON file.', EXIT.INVALID_ARGS);
    }
    if (mode.human) {
      printHumanHeading('receipt public key');
      printHumanKv([['key id', keyId], ['public key', publicKey]]);
    } else {
      printJson({ schema: 'o8/cli/receipt.key/v1', keyId, publicKey });
    }
    return EXIT.OK;
  }

  const receiptPath = resolve(args.receiptPath);
  const verdict = await verifyPacketReceiptFile({
    receiptPath,
    publicKeyB64: publicKey,
    repoPath: detectRepoPath(args.repoPath),
  });
  if (mode.human) {
    printHumanHeading('receipt verification');
    printHumanKv([
      ['receipt', verdict.receiptId ?? receiptPath],
      ['signature', verdict.signatureValid ? 'valid' : 'invalid'],
      ['key id', verdict.keyIdMatches ? 'matches' : 'mismatch'],
      ['repository', verdict.repository.checked
        ? verdict.repository.treeMatches ? 'tree matches' : 'tree mismatch'
        : 'not checked'],
      ['verdict', verdict.ok ? 'accepted' : 'rejected'],
      ...(args.showKey ? [['public key', publicKey] as [string, string]] : []),
    ]);
    for (const error of verdict.errors) process.stdout.write(`error  ${error}\n`);
  } else {
    const { schema: receiptSchema, ...verdictBody } = verdict;
    printJson({
      schema: 'o8/cli/receipt.verify/v1',
      receiptSchema,
      receiptPath,
      ...verdictBody,
      ...(args.showKey ? { publicKey } : {}),
    });
  }
  return verdict.ok ? EXIT.OK : EXIT.CONFLICT;
}
