/**
 * `o8 artifact` — interactive task artifacts (#1699) from the agent side.
 *
 *   o8 artifact create --title "<t>" --html <file> --actions <file.json> [--packet <id> | --thread <id> --repo <path>] [--head-policy pinned|any]
 *   o8 artifact status <artifactId>
 *   o8 artifact receipts <artifactId>
 *
 * Inside a packet worktree the worker token pins the artifact to that packet;
 * no --packet is needed. The operator sees the artifact in the thread, edits
 * it, and its exact payload arrives as the next steer or message with a
 * receipt id.
 */
import { readFileSync } from 'node:fs';
import { apiFetch, CliError, EXIT } from '../api.js';
import { resolveConfig } from '../config.js';
import { printHumanHeading, printHumanKv, printJson, type OutputMode } from '../output.js';

interface CreateArgs {
  title: string | null;
  htmlPath: string | null;
  actionsPath: string | null;
  packetId: string | null;
  threadId: string | null;
  repoPath: string | null;
  headPolicy: 'pinned' | 'any';
}

function readFlag(rest: string[], flag: string): string | null {
  const index = rest.indexOf(flag);
  if (index === -1) return null;
  const value = rest[index + 1];
  if (!value || value.startsWith('--')) throw new CliError('invalid_args', `${flag} requires a value.`, EXIT.INVALID_ARGS);
  return value;
}

export function parseArtifactCreateArgs(rest: string[]): CreateArgs {
  const headPolicy = readFlag(rest, '--head-policy');
  if (headPolicy && headPolicy !== 'pinned' && headPolicy !== 'any') {
    throw new CliError('invalid_args', '--head-policy must be pinned or any.', EXIT.INVALID_ARGS);
  }
  return {
    title: readFlag(rest, '--title'),
    htmlPath: readFlag(rest, '--html'),
    actionsPath: readFlag(rest, '--actions'),
    packetId: readFlag(rest, '--packet'),
    threadId: readFlag(rest, '--thread'),
    repoPath: readFlag(rest, '--repo'),
    headPolicy: headPolicy === 'any' ? 'any' : 'pinned',
  };
}

interface ArtifactSummary {
  id: string;
  title: string;
  target: { kind: string; repoPath: string; threadId: string | null; packetId: string | null };
  originHead: string | null;
  actions: Array<{ name: string }>;
}

async function runCreate(mode: OutputMode, rest: string[]): Promise<number> {
  const args = parseArtifactCreateArgs(rest);
  if (!args.title) throw new CliError('invalid_args', '--title is required.', EXIT.INVALID_ARGS);
  if (!args.htmlPath) throw new CliError('invalid_args', '--html <file> is required.', EXIT.INVALID_ARGS);
  if (!args.actionsPath) throw new CliError('invalid_args', '--actions <file.json> is required.', EXIT.INVALID_ARGS);
  let html: string;
  let actions: unknown;
  try {
    html = readFileSync(args.htmlPath, 'utf8');
  } catch (error) {
    throw new CliError('invalid_args', `Could not read --html file: ${error instanceof Error ? error.message : String(error)}`, EXIT.INVALID_ARGS);
  }
  try {
    actions = JSON.parse(readFileSync(args.actionsPath, 'utf8'));
  } catch (error) {
    throw new CliError('invalid_args', `Could not parse --actions JSON: ${error instanceof Error ? error.message : String(error)}`, EXIT.INVALID_ARGS);
  }
  const cfg = resolveConfig();
  const body: Record<string, unknown> = { title: args.title, html, actions, headPolicy: args.headPolicy };
  if (args.packetId) body.packetId = args.packetId;
  if (args.threadId) { body.threadId = args.threadId; body.repoPath = args.repoPath; }
  if (!args.packetId && !args.threadId && !cfg.workerPacketId) {
    throw new CliError('invalid_args', 'Outside a packet worktree, pass --packet <id> or --thread <id> --repo <path>.', EXIT.INVALID_ARGS);
  }
  const res = await apiFetch<{ ok: boolean; result?: { artifact: ArtifactSummary }; error?: { message?: string } }>(cfg, '/api/task-artifacts', {
    method: 'POST',
    body,
  });
  const artifact = res.data?.result?.artifact;
  if (!res.data?.ok || !artifact) {
    throw new CliError('request_failed', res.data?.error?.message ?? 'The server did not accept the artifact.', EXIT.CONFLICT);
  }
  if (mode === 'json') {
    printJson({ ok: true, artifact });
  } else {
    printHumanHeading('artifact create');
    printHumanKv([
      ['id', artifact.id],
      ['title', artifact.title],
      ['target', artifact.target.kind === 'packet' ? `packet ${artifact.target.packetId}` : `thread ${artifact.target.threadId}`],
      ['head', artifact.originHead ? artifact.originHead.slice(0, 12) : 'unknown'],
      ['actions', artifact.actions.map((a) => a.name).join(', ')],
    ]);
    console.log('The operator sees it in the thread now. Its payload arrives as your next message with a receipt id.');
  }
  return EXIT.OK;
}

async function runRead(mode: OutputMode, rest: string[], kind: 'status' | 'receipts'): Promise<number> {
  const artifactId = rest.find((arg) => !arg.startsWith('--')) ?? null;
  if (!artifactId) throw new CliError('invalid_args', `artifact ${kind} <artifactId> is required.`, EXIT.INVALID_ARGS);
  const cfg = resolveConfig();
  const path = kind === 'status'
    ? `/api/task-artifacts/${encodeURIComponent(artifactId)}`
    : `/api/task-artifacts/${encodeURIComponent(artifactId)}/actions`;
  const res = await apiFetch<{ ok: boolean; result?: Record<string, unknown>; error?: { message?: string } }>(cfg, path, { allowNotFound: true });
  if (!res.data?.ok || !res.data.result) {
    throw new CliError('not_found', res.data?.error?.message ?? `Artifact ${artifactId} not found.`, EXIT.NOT_FOUND);
  }
  const result = res.data.result;
  if (kind === 'status' && result.artifact && typeof result.artifact === 'object') {
    const { html: _html, ...rest } = result.artifact as Record<string, unknown>;
    result.artifact = rest;
  }
  if (mode === 'json') {
    printJson({ ok: true, ...result });
    return EXIT.OK;
  }
  printHumanHeading(`artifact ${kind}`);
  if (kind === 'status') {
    const writability = result.writability as { writable: boolean; reason: string | null } | undefined;
    const lastAction = result.lastAction as { id: string; action: string; delivery: string } | null | undefined;
    printHumanKv([
      ['writable', writability ? String(writability.writable) : 'unknown'],
      ['reason', writability?.reason ?? '—'],
      ['accepted', String(result.acceptedActionCount ?? 0)],
      ['last', lastAction ? `${lastAction.id} ${lastAction.action} ${lastAction.delivery}` : '—'],
    ]);
  } else {
    const actions = (result.actions as Array<{ id: string; action: string; delivery: string; createdAt: string; deliveryNote: string | null }> | undefined) ?? [];
    if (actions.length === 0) console.log('No submissions yet.');
    for (const action of actions) {
      console.log(`${action.createdAt}  ${action.id}  ${action.action}  ${action.delivery}${action.deliveryNote ? `  ${action.deliveryNote}` : ''}`);
    }
  }
  return EXIT.OK;
}

export async function runArtifact(mode: OutputMode, secondary: string | null, rest: string[]): Promise<number> {
  switch (secondary) {
    case 'create':
      return runCreate(mode, rest);
    case 'status':
      return runRead(mode, rest, 'status');
    case 'receipts':
      return runRead(mode, rest, 'receipts');
    default:
      throw new CliError('invalid_args', 'Usage: o8 artifact create|status|receipts', EXIT.INVALID_ARGS);
  }
}
