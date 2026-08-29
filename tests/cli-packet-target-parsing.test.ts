import { afterEach, describe, expect, it, vi } from 'vitest';
import { CliError, EXIT } from '../cli/src/api';
import { parseCaptureArgs, runPacketCapture } from '../cli/src/commands/packet/capture';
import { parsePacketCommitMessage } from '../cli/src/commands/packet/commit';
import {
  OPERATOR_PACKET_COMMAND_LINES,
  OPERATOR_PACKET_SUBCOMMANDS,
  PACKET_SUBCOMMANDS,
  packetGroupUsage,
  packetSubcommandHint,
} from '../cli/src/commands/packet/help';
import { parsePacketRecoveryArgs } from '../cli/src/commands/packet/recover';
import { parseMirrorArgs, runPacketMirrorProof } from '../cli/src/commands/packet/mirror-proof';
import {
  resolvePacketTargetFromLanes,
  type PacketTargetLane,
} from '../cli/src/commands/packet/target';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('packet CLI target parsing', () => {
  it.each([
    ['reset', ['--reason', 'stuck']],
    ['retry', ['--reason', 'keep worktree']],
    ['rerun', ['--feedback', 'fix the failure']],
    ['steer', ['--message', 'also cover empty input']],
    ['approve-merge', ['--expected-sha', 'abc123']],
    ['merge-preview', []],
  ] as const)('%s treats a positional packet id exactly like --packet', (verb, trailing) => {
    const positional = parsePacketRecoveryArgs(verb, ['pkt-target', ...trailing]);
    const flagged = parsePacketRecoveryArgs(verb, ['--packet', 'pkt-target', ...trailing]);

    expect(positional.target).toBe('pkt-target');
    expect(flagged.target).toBe('pkt-target');
    expect(positional.values).toEqual(flagged.values);
    expect([...positional.booleans]).toEqual([...flagged.booleans]);
  });

  it('rejects an unresolved explicit id without falling back to the cwd packet', () => {
    const lanes: PacketTargetLane[] = [{
      id: 'lane-cwd',
      packetId: 'pkt-cwd',
      worktreePath: '/repo/.cortex-worktrees/packet-cwd',
      status: 'working',
    }];
    const cwdMatch = {
      worktreePath: '/repo/.cortex-worktrees/packet-cwd',
      packetSlug: 'cwd',
      layout: 'cortex-worktrees' as const,
    };

    expect(resolvePacketTargetFromLanes(null, lanes, cwdMatch).packetId).toBe('pkt-cwd');
    try {
      resolvePacketTargetFromLanes('pkt-missing', lanes, cwdMatch);
      throw new Error('expected explicit target resolution to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(CliError);
      expect((error as CliError).code).toBe('packet_target_not_found');
      expect((error as CliError).exit).toBe(EXIT.NOT_FOUND);
      expect((error as CliError).hint).toContain('cwd packet was not used');
    }
  });

  it('rejects an unexpected positional on a no-target packet verb', () => {
    expect(() => parsePacketCommitMessage(['pkt-wrong', '-m', 'fix: example']))
      .toThrow('Unexpected argument pkt-wrong for o8 packet commit.');
  });

  it('consumes dash-prefixed free text unless it is a known flag for the command', () => {
    expect(parsePacketRecoveryArgs('steer', ['--message', '-v flag is broken']).values.message)
      .toBe('-v flag is broken');
    expect(() => parsePacketRecoveryArgs('steer', ['--message', '--packet', 'pkt-target']))
      .toThrow('--message requires a value.');
  });

  it('routes capture and mirror-proof positional targets through the shared parser', () => {
    const capturePositional = parseCaptureArgs(['pkt-target', '--url', 'http://localhost:3000']);
    const captureFlagged = parseCaptureArgs(['--packet', 'pkt-target', '--url', 'http://localhost:3000']);
    expect(capturePositional).toMatchObject({
      packetTarget: 'pkt-target',
      url: 'http://localhost:3000',
    });
    expect(captureFlagged).toEqual(capturePositional);
    expect(parseCaptureArgs(['http://localhost:3000'])).toMatchObject({
      packetTarget: null,
      url: 'http://localhost:3000',
    });
    const mirrorPositional = parseMirrorArgs(['pkt-target', '--pr', '1463']);
    const mirrorFlagged = parseMirrorArgs(['--packet', 'pkt-target', '--pr', '1463']);
    expect(mirrorPositional).toMatchObject({
      packetId: 'pkt-target',
      prNumber: 1463,
    });
    expect(mirrorFlagged).toEqual(mirrorPositional);
  });

  it.each([
    ['capture', () => runPacketCapture(
      { human: false, verbose: false },
      ['pkt-missing', '--url', 'http://localhost:3000'],
    )],
    ['mirror-proof', () => runPacketMirrorProof(
      { human: false, verbose: false },
      ['pkt-missing', '--pr', '1463', '--repo', 'owner/repo'],
    )],
  ])('%s fails closed when its explicit target does not resolve', async (_verb, run) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ lanes: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })));

    await expect(run()).rejects.toMatchObject({
      code: 'packet_target_not_found',
      exit: EXIT.NOT_FOUND,
    });
  });

  it('resolves target precedence as explicit id, worker env, then cwd', () => {
    const lanes: PacketTargetLane[] = [
      { id: 'lane-explicit', packetId: 'pkt-explicit', worktreePath: null, status: 'working' },
      { id: 'lane-env', packetId: 'pkt-env', worktreePath: null, status: 'working' },
      {
        id: 'lane-cwd',
        packetId: 'pkt-cwd',
        worktreePath: '/repo/.cortex-worktrees/packet-cwd',
        status: 'working',
      },
    ];
    const cwdMatch = {
      worktreePath: '/repo/.cortex-worktrees/packet-cwd',
      packetSlug: 'cwd',
      layout: 'cortex-worktrees' as const,
    };

    expect(resolvePacketTargetFromLanes('pkt-explicit', lanes, cwdMatch, 'pkt-env')).toMatchObject({
      packetId: 'pkt-explicit',
      source: 'explicit',
    });
    expect(resolvePacketTargetFromLanes(null, lanes, cwdMatch, 'pkt-env')).toMatchObject({
      packetId: 'pkt-env',
      source: 'env',
    });
    expect(resolvePacketTargetFromLanes(null, lanes, cwdMatch, null)).toMatchObject({
      packetId: 'pkt-cwd',
      source: 'cwd',
    });
    expect(() => resolvePacketTargetFromLanes(null, lanes, cwdMatch, 'pkt-missing'))
      .toThrow('Worker packet target from O8_WORKER_PACKET_ID pkt-missing did not resolve');
  });
});

describe('packet CLI help', () => {
  it('keeps operator-only receipt commands out of worker packet-group help', () => {
    const output = packetGroupUsage();

    expect(output).toContain('usage: o8 packet <subcommand> [flags]');
    for (const subcommand of PACKET_SUBCOMMANDS) {
      expect(output).toContain(`packet ${subcommand}`);
    }
    for (const subcommand of OPERATOR_PACKET_SUBCOMMANDS) {
      expect(output).not.toContain(`packet ${subcommand}`);
      expect(OPERATOR_PACKET_COMMAND_LINES).toContain(`packet ${subcommand}`);
    }
    expect(OPERATOR_PACKET_COMMAND_LINES).toContain('operator only');
    expect(output).not.toContain('CLI version + connected server version');
  });

  it('names valid packet subcommands in the unknown-subcommand hint', () => {
    const hint = packetSubcommandHint();
    expect(hint).toContain('Valid worker packet subcommands:');
    expect(hint).toContain('Operator-only packet subcommands: receipt, receipts');
    expect(hint).toContain('rerun');
    expect(hint).toContain('steer');
    expect(hint).toContain('merge-preview');
  });
});
