/**
 * `o8 packet log <event> [--reason ...]` — append a structured event to the
 * lane history.
 *
 * CLI-PHASE1-TODO: there is no HTTP endpoint today for appending lane
 * events. `appendEvent()` is module-local in src/lib/lane/registry.ts and
 * the only POST-y lanes route is the command dispatcher (`POST /api/lanes`)
 * which expects a LaneCommand verb, not a free-form event verb.
 *
 * Per the Phase-1 scope (no new backend routes), this command stubs out
 * cleanly: it validates args, resolves the current packet (same logic as
 * `o8 packet info`) so the agent gets fast feedback that wiring is fine,
 * then exits 0 with a "not yet wired" notice. Phase 2 will add a
 * `POST /api/lanes/:id/events` route and replace this body.
 */

import { CliError, EXIT } from '../../api.js';
import { printJson, type OutputMode } from '../../output.js';

interface LogArgs {
  event: string | null;
  reason: string | null;
}

export function parseLogArgs(rest: string[]): LogArgs {
  let event: string | null = null;
  let reason: string | null = null;
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i];
    if (tok === '--reason') {
      reason = rest[++i] ?? null;
    } else if (tok.startsWith('--reason=')) {
      reason = tok.slice('--reason='.length);
    } else if (!event && !tok.startsWith('--')) {
      event = tok;
    }
  }
  return { event, reason };
}

export async function runPacketLog(mode: OutputMode, rest: string[]): Promise<number> {
  const { event, reason } = parseLogArgs(rest);
  if (!event) {
    throw new CliError(
      'invalid_args',
      'o8 packet log <event> [--reason ...] requires an event verb.',
      EXIT.INVALID_ARGS,
      'Example: o8 packet log lint_passed --reason "0 warnings"',
    );
  }

  const payload = {
    schema: 'o8/cli/packet.log/v1',
    accepted: false,
    notice: 'Phase 1: no HTTP endpoint for free-form lane events yet. Stubbed.',
    requested: { event, reason },
    nextStep:
      'Phase 2 will add POST /api/lanes/:id/events and wire this command. Track in epic #926.',
  };

  if (mode.human) {
    process.stdout.write(`(stub) would log event=${event}`);
    if (reason) process.stdout.write(` reason="${reason}"`);
    process.stdout.write(`\n  ${payload.notice}\n  ${payload.nextStep}\n`);
  } else {
    printJson(payload);
  }
  return 0;
}
