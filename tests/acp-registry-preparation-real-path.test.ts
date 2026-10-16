import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { decodeAcpRegistry } from '@/lib/acp/registry';
import { prepareRegistryAgent, registryPreparationEnvironment } from '@/lib/acp/registry-preparation';
import { runRegistryInstaller } from '@/lib/acp/preparation-process';
import { saveLocalAcpConnection } from '@/lib/acp/local-connection';
import { probeAcpModels } from '@/lib/orchestrator/acp-model-probe';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'o8-acp-preparation-')));
const npm = join(root, 'npm');
const receipt = join(root, 'install-receipt');
const supervisor = process.env.O8_PI_WRITE_BIN ?? (process.platform === 'darwin' ? '/Applications/o8.app/Contents/MacOS/o8-pi-write' : join(process.cwd(), 'src-tauri/sidecars/pi-write/target/release/o8-pi-write'));
const [agent] = decodeAcpRegistry({ agents: [{ id: 'fixture', name: 'Fixture', version: '1.0.0', distribution: { npx: { package: 'fixture-agent@1.0.0', args: ['acp'] } } }] });
const peer = String.raw`#!/usr/bin/env node
const send=value=>console.log(JSON.stringify(value));
require('readline').createInterface({input:process.stdin}).on('line',line=>{const q=JSON.parse(line);let result={};
if(q.method==='initialize')result={protocolVersion:1};
if(q.method==='session/new')result={sessionId:'local-fixture',configOptions:[{id:'model',type:'select',currentValue:'fixture-model',options:[{value:'fixture-model',name:'Fixture model'}]}]};
if(q.id!==undefined)send({jsonrpc:'2.0',id:q.id,result});});`;
writeFileSync(join(root, 'installer.cjs'), `const fs=require('fs'),path=require('path');const args=process.argv.slice(2);const prefix=args[args.indexOf('--prefix')+1];
fs.appendFileSync(${JSON.stringify(receipt)},JSON.stringify({args,key:process.env.OPENROUTER_API_KEY,token:process.env.O8_WS_TOKEN})+'\\n');
const pkg=path.join(prefix,'node_modules','fixture-agent');fs.mkdirSync(pkg,{recursive:true});fs.writeFileSync(path.join(pkg,'package.json'),JSON.stringify({name:'fixture-agent',version:'1.0.0',bin:'agent.js'}));fs.writeFileSync(path.join(pkg,'agent.js'),${JSON.stringify(peer)});`);
writeFileSync(npm, `#!/bin/sh\nexec '${process.execPath.replace(/'/g, "'\\''")}' '${join(root, 'installer.cjs')}' "$@"\n`); chmodSync(npm, 0o700);
afterAll(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

describe.skipIf(!existsSync(supervisor))('explicit ACP package preparation and connection', () => {
  it('coalesces preparation, excludes credentials, reuses the version, and checks the prepared process', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'fixture-secret'); vi.stubEnv('O8_WS_TOKEN', 'fixture-secret');
    const dependencies = { root: join(root, 'packages'), npmBinary: npm, supervisor, read: async () => ({ agents: [agent], observedAt: new Date().toISOString(), stale: false }) };
    const input = { id: agent.id, fingerprint: agent.fingerprint };
    const [one, two] = await Promise.all([prepareRegistryAgent(input, dependencies), prepareRegistryAgent(input, dependencies)]);
    expect(one).toEqual(two);
    expect(await prepareRegistryAgent(input, dependencies)).toEqual(one);
    const lines = readFileSync(receipt, 'utf8').trim().split('\n'); expect(lines).toHaveLength(1);
    const installed = JSON.parse(lines[0]); expect(installed.key).toBeUndefined(); expect(installed.token).toBeUndefined();
    expect(installed.args).toEqual(expect.arrayContaining(['--ignore-scripts', '--save-exact', 'fixture-agent@1.0.0']));
    saveLocalAcpConnection(one);
    const models = await probeAcpModels('acp', { ...one, omitEnv: ['OPENROUTER_API_KEY'] }, root, { force: true });
    expect(models.models.map(model => model.value)).toContain('fixture-model');
    const prefix = join(dependencies.root, agent.id, agent.fingerprint);
    const relocated = `${prefix}-moved`;
    const { renameSync } = await import('node:fs'); renameSync(prefix, relocated); symlinkSync(relocated, prefix);
    await expect(prepareRegistryAgent(input, dependencies)).rejects.toThrow('redirected');
    rmSync(prefix); renameSync(relocated, prefix);
  });
  it('refuses stale or changed registry metadata before creating a process', async () => {
    const read = async () => ({ agents: [agent], observedAt: '', stale: true });
    await expect(prepareRegistryAgent({ id: agent.id, fingerprint: agent.fingerprint }, { root, npmBinary: npm, read })).rejects.toThrow('offline');
    await expect(prepareRegistryAgent({ id: agent.id, fingerprint: 'b'.repeat(64) }, { root, npmBinary: npm, read: async () => ({ agents: [agent], observedAt: '', stale: false }) })).rejects.toThrow('changed');
  });
  it('cleans failed stages and lets a corrected installation retry', async () => {
    const fail = join(root, 'failed-npm'); writeFileSync(fail, '#!/bin/sh\nexit 1\n'); chmodSync(fail, 0o700);
    const dependencies = { root: join(root, 'retry'), npmBinary: fail, supervisor, read: async () => ({ agents: [agent], observedAt: '', stale: false }) };
    await expect(prepareRegistryAgent({ id: agent.id, fingerprint: agent.fingerprint }, dependencies)).rejects.toThrow('could not be prepared');
    expect(readdirSync(dependencies.root).filter(name => name.startsWith('.prepare-'))).toEqual([]);
    expect(await prepareRegistryAgent({ id: agent.id, fingerprint: agent.fingerprint }, { ...dependencies, npmBinary: npm })).toMatchObject({ name: 'Fixture' });
  });
  it('prepares a long registry name into a connection that explicit Save accepts', async () => {
    const [longAgent] = decodeAcpRegistry({ agents: [{ id: 'long-name', name: 'A'.repeat(100), version: '1.0.0', distribution: { npx: { package: 'fixture-agent@1.0.0' } } }] });
    const connection = await prepareRegistryAgent({ id: longAgent.id, fingerprint: longAgent.fingerprint }, { root: join(root, 'long'), npmBinary: npm, supervisor, read: async () => ({ agents: [longAgent], observedAt: '', stale: false }) });
    expect(connection.name).toHaveLength(80);
    expect(() => saveLocalAcpConnection(connection)).not.toThrow();
  });
  it('ends a timed-out installer and its TERM-ignoring descendant', async () => {
    const pidFile = join(root, 'installer-pids');
    const script = join(root, 'hang.cjs');
    writeFileSync(script, `const fs=require('fs');process.on('SIGTERM',()=>{});const child=require('child_process').spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(pidFile)},JSON.stringify([process.pid,child.pid]));setInterval(()=>{},1000);`);
    await expect(runRegistryInstaller(process.execPath, [script], { cwd: root, env: registryPreparationEnvironment(root), supervisor, timeoutMs: 1500 })).rejects.toThrow('could not be prepared');
    for (const pid of JSON.parse(readFileSync(pidFile, 'utf8'))) expect(() => process.kill(pid, 0)).toThrow();
  }, 15_000);
});

it('does not inherit authentication agents, preload options, or global credential locations', () => {
  for (const name of ['SSH_AUTH_SOCK', 'NPM_TOKEN', 'GITHUB_TOKEN', 'OPENROUTER_API_KEY']) vi.stubEnv(name, 'fixture-secret');
  vi.stubEnv('NODE_OPTIONS', '--require=/fixture/preload');
  const env = registryPreparationEnvironment(root);
  for (const name of ['SSH_AUTH_SOCK', 'NPM_TOKEN', 'GITHUB_TOKEN', 'OPENROUTER_API_KEY']) expect(env[name]).toBeUndefined();
  expect(env.HOME).toBe(join(root, 'home')); expect(env.NODE_OPTIONS).toBe('');
});
