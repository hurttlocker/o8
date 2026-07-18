import { describe, expect, it } from 'vitest';
import { CliError, EXIT } from '../cli/src/api';
import { parseCaptureArgs } from '../cli/src/commands/packet/capture';
import { parsePacketCommitMessage } from '../cli/src/commands/packet/commit';
import {
  PACKET_SUBCOMMANDS,
  packetGroupUsage,
  packetSubcommandHint,
} from '../cli/src/commands/packet/help';
import { parsePacketRecoveryArgs } from '../cli/src/commands/packet/recover';
import { parseMirrorArgs } from '../cli/src/commands/packet/mirror-proof';
import {
  resolvePacketTargetFromLanes,
  type PacketTargetLane,
} from '../cli/src/commands/packet/target';

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

  it('keeps capture and mirror-proof positional operands distinct from packet targets', () => {
    expect(parseCaptureArgs(['pkt-target', '--url', 'http://localhost:3000'])).toMatchObject({
      packetTarget: 'pkt-target',
      url: 'http://localhost:3000',
    });
    expect(parseCaptureArgs(['http://localhost:3000'])).toMatchObject({
      packetTarget: null,
      url: 'http://localhost:3000',
    });
    expect(parseMirrorArgs(['pkt-target', '--pr', '1463'])).toMatchObject({
      packetId: 'pkt-target',
      prNumber: 1463,
    });
  });
});

describe('packet CLI help', () => {
  it('prints packet-group help with the complete packet subcommand list', () => {
    const output = packetGroupUsage();

    expect(output).toContain('usage: o8 packet <subcommand> [flags]');
    for (const subcommand of PACKET_SUBCOMMANDS) {
      expect(output).toContain(`packet ${subcommand}`);
    }
    expect(output).not.toContain('CLI version + connected server version');
  });

  it('names valid packet subcommands in the unknown-subcommand hint', () => {
    const hint = packetSubcommandHint();
    expect(hint).toContain('Valid packet subcommands:');
    expect(hint).toContain('rerun');
    expect(hint).toContain('steer');
    expect(hint).toContain('merge-preview');
  });
});
