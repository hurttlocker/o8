import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { prepareWorkerSandbox } from '@/lib/runtimes/shared/owned-session/sandbox';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'o8-provider-sandbox-')));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe.skipIf(process.platform !== 'darwin')('controlled provider native filesystem isolation', () => {
  it('opens only the approved file and denies synthetic native credentials and all repository writes', async () => {
    const repo = join(root, 'repo');
    execFileSync('git', ['init', '--initial-branch=main', repo], { stdio: 'pipe' });
    writeFileSync(join(repo, 'value.txt'), '40\n');
    writeFileSync(join(repo, 'excluded.txt'), 'Out of scope');
    execFileSync('git', ['-C', repo, 'add', '.']);
    execFileSync('git', ['-C', repo, '-c', 'user.email=fixture@example.invalid', '-c', 'user.name=fixture', 'commit', '-m', 'fixture'], { stdio: 'pipe' });
    const fakeHome = join(root, 'synthetic-home');
    mkdirSync(join(fakeHome, '.codex'), { recursive: true }); mkdirSync(join(fakeHome, '.claude'));
    const secrets = [join(fakeHome, '.codex', 'auth.json'), join(fakeHome, '.claude', '.credentials.json')];
    for (const file of secrets) writeFileSync(file, 'synthetic credential; never a real account');
    const check = `const fs=require('node:fs');const result={approved:fs.readFileSync(${JSON.stringify(join(repo, 'value.txt'))},'utf8'),denied:[]};
      for(const path of ${JSON.stringify([...secrets, join(repo, 'excluded.txt')])}){try{fs.readFileSync(path);result.denied.push(false)}catch{result.denied.push(true)}}
      try{fs.writeFileSync(${JSON.stringify(join(repo, 'value.txt'))},'changed');result.writeDenied=false}catch{result.writeDenied=true}
      process.stdout.write(JSON.stringify(result));`;
    const prepared = await prepareWorkerSandbox({ runId: 'synthetic-provider-sandbox', profileDir: root,
      cwd: repo, repoPath: repo, binary: process.execPath, args: ['-e', check], homeDir: fakeHome, tmpDir: root,
      enforceReadOnly: true, finalDenyPaths: [homedir(), fakeHome, tmpdir(), '/tmp', '/private/tmp'],
      finalAllowReadPaths: [process.execPath, repo, join(repo, 'value.txt')],
      finalDenyExecNamePrefixes: ['codex', 'opencode', 'claude', 'bash', 'zsh', 'sh', 'python', 'node'],
      finalAllowExecPaths: [process.execPath] });
    const result = JSON.parse(execFileSync(prepared.binary, prepared.args,
      { cwd: repo, env: { NODE_ENV: 'test', PATH: '/usr/bin:/bin', HOME: fakeHome }, encoding: 'utf8', timeout: 5000 }));
    expect(result).toEqual({ approved: '40\n', denied: [true, true, true], writeDenied: true });
    expect(readFileSync(join(repo, 'value.txt'), 'utf8')).toBe('40\n');
  });
});
