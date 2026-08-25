import { execFileSync } from 'node:child_process';
import path from 'node:path';

import { apiFetch, CliError, EXIT } from '../api.js';
import { resolveConfig } from '../config.js';
import { printHumanHeading, printHumanKv, printJson, type OutputMode } from '../output.js';

interface PresenceAgent {
  agentId: string;
  name: string;
  repo: string;
  worktreePath: string | null;
  runtime: string;
  sessionKey: string | null;
  lastSeen: string;
}

interface AgentMessage {
  id: string;
  from: string;
  to: string;
  repo: string;
  text: string;
  delivery: string;
  deliveryNote: string | null;
  timestamp: string;
}

function flag(rest: string[], name: string): string | null {
  const index = rest.indexOf(name);
  if (index < 0) return null;
  const value = rest[index + 1];
  if (!value || value.startsWith('--')) {
    throw new CliError('invalid_args', `${name} requires a value.`, EXIT.INVALID_ARGS);
  }
  return value;
}

function positionals(rest: string[], valueFlags: ReadonlySet<string>): string[] {
  const values: string[] = [];
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];
    if (valueFlags.has(value)) {
      index += 1;
      continue;
    }
    if (!value.startsWith('--')) values.push(value);
  }
  return values;
}

function runtimeLabel(): string {
  const explicit = process.env.AI_AGENT?.trim();
  if (explicit) return explicit.split('_')[0] || explicit;
  if (process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDECODE) return 'claude-code';
  if (process.env.CODEX_THREAD_ID || process.env.CODEX_SESSION_ID || process.env.CODEX_HOME) return 'codex';
  return 'poll';
}

function rawSessionKey(): string | null {
  return process.env.CLAUDE_CODE_SESSION_ID
    || process.env.CODEX_THREAD_ID
    || process.env.CODEX_SESSION_ID
    || null;
}

function sessionKey(): string | null {
  const raw = rawSessionKey();
  if (!raw) return null;
  const runtime = runtimeLabel();
  return raw.startsWith(`${runtime}:`) ? raw : `${runtime}:${raw}`;
}

function agentId(): string {
  const session = sessionKey();
  if (session) return `session:${session}`;
  const terminal = process.env.TERM_SESSION_ID?.trim();
  return terminal ? `terminal:${terminal}` : `process:${process.ppid || process.pid}`;
}

function gitOutput(args: string[]): string {
  try {
    return execFileSync('git', args, {
      windowsHide: true,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    throw new CliError(
      'repo_not_found',
      'This command must run inside a Git repository, or pass --repo.',
      EXIT.NOT_FOUND,
    );
  }
}

function repoContext(explicitRepo: string | null): { repo: string; worktreePath: string } {
  const worktreePath = explicitRepo ? path.resolve(explicitRepo) : gitOutput(['rev-parse', '--show-toplevel']);
  if (explicitRepo) return { repo: worktreePath, worktreePath };
  const commonDir = gitOutput(['rev-parse', '--path-format=absolute', '--git-common-dir']);
  return {
    repo: path.basename(commonDir) === '.git' ? path.dirname(commonDir) : worktreePath,
    worktreePath,
  };
}

function rejectUnknownFlags(rest: string[], allowed: ReadonlySet<string>): void {
  const unknown = rest.find((value) => value.startsWith('--') && !allowed.has(value));
  if (unknown) throw new CliError('unknown_flag', `Unknown flag: ${unknown}`, EXIT.INVALID_ARGS);
}

async function joinCurrentSession(
  context: { repo: string; worktreePath: string },
): Promise<void> {
  const cfg = resolveConfig();
  await apiFetch(cfg, '/api/agents/presence', {
    method: 'POST',
    body: {
      automatic: true,
      agentId: agentId(),
      repo: context.repo,
      worktreePath: context.worktreePath,
      runtime: runtimeLabel(),
      sessionKey: sessionKey(),
    },
  });
}

export async function runPresence(
  mode: OutputMode,
  action: string | undefined,
  rest: string[],
): Promise<number> {
  if (action === 'list') {
    const allowed = new Set(['--repo']);
    rejectUnknownFlags(rest, allowed);
    if (positionals(rest, allowed).length > 0) {
      throw new CliError('invalid_args', 'Presence list accepts flags only.', EXIT.INVALID_ARGS);
    }
    const context = repoContext(flag(rest, '--repo'));
    await joinCurrentSession(context);
    const cfg = resolveConfig();
    const response = await apiFetch<{ agents: PresenceAgent[] }>(cfg, '/api/agents/presence', {
      query: { repo: context.repo },
    });
    if (!response.data) throw new CliError('invalid_response', 'Presence list returned no data.', EXIT.INVALID_ARGS);
    const output = { schema: 'o8/cli/presence.list/v1', ok: true, agents: response.data.agents };
    if (mode.human) {
      printHumanHeading('live agent presence');
      if (output.agents.length === 0) process.stdout.write('No live agents.\n');
      for (const agent of output.agents) {
        process.stdout.write(`${agent.name}  ${agent.runtime}  ${agent.worktreePath ?? agent.repo}\n`);
      }
    } else {
      printJson(output);
    }
    return EXIT.OK;
  }
  if (action !== 'join') {
    throw new CliError(
      'unknown_presence_subcommand',
      `Unknown presence subcommand: ${action ?? '(none)'}`,
      EXIT.INVALID_ARGS,
      'Use `o8 presence list` or `o8 presence join --as <agent>`.',
    );
  }
  const allowed = new Set(['--as', '--repo', '--runtime', '--session']);
  rejectUnknownFlags(rest, allowed);
  const name = flag(rest, '--as');
  if (!name || positionals(rest, allowed).length > 0) {
    throw new CliError('invalid_args', 'Presence join requires --as <agent>.', EXIT.INVALID_ARGS);
  }
  const context = repoContext(flag(rest, '--repo'));
  const cfg = resolveConfig();
  const response = await apiFetch<{ ok: true; agent: PresenceAgent }>(cfg, '/api/agents/presence', {
    method: 'POST',
    body: {
      agentId: agentId(),
      name,
      repo: context.repo,
      worktreePath: context.worktreePath,
      runtime: flag(rest, '--runtime') ?? runtimeLabel(),
      sessionKey: flag(rest, '--session') ?? sessionKey(),
    },
  });
  if (!response.data) throw new CliError('invalid_response', 'Presence join returned no data.', EXIT.INVALID_ARGS);
  const output = { schema: 'o8/cli/presence.join/v1', ok: true, agent: response.data.agent };
  if (mode.human) {
    printHumanHeading('agent presence');
    printHumanKv([
      ['agent', output.agent.name],
      ['runtime', output.agent.runtime],
      ['repo', output.agent.repo],
      ['worktree', output.agent.worktreePath ?? '(none)'],
    ]);
  } else {
    printJson(output);
  }
  return EXIT.OK;
}

export async function runMsg(
  mode: OutputMode,
  action: string | undefined,
  rest: string[],
): Promise<number> {
  const cfg = resolveConfig();
  if (action === 'send') {
    const allowed = new Set(['--to', '--repo', '--from']);
    rejectUnknownFlags(rest, allowed);
    const to = flag(rest, '--to');
    const textArgs = positionals(rest, allowed);
    if (!to || textArgs.length !== 1) {
      throw new CliError(
        'invalid_args',
        'Message send requires --to <agent> and one text argument.',
        EXIT.INVALID_ARGS,
      );
    }
    const context = repoContext(flag(rest, '--repo'));
    await joinCurrentSession(context);
    const response = await apiFetch<{ ok: true; message: AgentMessage }>(cfg, '/api/agents/message', {
      method: 'POST',
      body: {
        fromAgentId: agentId(),
        from: flag(rest, '--from') ?? undefined,
        to,
        repo: context.repo,
        text: textArgs[0],
      },
    });
    if (!response.data) throw new CliError('invalid_response', 'Message send returned no data.', EXIT.INVALID_ARGS);
    const output = { schema: 'o8/cli/msg.send/v1', ok: true, message: response.data.message };
    if (mode.human) {
      printHumanHeading('agent message');
      printHumanKv([
        ['id', output.message.id],
        ['to', output.message.to],
        ['delivery', output.message.delivery],
      ]);
    } else {
      printJson(output);
    }
    return EXIT.OK;
  }
  if (action === 'inbox') {
    const allowed = new Set(['--agent', '--cursor', '--limit', '--repo']);
    rejectUnknownFlags(rest, allowed);
    if (positionals(rest, allowed).length > 0) {
      throw new CliError('invalid_args', 'Message inbox accepts flags only.', EXIT.INVALID_ARGS);
    }
    const namedAgent = flag(rest, '--agent');
    if (!namedAgent) await joinCurrentSession(repoContext(flag(rest, '--repo')));
    const response = await apiFetch<{
      agent: PresenceAgent;
      messages: AgentMessage[];
      cursor: string;
      hasMore: boolean;
    }>(cfg, '/api/agents/inbox', {
      query: {
        agent: namedAgent ?? undefined,
        agentId: namedAgent ? undefined : agentId(),
        cursor: flag(rest, '--cursor') ?? undefined,
        limit: flag(rest, '--limit') ?? undefined,
      },
    });
    if (!response.data) throw new CliError('invalid_response', 'Message inbox returned no data.', EXIT.INVALID_ARGS);
    const output = { schema: 'o8/cli/msg.inbox/v1', ...response.data };
    if (mode.human) {
      printHumanHeading(`messages for ${output.agent.name}`);
      if (output.messages.length === 0) process.stdout.write('No messages.\n');
      for (const message of output.messages) {
        process.stdout.write(`${message.timestamp}  ${message.from}: ${message.text}\n`);
      }
      process.stdout.write(`cursor  ${output.cursor}\n`);
    } else {
      printJson(output);
    }
    return EXIT.OK;
  }
  throw new CliError(
    'unknown_msg_subcommand',
    `Unknown msg subcommand: ${action ?? '(none)'}`,
    EXIT.INVALID_ARGS,
    'Use `o8 msg send --to <agent> "<text>"` or `o8 msg inbox`.',
  );
}
