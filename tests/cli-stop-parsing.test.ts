import { describe, expect, it } from 'vitest';
import { CliError } from '../cli/src/api';
import { parseMissionStopArgs } from '../cli/src/commands/mission';
import { parsePacketStopArgs } from '../cli/src/commands/packet/stop';
import { parseRunStopArgs } from '../cli/src/commands/run';

describe('CLI stop command parsing', () => {
  it('packet stop uses an explicit positional packet id before --packet', () => {
    expect(parsePacketStopArgs(['pkt-pos', '--packet', 'pkt-flag'])).toEqual({
      packetId: 'pkt-pos',
    });
  });

  it('packet stop rejects unknown extra positional args', () => {
    expect(() => parsePacketStopArgs(['pkt-1', 'extra'])).toThrow(CliError);
  });

  it('mission stop requires --mission', () => {
    expect(parseMissionStopArgs(['--mission', 'mission-1'])).toEqual({
      missionId: 'mission-1',
    });
    expect(() => parseMissionStopArgs([])).toThrow(CliError);
  });

  it('run stop requires exactly one run id', () => {
    expect(parseRunStopArgs(['stop', 'abc123'])).toEqual({ runId: 'abc123' });
    expect(() => parseRunStopArgs(['stop'])).toThrow(CliError);
    expect(() => parseRunStopArgs(['stop', 'abc123', 'extra'])).toThrow(CliError);
  });
});
