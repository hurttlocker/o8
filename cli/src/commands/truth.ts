import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { apiFetch, CliError, EXIT } from '../api.js';
import { resolveTruthConfig } from '../config.js';
import { printHumanHeading, printHumanKv, printJson, type OutputMode } from '../output.js';
import type { PacketReceipt } from '../../../src/lib/receipts/types.js';

type TruthCliQuery =
  | { kind: 'merged-since'; repo: string; since: string }
  | { kind: 'packet'; packetId?: string; issueNumber?: number }
  | { kind: 'approvals'; packetId: string };

interface TruthAnswerPayload {
  summary: string;
  receipt: PacketReceipt;
  rawReceiptJson: string;
  artifactId: string;
}

interface TruthRoutePayload {
  query: TruthCliQuery;
  answers: TruthAnswerPayload[];
  asOf: string;
  nextCursor: string | null;
}

export interface ParsedTruthArguments {
  query: TruthCliQuery;
  saveReceiptsDir: string | null;
}

const DURATION_PATTERN = /^(\d+(?:\.\d+)?)(s|m|h|d|w)$/i;
const VALUE_FLAGS = new Set(['--repo', '--since', '--save-receipts']);

function invalid(message: string): never {
  throw new CliError('invalid_args', message, EXIT.INVALID_ARGS);
}

function parseValues(rest: string[]): { values: Map<string, string>; positionals: string[] } {
  const values = new Map<string, string>();
  const positionals: string[] = [];
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index]!;
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }
    const separator = token.indexOf('=');
    const flag = separator >= 0 ? token.slice(0, separator) : token;
    if (!VALUE_FLAGS.has(flag)) invalid(`Unknown o8 truth flag: ${flag}.`);
    const value = separator >= 0 ? token.slice(separator + 1) : rest[++index];
    if (!value || value.startsWith('--')) invalid(`${flag} requires a value.`);
    if (values.has(flag)) invalid(`${flag} may be supplied only once.`);
    values.set(flag, value);
  }
  return { values, positionals };
}

export function parseTruthSince(value: string, nowMs = Date.now()): string {
  const trimmed = value.trim();
  const duration = trimmed.match(DURATION_PATTERN);
  if (duration) {
    const amount = Number(duration[1]);
    const unit = duration[2]!.toLowerCase();
    const multiplier = unit === 'w'
      ? 7 * 24 * 60 * 60 * 1000
      : unit === 'd'
        ? 24 * 60 * 60 * 1000
        : unit === 'h'
          ? 60 * 60 * 1000
          : unit === 'm' ? 60 * 1000 : 1000;
    const timestamp = nowMs - amount * multiplier;
    if (!Number.isFinite(timestamp)) invalid('Truth query duration is outside the supported date range.');
    return new Date(timestamp).toISOString();
  }
  const timestamp = Date.parse(trimmed);
  if (!Number.isFinite(timestamp)) {
    invalid('--since must be an ISO timestamp or a duration such as 30m, 24h, or 7d.');
  }
  return new Date(timestamp).toISOString();
}

export function parseTruthArguments(
  subcommand: string | undefined,
  rest: string[],
  nowMs = Date.now(),
): ParsedTruthArguments {
  const { values, positionals } = parseValues(rest);
  const saveReceiptsDir = values.get('--save-receipts')?.trim() || null;
  if (subcommand === 'merged') {
    if (positionals.length > 0) invalid('o8 truth merged accepts no positional arguments.');
    const repo = values.get('--repo')?.trim() ?? '';
    const since = values.get('--since')?.trim() ?? '';
    if (!repo || !since) invalid('Use `o8 truth merged --repo <name|remote> --since <iso|duration>`.');
    return {
      query: { kind: 'merged-since', repo, since: parseTruthSince(since, nowMs) },
      saveReceiptsDir,
    };
  }
  if (values.has('--repo') || values.has('--since')) {
    invalid('--repo and --since are valid only for `o8 truth merged`.');
  }
  if (subcommand === 'packet') {
    if (positionals.length !== 1) invalid('Use `o8 truth packet <packetId|#issue>`.');
    const target = positionals[0]!.trim();
    const issueMatch = target.match(/^#([1-9]\d*)$/);
    return {
      query: issueMatch
        ? { kind: 'packet', issueNumber: Number(issueMatch[1]) }
        : { kind: 'packet', packetId: target },
      saveReceiptsDir,
    };
  }
  if (subcommand === 'approvals') {
    if (positionals.length !== 1 || !positionals[0]!.trim()) {
      invalid('Use `o8 truth approvals <packetId>`.');
    }
    return {
      query: { kind: 'approvals', packetId: positionals[0]!.trim() },
      saveReceiptsDir,
    };
  }
  invalid('Use `o8 truth merged|packet|approvals ...`.');
}

function routeQuery(query: TruthCliQuery): Record<string, string | number> {
  if (query.kind === 'merged-since') {
    return { kind: query.kind, repo: query.repo, since: query.since };
  }
  if (query.kind === 'packet') {
    return query.issueNumber === undefined
      ? { kind: query.kind, packetId: query.packetId ?? '' }
      : { kind: query.kind, issueNumber: query.issueNumber };
  }
  return { kind: query.kind, packetId: query.packetId };
}

function shellArg(value: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(value)
    ? value
    : `'${value.replaceAll("'", "'\\''")}'`;
}

function saveReceipt(answer: TruthAnswerPayload, directory: string): {
  savedReceiptPath: string;
  verifyCommand: string;
} {
  const outputDir = resolve(directory);
  mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  const outputPath = join(outputDir, `${encodeURIComponent(answer.receipt.receiptId)}.json`);
  try {
    writeFileSync(outputPath, answer.rawReceiptJson, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
  } catch (error) {
    throw new CliError(
      'receipt_write_failed',
      `Unable to write ${outputPath}: ${error instanceof Error ? error.message : String(error)}`,
      EXIT.CONFLICT,
      'Use an empty --save-receipts directory. Existing receipt files are never overwritten.',
    );
  }
  return { savedReceiptPath: outputPath, verifyCommand: `o8 verify ${shellArg(outputPath)}` };
}

function dispositionLine(receipt: PacketReceipt): string {
  return receipt.disposition.kind === 'merged'
    ? `merged · ${receipt.disposition.mergeCommit}`
    : `discarded · ${receipt.disposition.disposition}`;
}

export async function runTruth(
  mode: OutputMode,
  subcommand: string | undefined,
  rest: string[],
): Promise<number> {
  const parsed = parseTruthArguments(subcommand, rest);
  const response = await apiFetch<TruthRoutePayload>(
    resolveTruthConfig(),
    '/api/orchestrator/truth',
    { query: routeQuery(parsed.query) },
  );
  if (!response.data) {
    throw new CliError('truth_response_missing', 'Truth route returned no result.', EXIT.CONFLICT);
  }
  const saved = response.data.answers.map((answer) => parsed.saveReceiptsDir
    ? { ...answer, ...saveReceipt(answer, parsed.saveReceiptsDir) }
    : answer);

  if (mode.human) {
    printHumanHeading('truth query');
    printHumanKv([
      ['query', response.data.query.kind],
      ['answers', String(saved.length)],
      ['as of', response.data.asOf],
    ]);
    if (saved.length === 0) process.stdout.write('No signed answers recorded.\n');
    for (const answer of saved) {
      process.stdout.write('\n');
      printHumanKv([
        ['receipt', answer.receipt.receiptId],
        ['disposition', dispositionLine(answer.receipt)],
        ['summary', answer.summary],
        ...('verifyCommand' in answer
          ? [['verify', answer.verifyCommand] as [string, string]]
          : []),
      ]);
    }
  } else {
    printJson({
      schema: 'o8/cli/truth.query/v1',
      ...response.data,
      answers: saved,
    });
  }
  return EXIT.OK;
}
