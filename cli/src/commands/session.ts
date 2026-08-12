import { randomUUID } from 'node:crypto';

import { apiFetch, CliError, EXIT, SLOW_MUTATION_TIMEOUT_MS } from '../api.js';
import { resolveConfig } from '../config.js';
import { printHumanHeading, printHumanKv, printJson, type OutputMode } from '../output.js';
import { fetchCorrelatedPacketMutation } from './packet/correlated-mutation.js';

type SessionTransformAction = 'import' | 'checkpoint' | 'fork' | 'rewind';

interface TransformState {
  runtimeId: string;
  sessionKey: string | null;
  capabilities: Record<SessionTransformAction, { supported: boolean; reason?: string }>;
  catalogVersion: number;
  pendingTransform: {
    id: string;
    action: 'fork' | 'rewind';
    phase: 'provider_started';
    manualResolutionRequired: boolean;
  } | null;
  catalogSession: { sessionKey: string; ownership: string; provenance: string } | null;
  checkpoints: Array<{ id: string; createdAt: string; headSha: string | null }>;
  receipts: Array<Record<string, unknown>>;
}

interface SessionArgs {
  sessionKey: string;
  runtimeId: string;
  checkpointId?: string;
  message?: string;
  confirmNoContinuation: boolean;
}

function runtimeFromSessionKey(sessionKey: string) {
  if (sessionKey.startsWith('codex-discovered:') || sessionKey.startsWith('codex-owned:')) return 'codex';
  const owned = sessionKey.match(/^(.+?)-owned:/)?.[1];
  if (owned) return owned;
  return sessionKey.split(':')[0] || '';
}

function parseSessionArgs(rest: string[]): SessionArgs {
  let sessionKey = '';
  let runtimeId = '';
  let checkpointId: string | undefined;
  let message: string | undefined;
  let confirmNoContinuation = false;
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index]!;
    if (token === '--runtime') runtimeId = rest[++index]?.trim() ?? '';
    else if (token.startsWith('--runtime=')) runtimeId = token.slice('--runtime='.length).trim();
    else if (token === '--checkpoint') checkpointId = rest[++index]?.trim();
    else if (token.startsWith('--checkpoint=')) checkpointId = token.slice('--checkpoint='.length).trim();
    else if (token === '--message') message = rest[++index]?.trim();
    else if (token.startsWith('--message=')) message = token.slice('--message='.length).trim();
    else if (token === '--confirm-no-continuation') confirmNoContinuation = true;
    else if (!token.startsWith('-') && !sessionKey) sessionKey = token.trim();
    else throw new CliError('invalid_args', `Unknown session argument: ${token}`, EXIT.INVALID_ARGS);
  }
  if (!sessionKey) {
    throw new CliError(
      'invalid_args',
      'A provider session key is required.',
      EXIT.INVALID_ARGS,
      'Usage: o8 session import|checkpoint|fork|rewind|show|resume <session-key> [--runtime <id>]',
    );
  }
  runtimeId ||= runtimeFromSessionKey(sessionKey);
  if (!runtimeId) throw new CliError('invalid_args', 'Unable to infer runtime; pass --runtime <id>.', EXIT.INVALID_ARGS);
  return { sessionKey, runtimeId, checkpointId, message, confirmNoContinuation };
}

async function readState(args: SessionArgs) {
  const cfg = resolveConfig();
  const response = await apiFetch<TransformState>(cfg, '/api/runtime/session-transform', {
    query: { runtimeId: args.runtimeId, sessionKey: args.sessionKey },
  });
  if (!response.data) throw new CliError('invalid_response', 'Session state response was empty.', EXIT.INVALID_ARGS);
  return response.data;
}

async function requestSessionMutation(
  body: Record<string, unknown>,
 ) {
  const cfg = resolveConfig();
  return fetchCorrelatedPacketMutation<{
    ok: boolean;
    result?: { inProgress?: boolean; status?: string; note?: string } | null;
    [key: string]: unknown;
  }>(
    cfg,
    '/api/runtime/session-transform',
    body,
    { timeoutMs: SLOW_MUTATION_TIMEOUT_MS, pollMs: 500 },
  );
}

function printState(mode: OutputMode, state: TransformState) {
  const payload = { schema: 'o8/cli/session.show/v1', ...state };
  if (!mode.human) {
    printJson(payload);
    return;
  }
  printHumanHeading('session control');
  printHumanKv([
    ['session', state.sessionKey ?? '(runtime-wide)'],
    ['runtime', state.runtimeId],
    ['catalog version', String(state.catalogVersion)],
    ['cataloged', state.catalogSession ? 'yes' : 'no'],
    ['checkpoints', String(state.checkpoints.length)],
    ['pending transform', state.pendingTransform?.phase ?? 'none'],
  ]);
  for (const [action, capability] of Object.entries(state.capabilities)) {
    process.stdout.write(`  ${action.padEnd(12)} ${capability.supported ? 'available' : capability.reason ?? 'unavailable'}\n`);
  }
}

async function runDismissPending(mode: OutputMode, rest: string[]) {
  const args = parseSessionArgs(rest);
  if (!args.confirmNoContinuation) {
    throw new CliError(
      'confirmation_required',
      'Inspect the provider first, then pass --confirm-no-continuation only when no fork was created.',
      EXIT.INVALID_ARGS,
    );
  }
  const state = await readState(args);
  if (!state.pendingTransform?.manualResolutionRequired) {
    throw new CliError('not_found', 'No unresolved provider attempt requires manual dismissal.', EXIT.NOT_FOUND);
  }
  const response = await requestSessionMutation({
    action: 'dismiss_pending',
    runtimeId: args.runtimeId,
    sessionKey: args.sessionKey,
    intentId: state.pendingTransform.id,
    providerOutcome: 'no_continuation',
    expectedCatalogVersion: state.catalogVersion,
    clientMutationId: randomUUID(),
  });
  const payload = { schema: 'o8/cli/session.dismiss-pending/v1', ...response.data };
  if (!mode.human) printJson(payload);
  else {
    printHumanHeading('session pending transform');
    printHumanKv([
      ['session', args.sessionKey],
      ['note', String(response.data?.note ?? 'Pending attempt cleared.')],
    ]);
  }
  return 0;
}

async function runTransform(mode: OutputMode, action: SessionTransformAction, rest: string[]) {
  const args = parseSessionArgs(rest);
  const state = await readState(args);
  const capability = state.capabilities[action];
  if (!capability?.supported) {
    throw new CliError('unsupported', capability?.reason ?? `${action} is unavailable.`, EXIT.INVALID_ARGS);
  }
  const checkpointId = action === 'fork' || action === 'rewind'
    ? args.checkpointId ?? state.checkpoints.at(-1)?.id
    : undefined;
  if ((action === 'fork' || action === 'rewind') && !checkpointId) {
    throw new CliError(
      'checkpoint_required',
      `${action} requires a saved checkpoint.`,
      EXIT.INVALID_ARGS,
      `Run \`o8 session checkpoint ${args.sessionKey}\` first.`,
    );
  }
  const response = await requestSessionMutation({
    action,
    runtimeId: args.runtimeId,
    sessionKey: args.sessionKey,
    checkpointId,
    expectedCatalogVersion: state.catalogVersion,
    clientMutationId: randomUUID(),
  });
  const payload = { schema: `o8/cli/session.${action}/v1`, ...response.data };
  if (!mode.human) printJson(payload);
  else {
    printHumanHeading(`session ${action}`);
    printHumanKv([
      ['session', args.sessionKey],
      ['result', String(response.data?.resultingSessionKey ?? args.sessionKey)],
      ['checkpoint', String(response.data?.checkpointId ?? '(none)')],
      ['note', String(response.data?.note ?? `${action} completed.`)],
    ]);
  }
  return 0;
}

async function runResume(mode: OutputMode, rest: string[]) {
  const args = parseSessionArgs(rest);
  if (!args.message) {
    throw new CliError('invalid_args', 'Session resume requires --message <text>.', EXIT.INVALID_ARGS);
  }
  const cfg = resolveConfig();
  const body = {
    action: 'send_input',
    surfaceId: args.sessionKey,
    clientMutationId: randomUUID(),
    message: args.message,
  };
  const response = await fetchCorrelatedPacketMutation<Record<string, unknown>>(
    cfg,
    '/api/runtime/action',
    body,
  );
  const payload = { schema: 'o8/cli/session.resume/v1', ...response.data };
  if (!mode.human) printJson(payload);
  else {
    printHumanHeading('session resume');
    printHumanKv([
      ['session', args.sessionKey],
      ['note', String(response.data?.note ?? 'Resume sent.')],
    ]);
  }
  return 0;
}

export async function runSession(
  mode: OutputMode,
  secondary: string | undefined,
  rest: string[],
): Promise<number> {
  if (secondary === 'show' || secondary === 'capabilities') {
    printState(mode, await readState(parseSessionArgs(rest)));
    return 0;
  }
  if (secondary === 'resume') return runResume(mode, rest);
  if (secondary === 'dismiss-pending') return runDismissPending(mode, rest);
  if (secondary === 'import' || secondary === 'checkpoint' || secondary === 'fork' || secondary === 'rewind') {
    return runTransform(mode, secondary, rest);
  }
  throw new CliError(
    'unknown_session_subcommand',
    `Unknown session subcommand: ${secondary ?? '(none)'}`,
    EXIT.INVALID_ARGS,
    'Subcommands: show | import | checkpoint | fork | rewind | resume | dismiss-pending.',
  );
}
