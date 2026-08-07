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

describe('bare command names on Windows', () => {
  it('routes a bare name through the interpreter — execFile cannot apply PATHEXT', () => {
    setPlatform('win32');
    process.env.ComSpec = 'C:\\WINDOWS\\system32\\cmd.exe';
    // `execFile('npx', …)` fails on Windows because it will not find npx.cmd.
    expect(cliInvocation('npx', ['tsc', '--noEmit'])).toEqual({
      command: 'C:\\WINDOWS\\system32\\cmd.exe',
      args: ['/d', '/c', 'npx', 'tsc', '--noEmit'],
    });
  });

  it('still hands a real .exe straight to CreateProcess', () => {
    setPlatform('win32');
    expect(cliInvocation('C:\\tools\\thing.exe', ['-v'])).toEqual({
      command: 'C:\\tools\\thing.exe',
      args: ['-v'],
    });
  });

  it('leaves bare names alone off Windows', () => {
    setPlatform('darwin');
    expect(cliInvocation('npx', ['tsc'])).toEqual({ command: 'npx', args: ['tsc'] });
  });
});

describe('paths the review flagged as untested', () => {
  it('wraps an extensionless absolute path rather than handing it to CreateProcess', () => {
    setPlatform('win32');
    process.env.ComSpec = 'C:\\WINDOWS\\system32\\cmd.exe';
    // npm writes a POSIX shell script beside the .cmd; if a resolver ever hands
    // one back, failing through the interpreter beats an opaque EINVAL.
    expect(cliInvocation('C:\\Users\\u\\AppData\\Roaming\\npm\\opencode', [])).toEqual({
      command: 'C:\\WINDOWS\\system32\\cmd.exe',
      args: ['/d', '/c', 'C:\\Users\\u\\AppData\\Roaming\\npm\\opencode'],
    });
  });

  it('treats a .ps1 as needing the interpreter, never as directly executable', () => {
    setPlatform('win32');
    // o8 deliberately stopped shipping a .ps1 (#1757) because the default
    // execution policy refuses it. Nothing should ever spawn one directly.
    expect(spawnsViaInterpreter('C:\\x\\o8.ps1')).toBe(true);
  });
});
