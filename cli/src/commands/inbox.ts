/**
 * `o8 inbox list | approve | reject` — the governance approval queue from the CLI.
 *
 * CLI-as-control-plane symmetry (Stage 6). Thin clients of the
 * gated /api/panel/approvals route — the same queue the o8_approve / o8_reject
 * MCP tools resolve and the desktop inbox surfaces. This is where a worker-context
 * `o8 packet approve-merge` lands its card: the operator lists it here and
 * approves, which dispatches the held lane-merge continuation through the gate.
 *
 *   o8 inbox list [--all]          # pending approvals (--all includes resolved)
 *   o8 inbox approve <id>          # approve → runs the deferred action (e.g. merge)
 *   o8 inbox reject  <id>          # reject → sends it back
 */

import { apiFetch, CliError, EXIT } from '../api.js';
import { resolveConfig } from '../config.js';
import {
  printHumanHeading,
  printHumanKv,
  printJson,
  type OutputMode,
} from '../output.js';

interface Approval {
  id: string;
  title?: string;
  risk?: string;
  status?: string;
  createdAt?: string | number;
  sessionKey?: string;
}

function firstPositional(rest: string[]): string | null {
  const tok = rest.find((t) => !t.startsWith('-'));
  return tok?.trim() || null;
}

async function runInboxList(mode: OutputMode, rest: string[]): Promise<number> {
  const cfg = resolveConfig();
  const all = rest.includes('--all');
  const res = await apiFetch<{ approvals?: Approval[] }>(cfg, '/api/panel/approvals', {
    query: { status: all ? 'all' : 'pending' },
  });
  const approvals = res.data?.approvals ?? [];
  const payload = { schema: 'o8/cli/inbox.list/v1', count: approvals.length, approvals };
  if (mode.human) {
    printHumanHeading(`inbox (${approvals.length} ${all ? 'total' : 'pending'})`);
    if (approvals.length === 0) {
      printHumanKv([['', '(no approvals)']]);
    } else {
      printHumanKv(approvals.map((a) => [a.id, `${a.risk ?? '?'} · ${a.status ?? 'pending'} · ${a.title ?? ''}`] as [string, string]));
    }
  } else {
    printJson(payload);
  }
  return 0;
}

async function resolveApproval(mode: OutputMode, rest: string[], action: 'approve' | 'reject'): Promise<number> {
  const id = firstPositional(rest);
  if (!id) {
    throw new CliError(
      'invalid_args',
      `o8 inbox ${action} requires an approval id.`,
      EXIT.INVALID_ARGS,
      'Run `o8 inbox list` to see pending approval ids.',
    );
  }
  const cfg = resolveConfig();
  const res = await apiFetch<Record<string, unknown>>(cfg, '/api/panel/approvals', {
    method: 'POST',
    body: { action, id },
  });
  const data = res.data ?? {};
  const note = typeof data.decisionNote === 'string'
    ? data.decisionNote
    : typeof data.note === 'string' ? data.note : (action === 'approve' ? 'Approved.' : 'Denied.');
  const payload = { schema: `o8/cli/inbox.${action}/v1`, id, note, result: data };
  if (mode.human) {
    printHumanHeading(`inbox ${action}`);
    printHumanKv([['approval', id], ['action', action], ['note', note]]);
  } else {
    printJson(payload);
  }
  return 0;
}

export async function runInbox(mode: OutputMode, secondary: string | undefined, rest: string[]): Promise<number> {
  switch (secondary) {
    case 'list':
      return runInboxList(mode, rest);
    case 'approve':
      return resolveApproval(mode, rest, 'approve');
    case 'reject':
      return resolveApproval(mode, rest, 'reject');
    default:
      throw new CliError(
        'unknown_inbox_subcommand',
        `Unknown inbox subcommand: ${secondary ?? '(none)'}`,
        EXIT.INVALID_ARGS,
        'Subcommands: list | approve | reject. Run `o8 --help`.',
      );
  }
}
