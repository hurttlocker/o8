#!/usr/bin/env node
// Quality half of the hard-task parity test — CLI transport (subscription, $0).
// Same 4 conditions; persists EVERY result immediately (lesson from the API run).
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = dirname(fileURLToPath(import.meta.url));
const RAW = readFileSync(join(DIR, 'raw-batch.txt'), 'utf8');
const COMPACT = readFileSync(join(DIR, 'compact-artifact.txt'), 'utf8');
const TASK = readFileSync(join(DIR, 'task-prompt.txt'), 'utf8');
const DENY = ['Read','Grep','Glob','Bash','Edit','Write','NotebookEdit','WebFetch','WebSearch','Task'];

function ask(model, artifact, label) {
  const prompt = `${TASK}\n\n<change_batch>\n${artifact}\n</change_batch>`;
  const args = ['--input-format','stream-json','--output-format','stream-json','--verbose',
    '--permission-mode','bypassPermissions','--include-partial-messages','--model',model,
    '--strict-mcp-config','--disallowedTools',...DENY];
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.O8_CLAUDE_BIN || 'claude', args, {
      cwd: tmpdir(), env: { ...process.env, FORCE_COLOR:'0', NO_COLOR:'1', O8_MANAGED_SESSION:'1' },
      stdio: ['pipe','pipe','pipe'],
    });
    let buffer=''; let settled=false; const t0=Date.now();
    const finish=(e,v)=>{ if(settled)return; settled=true; clearTimeout(timer); try{child.kill();}catch{} e?reject(e):resolve(v); };
    const timer=setTimeout(()=>finish(new Error(`${label} timeout`)), 600_000);
    child.stdout.on('data',(c)=>{ buffer+=c.toString('utf8'); const lines=buffer.split('\n'); buffer=lines.pop()??'';
      for(const line of lines){ if(!line.trim())continue; let evt; try{evt=JSON.parse(line);}catch{continue;}
        if(evt.type==='result') finish(null,{label,model,ms:Date.now()-t0,usage:evt.usage??null,costUsd:evt.total_cost_usd??null,text:String(evt.result??'').trim()});
      }});
    child.on('error',finish); child.on('close',()=>finish(new Error(`${label} closed w/o result`)));
    child.stdin.write(`${JSON.stringify({type:'user',message:{role:'user',content:[{type:'text',text:prompt}]}})}\n`);
  });
}

const jobs=[['claude-fable-5',RAW,'fable-RAW'],['claude-fable-5',COMPACT,'fable-WINDOW'],
  ['claude-opus-4-8',RAW,'opus-RAW'],['claude-opus-4-8',COMPACT,'opus-WINDOW']];
const results=[];
for(const [model,artifact,label] of jobs){
  try{
    const r=await ask(model,artifact,label);
    results.push(r);
    writeFileSync(join(DIR,'hard-task-cli-results.json'),JSON.stringify(results,null,2)); // persist EVERY step
    console.log(`[done] ${label}: in=${r.usage?.input_tokens} out=${r.usage?.output_tokens} (${Math.round(r.ms/1000)}s) textlen=${r.text.length}`);
  }catch(e){ console.log(`[fail] ${label}: ${e.message}`); }
}
console.log('saved → hard-task-cli-results.json');
