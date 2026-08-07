import { describe, it, expect, afterEach } from 'vitest';

import { cliInvocation, spawnsViaInterpreter } from './cli-spawn';

const realPlatform = process.platform;
const realComspec = process.env.ComSpec;

function setPlatform(value: string) {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
  if (realComspec === undefined) delete process.env.ComSpec;
  else process.env.ComSpec = realComspec;
});

describe('cliInvocation', () => {
  it('is the identity off Windows', () => {
    setPlatform('darwin');
    expect(cliInvocation('/usr/local/bin/claude', ['--model', 'x'])).toEqual({
      command: '/usr/local/bin/claude',
      args: ['--model', 'x'],
    });
  });

  it('routes a Windows .cmd through the interpreter — a direct spawn would EINVAL', () => {
    setPlatform('win32');
    process.env.ComSpec = 'C:\\WINDOWS\\system32\\cmd.exe';
    const target = 'C:\\Users\\u\\AppData\\Roaming\\npm\\claude.cmd';
    expect(cliInvocation(target, ['--model', 'x'])).toEqual({
      command: 'C:\\WINDOWS\\system32\\cmd.exe',
      args: ['/d', '/c', target, '--model', 'x'],
    });
  });

  it('leaves a real Windows executable alone', () => {
    setPlatform('win32');
    const target = 'C:\\Program Files\\thing\\claude.exe';
    expect(cliInvocation(target, ['--model', 'x'])).toEqual({
      command: target,
      args: ['--model', 'x'],
    });
  });

  it('does not treat .cmd as interpreted off Windows', () => {
    setPlatform('linux');
    expect(spawnsViaInterpreter('/opt/weird/claude.cmd')).toBe(false);
  });

  it('flags interpreted spawns so callers know to kill the whole tree', () => {
    setPlatform('win32');
    expect(spawnsViaInterpreter('C:\\x\\claude.cmd')).toBe(true);
    expect(spawnsViaInterpreter('C:\\x\\claude.BAT')).toBe(true);
    expect(spawnsViaInterpreter('C:\\x\\claude.exe')).toBe(false);
  });
});
