import {
  apiFetch,
  CliError,
  EXIT,
  openPacketTailSocket,
  type PacketTailEvent,
} from '../../api.js';
import { resolveConfig } from '../../config.js';
import {
  printHumanHeading,
  printJson,
  type OutputMode,
} from '../../output.js';

interface PacketTailBatch {
  schema: 'o8/packet.tail.batch/v1';
  packetId: string;
  events: PacketTailEvent[];
  nextSince: number;
}

interface PacketLogArgs {
  packetId: string;
  follow: boolean;
  ndjson: boolean;
  since: number;
}

function parseSince(raw: string | null): number {
  if (!raw) {
    throw new CliError('invalid_args', '--since requires a unix-ms value.', EXIT.INVALID_ARGS);
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new CliError('invalid_args', '--since must be a non-negative unix-ms value.', EXIT.INVALID_ARGS);
  }
  return Math.floor(parsed);
}

function parseLogArgs(rest: string[]): PacketLogArgs {
  let packetId = '';
  let follow = false;
  let ndjson = false;
  let since = 0;

  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i];
    if (tok === '--follow' || tok === '-f') {
      follow = true;
    } else if (tok === '--ndjson') {
      ndjson = true;
    } else if (tok === '--since') {
      since = parseSince(rest[++i] ?? null);
    } else if (tok.startsWith('--since=')) {
      since = parseSince(tok.slice('--since='.length));
    } else if (tok.startsWith('-')) {
      throw new CliError('invalid_args', `Unknown packet log flag: ${tok}`, EXIT.INVALID_ARGS);
    } else if (!packetId) {
      packetId = tok.trim();
    } else {
      throw new CliError('invalid_args', `Unexpected packet log argument: ${tok}`, EXIT.INVALID_ARGS);
    }
  }

  if (!packetId) {
    throw new CliError(
      'invalid_args',
      'o8 packet log <id> requires a packet id.',
      EXIT.INVALID_ARGS,
      'Example: o8 packet log pkt-abc --follow --since 1710000000000',
    );
  }

  return { packetId, follow, ndjson, since };
}

async function fetchBatch(
  packetId: string,
  since: number,
  follow: boolean,
): Promise<PacketTailBatch> {
  const cfg = resolveConfig();
  const response = await apiFetch<PacketTailBatch>(
    cfg,
    `/api/lanes/${encodeURIComponent(packetId)}/events`,
    {
      query: {
        since,
        follow: follow ? 'true' : undefined,
        timeoutMs: follow ? 25_000 : undefined,
      },
    },
  );
  const data = response.data;
  if (!data || !Array.isArray(data.events) || typeof data.nextSince !== 'number') {
    throw new CliError('invalid_response', 'Packet log endpoint returned an invalid response.', EXIT.INVALID_ARGS);
  }
  return data;
}

function writeEvent(event: PacketTailEvent, mode: OutputMode): void {
  if (mode.human) {
    const eventLabel = event.event ? ` ${event.event}` : '';
    const statusLabel = event.status ? ` [${event.status}]` : '';
    process.stdout.write(`${event.timestamp}  ${event.laneId}  ${event.verb}${eventLabel}${statusLabel}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function writeEvents(events: PacketTailEvent[], mode: OutputMode): void {
  for (const event of events) {
    writeEvent(event, mode);
  }
}

async function followByLongPoll(packetId: string, cursor: number, mode: OutputMode): Promise<number> {
  let since = cursor;
  while (true) {
    const batch = await fetchBatch(packetId, since, true);
    writeEvents(batch.events, mode);
    since = batch.nextSince;
  }
}

async function followByWs(packetId: string, cursor: number, mode: OutputMode): Promise<number> {
  const cfg = resolveConfig();
  let since = cursor;
  const ws = await openPacketTailSocket(cfg, packetId, {
    since,
    onEvent: (event) => {
      since = Math.max(since, event.timestampMs);
      writeEvent(event, mode);
    },
  });
  ws.on('error', () => {
    // The close handler below moves the command to HTTP long-poll fallback.
  });
  await new Promise<void>((resolve) => {
    ws.once('close', () => resolve());
  });
  return since;
}

export async function runPacketLog(mode: OutputMode, rest: string[]): Promise<number> {
  const args = parseLogArgs(rest);
  const initial = await fetchBatch(args.packetId, args.since, false);

  if (!args.follow) {
    if (mode.human) {
      printHumanHeading(`packet log ${initial.packetId}`);
      writeEvents(initial.events, mode);
    } else if (args.ndjson) {
      writeEvents(initial.events, mode);
    } else {
      printJson(initial.events);
    }
    return 0;
  }

  writeEvents(initial.events, mode);
  let cursor = initial.nextSince;
  try {
    cursor = await followByWs(args.packetId, cursor, mode);
  } catch {
    // Fall through to HTTP long-poll when the local WS bridge is unavailable.
  }
  return followByLongPoll(args.packetId, cursor, mode);
}
