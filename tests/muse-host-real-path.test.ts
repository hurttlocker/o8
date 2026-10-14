import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMuseHost } from '@/lib/muse/host';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('Muse SDK owned process boundary', () => {
  it.skipIf(process.platform !== 'darwin')('closes descendants in the SDK process group after the host exits first', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'o8-muse-host-'))); roots.push(root);
    const binary = join(root, 'muse');
    const script = join(root, 'host.cjs');
    const pidFile = join(root, 'descendant');
    writeFileSync(script, `
const {spawn}=require('node:child_process');
const fs=require('node:fs');
const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:['ignore',1,2]});
fs.writeFileSync(${JSON.stringify(pidFile)},String(child.pid));
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const frame=JSON.parse(line);
 if(frame.method==='initialize') console.log(JSON.stringify({jsonrpc:'2.0',id:frame.id,result:{schema:{version:1,fingerprint:'fixture'},grantedCapabilities:['sessionMcp'],museHome:${JSON.stringify(join(root, 'data', 'muse'))}}}));
}).on('close',()=>process.exit(0));
`);
    writeFileSync(binary, `#!/bin/sh\nexec '${process.execPath.replace(/'/g, "'\\''")}' '${script}' "$@"\n`); chmodSync(binary, 0o700);
    const host = await createMuseHost({ cwd: root, binary, dataRoot: join(root, 'data'), configRoot: join(root, 'config'), timeoutMs: 5_000 });
    const pid = Number(readFileSync(pidFile, 'utf8'));
    await host.close();
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 3_000 });
  }, 20_000);
});
