/**
 * `o8 team` — coordination for multiple agents sharing one repo (from o8).
 *
 * Concurrent agents (Claude Code / Codex / any CLI) working the SAME repo on the
 * SAME machine are otherwise blind to each other — they collide (two `npm
 * version` bumps in the same tree broke a ship). This is the fix: a daemonless,
 * git-native PRESENCE registry + named LEASES, all plain files under the git
 * common dir (shared across every worktree, never committed). No server, no
 * socket — files don't need to be running, which is why the old live-delivery
 * bridge failed and this won't.
 *
 *   o8 team who                      — who else is working this repo right now
 *   o8 team status "<text>"          — set your one-line status
 *   o8 team lease acquire <name>     — claim a lock (e.g. `ship`); fails if a
 *                                       live peer holds it (exit 5)
 *   o8 team lease release <name>     — drop your lock
 *   o8 team guard                    — PreToolUse hook: blocks ship/bump
 *                                       commands unless you hold the `ship` lease
 *   o8 team init                     — install the guard hook into .claude/settings.json
 *
 * Identity comes from an explicit runtime/session binding or stable process
 * ancestry. Open-source extraction tracked separately; this is the in-o8 build
 * (`o8 team`).
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { CliError, EXIT } from '../api.js';
import { resolveCliDataDir } from '../config.js';
import { printJson, type OutputMode } from '../output.js';
import { resolveLeaseOwnerPid } from './lease.js';
// PARITY: an agent's o8 team handle is the SAME canonical codename Symon speaks
// (via o8_status) and the dashboard shows (SessionVisualizer / agent cards) —
// one voice-friendly name follows the agent across every surface. Import the
// single source so the CLI and the o8 server can never drift on the pool/hash.
import { codename } from '../../../src/lib/agents/codename.js';

const LIVE_TTL_MS = 6 * 60 * 1000; // a presence/lease holder is "live" if seen within this
const DEFAULT_LEASE_TTL_MS = 30 * 60 * 1000;
/** Commands the `ship` lease guards — the bump/publish/tag-push surface that collided. */
const SHIP_COMMAND_PATTERNS = [
  /\bnpm\s+version\b/,
  /\bnpm\s+run\s+ship\b/,
  /\bgit\s+push\b[^\n]*--follow-tags/,
  /\bgit\s+push\b[^\n]*--tags/,
  /\bcargo\s+tauri\s+build\b/,
];
interface Presence {
  agentId: string;
  sessionKey?: string;
  handle: string;
  runtime: string;
  pid: number;
  cwd: string;
  status: string;
  startedAt: string;
  lastSeen: string;
}

interface Lease {
  name: string;
  holderId: string;
  holderHandle: string;
  note: string;
  acquiredAt: string;
  expiresAt: string;
}

interface AgentProcessRow {
  pid: number;
  ppid: number;
  command: string;
}

export interface ResolveAgentIdentityOptions {
  env?: NodeJS.ProcessEnv;
  ppid?: number;
  readProcess?: (pid: number) => AgentProcessRow | null;
}

interface TeamCommandOptions extends ResolveAgentIdentityOptions {
  cwd?: string;
}

function nowIso() {
  return new Date().toISOString();
}

function isFresh(iso: string | undefined, ttl = LIVE_TTL_MS): boolean {
  if (!iso) return false;
  const t = Date.parse(iso);
  return Number.isFinite(t) && Date.now() - t < ttl;
}

/** The shared room — the git common dir is the same for every worktree of a repo,
 *  and everything under it is git-ignored, so it never touches the tree. */
function roomDir(cwd = process.cwd()): string {
  try {
    const gitDir = execFileSync('git', ['rev-parse', '--absolute-git-dir'], {
      cwd,
      windowsHide: true,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (gitDir) return path.join(gitDir, 'agents');
  } catch {
    /* not a git repo — fall back */
  }
  return path.join(resolveCliDataDir(), 'team', 'default');
}

function ensureRoom(options: TeamCommandOptions = {}): { room: string; presence: string; leases: string; mailbox: string } {
  const room = roomDir(options.cwd);
  const presence = path.join(room, 'presence');
  const leases = path.join(room, 'leases');
  const mailbox = path.join(room, 'mailbox');
  mkdirSync(presence, { recursive: true });
  mkdirSync(leases, { recursive: true });
  mkdirSync(mailbox, { recursive: true });
  return { room, presence, leases, mailbox };
}

interface Message {
  from: string;
  fromHandle: string;
  text: string;
  at: string;
}

/** Mailboxes are append-only JSONL named by recipient handle; a sibling `.read`
 *  file holds the count already surfaced, so unread is a tail slice. Durable —
 *  the message survives the peer being mid-turn or offline. */
function deliver(mailboxDir: string, toHandle: string, msg: Message): void {
  const file = path.join(mailboxDir, `${encodeURIComponent(toHandle)}.jsonl`);
  const fd = `${JSON.stringify(msg)}\n`;
  try {
    writeFileSync(file, fd, { flag: 'a' });
  } catch {
    /* best effort */
  }
}

function readMailbox(mailboxDir: string, handle: string): { all: Message[]; readCount: number } {
  const file = path.join(mailboxDir, `${encodeURIComponent(handle)}.jsonl`);
  const all: Message[] = [];
  try {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { all.push(JSON.parse(line) as Message); } catch { /* skip bad line */ }
    }
  } catch {
    /* no mailbox yet */
  }
  const marker = path.join(mailboxDir, `${encodeURIComponent(handle)}.read`);
  const readCount = Number.parseInt((() => { try { return readFileSync(marker, 'utf8'); } catch { return '0'; } })(), 10) || 0;
  return { all, readCount };
}

function markRead(mailboxDir: string, handle: string, count: number): void {
  try {
    writeFileSync(path.join(mailboxDir, `${encodeURIComponent(handle)}.read`), String(count));
  } catch {
    /* best effort */
  }
}

export function resolveAgentIdentity(options: ResolveAgentIdentityOptions = {}): string {
  const env = options.env ?? process.env;
  const explicit = env.O8_AGENT_ID?.trim();
  if (explicit) return explicit;
  const packetId = env.O8_WORKER_PACKET_ID?.trim();
  if (packetId) return packetId;
  const claudeSessionId = env.CLAUDE_CODE_SESSION_ID?.trim();
  if (claudeSessionId) return claudeSessionId;
  const ownerPid = resolveLeaseOwnerPid({
    env,
    ppid: options.ppid,
    readProcess: options.readProcess,
  });
  if (ownerPid !== null) return `pid-${ownerPid}`;
  throw new CliError(
    'identity_unresolved',
    'Unable to resolve a stable agent session identity. Set O8_AGENT_ID to a unique value for this session and retry.',
    EXIT.CONFLICT,
  );
}

function runtimeLabel(): string {
  const a = process.env.AI_AGENT;
  if (a) return a.split('_')[0] || a;
  if (process.env.CLAUDECODE) return 'claude-code';
  return 'cli';
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

function writeJsonAtomic(file: string, value: unknown): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, file);
}

function livePresences(presenceDir: string): Presence[] {
  if (!existsSync(presenceDir)) return [];
  const out: Presence[] = [];
  for (const f of readdirSync(presenceDir)) {
    if (!f.endsWith('.json')) continue;
    const p = readJson<Presence>(path.join(presenceDir, f));
    if (!p) continue;
    if (isFresh(p.lastSeen)) out.push(p);
    else {
      // reap stale presence so a crashed agent never lingers
      try { rmSync(path.join(presenceDir, f)); } catch { /* best effort */ }
    }
  }
  return out.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

/** Touch my presence (heartbeat). Auto-assigns a friendly handle on first sight. */
function touchPresence(
  presenceDir: string,
  status?: string,
  options: TeamCommandOptions = {},
  beforeWrite?: (presence: Presence) => void,
): Presence {
  const id = resolveAgentIdentity(options);
  const file = path.join(presenceDir, `${encodeURIComponent(id)}.json`);
  const existing = readJson<Presence>(file);
  if (existing) {
    const ownerSessionKey = existing.sessionKey ?? existing.agentId;
    const canAdoptLegacy = existing.sessionKey === undefined && existing.agentId === id;
    if (!canAdoptLegacy && ownerSessionKey !== id) {
      throw new CliError(
        'foreign_identity',
        `This status line is owned by @${existing.handle} (${ownerSessionKey}); your session is ${id}.`,
        EXIT.CONFLICT,
      );
    }
  }
  let handle = existing?.handle;
  if (!handle) {
    // The canonical codename for this agent (parity with Symon + the UI). Suffix
    // only on the rare hash-collision with another LIVE peer, so addressing stays
    // unambiguous for the mailbox.
    const taken = new Set(livePresences(presenceDir).filter((p) => p.agentId !== id).map((p) => p.handle));
    let candidate = codename(id);
    let n = 2;
    while (taken.has(candidate)) {
      candidate = `${codename(id)}${n}`;
      n += 1;
    }
    handle = candidate;
  }
  const presence: Presence = {
    agentId: id,
    sessionKey: id,
    handle,
    runtime: existing?.runtime || runtimeLabel(),
    pid: options.ppid ?? (process.ppid || process.pid),
    cwd: options.cwd ?? process.cwd(),
    status: status ?? existing?.status ?? 'working',
    startedAt: existing?.startedAt || nowIso(),
    lastSeen: nowIso(),
  };
  beforeWrite?.(presence);
  writeJsonAtomic(file, presence);
  return presence;
}

function liveLeases(leasesDir: string): Lease[] {
  if (!existsSync(leasesDir)) return [];
  const out: Lease[] = [];
  const live = new Set(livePresences(path.join(path.dirname(leasesDir), 'presence')).map((p) => p.agentId));
  for (const f of readdirSync(leasesDir)) {
    if (!f.endsWith('.json')) continue;
    const file = path.join(leasesDir, f);
    const lease = readJson<Lease>(file);
    if (!lease) continue;
    // A lease is dead if it expired OR its holder is no longer a live presence.
    if (!isFresh(lease.expiresAt, Number.MAX_SAFE_INTEGER) && Date.parse(lease.expiresAt) < Date.now()) {
      try { rmSync(file); } catch { /* */ } continue;
    }
    if (!live.has(lease.holderId)) {
      try { rmSync(file); } catch { /* */ } continue;
    }
    out.push(lease);
  }
  return out;
}

function leaseFor(leasesDir: string, name: string): Lease | null {
  return liveLeases(leasesDir).find((l) => l.name === name) ?? null;
}

// ── subcommands ─────────────────────────────────────────────────────────

function cmdWho(mode: OutputMode, options: TeamCommandOptions): number {
  const { presence, leases } = ensureRoom(options);
  const me = touchPresence(presence, undefined, options);
  const peers = livePresences(presence);
  const held = liveLeases(leases);
  if (mode.human) {
    process.stdout.write(`o8 team · ${peers.length} agent(s) on this repo (you are @${me.handle})\n`);
    for (const p of peers) {
      const age = Math.round((Date.now() - Date.parse(p.lastSeen)) / 1000);
      process.stdout.write(`  @${p.handle.padEnd(8)} ${p.runtime.padEnd(12)} ${p.status}  (${age}s ago${p.agentId === me.agentId ? ', you' : ''})\n`);
    }
    if (held.length) {
      process.stdout.write('  leases:\n');
      for (const l of held) process.stdout.write(`    ${l.name} held by @${l.holderHandle}${l.note ? ` — ${l.note}` : ''}\n`);
    }
  } else {
    printJson({ schema: 'o8/team.who/v1', you: me.handle, agents: peers, leases: held });
  }
  return EXIT.OK;
}

function cmdStatus(mode: OutputMode, rest: string[], options: TeamCommandOptions): number {
  const text = rest.join(' ').trim();
  if (!text) throw new CliError('invalid_args', 'o8 team status requires text.', EXIT.INVALID_ARGS, 'Example: o8 team status "shipping 0.1.448"');
  const { presence } = ensureRoom(options);
  const me = touchPresence(presence, text, options, (next) => {
    process.stderr.write(`as @${next.handle} · ${next.sessionKey}\n`);
  });
  if (mode.human) process.stdout.write(`@${me.handle}: ${me.status}\n`);
  else printJson({ schema: 'o8/team.status/v1', handle: me.handle, sessionKey: me.sessionKey, status: me.status });
  return EXIT.OK;
}

function flag(rest: string[], name: string): string | null {
  const i = rest.indexOf(`--${name}`);
  if (i >= 0 && rest[i + 1]) return rest[i + 1];
  const eq = rest.find((t) => t.startsWith(`--${name}=`));
  return eq ? eq.slice(name.length + 3) : null;
}

function cmdLease(mode: OutputMode, action: string | undefined, rest: string[], options: TeamCommandOptions): number {
  const { presence, leases } = ensureRoom(options);
  const me = touchPresence(presence, undefined, options);
  if (action === 'list' || !action) {
    const held = liveLeases(leases);
    if (mode.human) {
      if (!held.length) process.stdout.write('no active leases\n');
      for (const l of held) process.stdout.write(`${l.name} → @${l.holderHandle}${l.note ? ` — ${l.note}` : ''}\n`);
    } else printJson({ schema: 'o8/team.lease.list/v1', leases: held });
    return EXIT.OK;
  }
  const name = rest.find((t) => !t.startsWith('--'));
  if (!name) throw new CliError('invalid_args', `o8 team lease ${action} requires a name.`, EXIT.INVALID_ARGS, 'Example: o8 team lease acquire ship --note "shipping 0.1.448"');

  if (action === 'acquire') {
    const current = leaseFor(leases, name);
    if (current && current.holderId !== me.agentId) {
      const reason = `'${name}' is held by @${current.holderHandle}${current.note ? ` — ${current.note}` : ''} (since ${current.acquiredAt}). Wait, or coordinate with \`o8 team who\`.`;
      if (mode.human) process.stderr.write(`o8 team: ${reason}\n`);
      else printJson({ schema: 'o8/team.lease.acquire/v1', ok: false, name, heldBy: current.holderHandle, note: current.note });
      return EXIT.CONFLICT;
    }
    const ttl = Number.parseInt(flag(rest, 'ttl') ?? '', 10);
    const lease: Lease = {
      name,
      holderId: me.agentId,
      holderHandle: me.handle,
      note: flag(rest, 'note') ?? '',
      acquiredAt: nowIso(),
      expiresAt: new Date(Date.now() + (Number.isFinite(ttl) ? ttl * 60_000 : DEFAULT_LEASE_TTL_MS)).toISOString(),
    };
    writeJsonAtomic(path.join(leases, `${encodeURIComponent(name)}.json`), lease);
    if (mode.human) process.stdout.write(`acquired '${name}' as @${me.handle}\n`);
    else printJson({ schema: 'o8/team.lease.acquire/v1', ok: true, name, handle: me.handle });
    return EXIT.OK;
  }
  if (action === 'release') {
    const file = path.join(leases, `${encodeURIComponent(name)}.json`);
    const current = readJson<Lease>(file);
    if (current && current.holderId !== me.agentId) {
      throw new CliError('conflict', `'${name}' is held by @${current.holderHandle}, not you.`, EXIT.CONFLICT);
    }
    try { rmSync(file); } catch { /* already gone */ }
    if (mode.human) process.stdout.write(`released '${name}'\n`);
    else printJson({ schema: 'o8/team.lease.release/v1', ok: true, name });
    return EXIT.OK;
  }
  throw new CliError('invalid_args', `Unknown lease action: ${action}`, EXIT.INVALID_ARGS, 'Use: acquire | release | list');
}

function cmdTell(mode: OutputMode, rest: string[], options: TeamCommandOptions): number {
  const { presence, mailbox } = ensureRoom(options);
  const me = touchPresence(presence, undefined, options);
  const target = rest.find((t) => t.startsWith('@'));
  if (!target) throw new CliError('invalid_args', 'o8 team tell requires a @handle.', EXIT.INVALID_ARGS, 'Example: o8 team tell @nova "hold your bump, I am mid-ship"');
  const toHandle = target.slice(1);
  const text = rest.filter((t) => t !== target).join(' ').trim();
  if (!text) throw new CliError('invalid_args', 'o8 team tell requires a message.', EXIT.INVALID_ARGS);
  const online = livePresences(presence).some((p) => p.handle === toHandle);
  deliver(mailbox, toHandle, { from: me.agentId, fromHandle: me.handle, text, at: nowIso() });
  if (mode.human) process.stdout.write(`sent to @${toHandle}${online ? '' : ' (offline — durable; they see it on their next turn)'}\n`);
  else printJson({ schema: 'o8/team.tell/v1', ok: true, to: toHandle, online });
  return EXIT.OK;
}

function cmdInbox(mode: OutputMode, rest: string[], options: TeamCommandOptions): number {
  const { presence, mailbox } = ensureRoom(options);
  const me = touchPresence(presence, undefined, options);
  const box = readMailbox(mailbox, me.handle);
  const msgs = rest.includes('--all') ? box.all : box.all.slice(box.readCount);
  if (mode.human) {
    if (!msgs.length) process.stdout.write('no new messages\n');
    for (const m of msgs) process.stdout.write(`@${m.fromHandle}: ${m.text}  (${m.at})\n`);
  } else printJson({ schema: 'o8/team.inbox/v1', you: me.handle, messages: msgs });
  markRead(mailbox, me.handle, box.all.length);
  return EXIT.OK;
}

/** PreToolUse hook: stamp heartbeat, surface unread peer messages as context,
 *  and block a ship/bump when the `ship` lease is held by another live agent.
 *  Reads Claude Code's hook JSON on stdin; exit 2 blocks + feeds stderr back. */
function cmdGuard(options: TeamCommandOptions): number {
  const { presence, leases, mailbox } = ensureRoom(options);
  const me = touchPresence(presence, undefined, options);
  const box = readMailbox(mailbox, me.handle);
  const unread = box.all.slice(box.readCount);

  let command = '';
  try {
    const payload = JSON.parse(readFileSync(0, 'utf8')) as { tool_input?: { command?: string } };
    command = payload?.tool_input?.command ?? '';
  } catch {
    /* no/unparseable stdin — still surface unread below */
  }

  const isShip = Boolean(command) && SHIP_COMMAND_PATTERNS.some((re) => re.test(command));
  const ship = isShip ? leaseFor(leases, 'ship') : null;
  if (ship && ship.holderId !== me.agentId) {
    markRead(mailbox, me.handle, box.all.length);
    const peerNote = unread.length ? `\nUnread peer message(s): ${unread.map((m) => `@${m.fromHandle}: ${m.text}`).join(' · ')}` : '';
    process.stderr.write(
      `[o8 team] Blocked: @${ship.holderHandle} holds the 'ship' lease${ship.note ? ` (${ship.note})` : ''} since ${ship.acquiredAt}.\n`
      + `Another agent is mid-ship in this repo — a concurrent bump/publish would break their build (this is the collision o8 team prevents).\n`
      + `Wait for them, or run \`o8 team who\` to coordinate. Re-run once the lease clears.${peerNote}\n`,
    );
    return 2; // Claude Code: exit 2 = block this tool call
  }

  // Non-blocking: surface any unread peer messages as model context, then mark read.
  if (unread.length) {
    markRead(mailbox, me.handle, box.all.length);
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: `[o8 team] You are @${me.handle}. New message(s) from a teammate in this repo — ${unread.map((m) => `@${m.fromHandle} says "${m.text}"`).join(' · ')}. Reply with \`o8 team tell @<handle> "..."\`.`,
      },
    }));
  }
  return EXIT.OK;
}

const GUARD_HOOK = {
  matcher: 'Bash',
  hooks: [{ type: 'command', command: 'o8 team guard' }],
};

function cmdInit(mode: OutputMode, options: TeamCommandOptions): number {
  const settingsPath = path.join(options.cwd ?? process.cwd(), '.claude', 'settings.json');
  mkdirSync(path.dirname(settingsPath), { recursive: true });
  const settings = (readJson<Record<string, unknown>>(settingsPath)) ?? {};
  const hooks = (settings.hooks as Record<string, unknown>) ?? {};
  const preToolUse = Array.isArray(hooks.PreToolUse) ? (hooks.PreToolUse as unknown[]) : [];
  const already = preToolUse.some((h) => JSON.stringify(h).includes('o8 team guard'));
  if (!already) preToolUse.push(GUARD_HOOK);
  settings.hooks = { ...hooks, PreToolUse: preToolUse };
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  const { presence } = ensureRoom(options);
  const me = touchPresence(presence, undefined, options);
  if (mode.human) {
    process.stdout.write(`o8 team installed (you are @${me.handle}).\n`);
    process.stdout.write(`Guard hook ${already ? 'already present' : 'added'} in ${settingsPath}.\n`);
    process.stdout.write('Before a ship: `o8 team lease acquire ship --note "shipping X"`; concurrent bumps now block.\n');
  } else printJson({ schema: 'o8/team.init/v1', ok: true, handle: me.handle, settingsPath, hookAdded: !already });
  return EXIT.OK;
}

export function runTeam(
  mode: OutputMode,
  sub: string | undefined,
  rest: string[],
  options: TeamCommandOptions = {},
): number {
  switch (sub) {
    case 'who': return cmdWho(mode, options);
    case 'status': return cmdStatus(mode, rest, options);
    case 'lease': return cmdLease(mode, rest[0], rest.slice(1), options);
    case 'tell': return cmdTell(mode, rest, options);
    case 'inbox': return cmdInbox(mode, rest, options);
    case 'guard': return cmdGuard(options);
    case 'init': return cmdInit(mode, options);
    default:
      throw new CliError(
        'unknown_team_subcommand',
        `Unknown team subcommand: ${sub ?? '(none)'}`,
        EXIT.INVALID_ARGS,
        'Use: who | status | tell @h "msg" | inbox | lease acquire|release|list | guard | init',
      );
  }
}
