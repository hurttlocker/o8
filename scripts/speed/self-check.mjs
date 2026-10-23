#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { root, distribution, evidencePath, writeJson, sleep } from './common.mjs';
import { rpc } from './mcp.mjs';

const dir = path.join(root, 'tmp/speed-evidence/self-check');
fs.mkdirSync(dir, { recursive: true });
let mode = 'http-error';
let delayMs = 0;
const server = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const payload = JSON.parse(Buffer.concat(chunks).toString());
  await sleep(delayMs);
  response.setHeader('Content-Type', 'application/json');
  response.writeHead(mode === 'http-error' ? 503 : 200);
  response.end(JSON.stringify({ jsonrpc: '2.0', id: payload.id,
    ...(mode === 'rpc-error' ? { error: { code: -32000, message: 'fixture failure' } }
      : { result: { isError: mode === 'tool-error', content: [] } }) }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const stack = { base: `http://127.0.0.1:${server.address().port}`, token: 'fixture-only' };
const receipt = { schema: 'o8/speed-self-check/v1', rejectedFailures: [], controls: {} };
try {
  assert.throws(() => evidencePath(path.dirname(root)));
  const link = path.join(dir, `outside-${process.pid}`);
  fs.symlinkSync(path.dirname(root), link, 'dir');
  try { assert.throws(() => evidencePath(path.join(link, 'unwritten.json'))); }
  finally { fs.unlinkSync(link); }
  receipt.controls.isolation = { outsidePathRejected: true, externalSymlinkRejected: true };
  for (const failure of ['http-error', 'rpc-error', 'tool-error']) {
    mode = failure;
    await assert.rejects(() => rpc(stack, 'tools/list'));
    receipt.rejectedFailures.push(failure);
  }
  mode = 'success';
  const healthy = [];
  for (let i = 0; i < 3; i++) healthy.push((await rpc(stack, 'tools/list')).ms);
  delayMs = 120;
  const delayed = [];
  for (let i = 0; i < 3; i++) delayed.push((await rpc(stack, 'tools/list')).ms);
  assert(distribution(delayed).median >= 120);
  assert(distribution(delayed).median > 80, 'The injected fixture must fail an 80ms calibration budget');
  receipt.controls.http = { healthyMs: distribution(healthy), delayedMs: distribution(delayed), injectedMs: 120, calibrationBudgetMs: 80, delayedBudgetRejected: true };
  const child = `const assert=require('node:assert/strict');const{promisify}=require('node:util');const{execFile}=require('node:child_process');(async()=>{const result=await promisify(execFile)(process.execPath,['-e','process.stdout.write("stdout");process.stderr.write("stderr")']);assert.equal(result.stdout,'stdout');assert.equal(result.stderr,'stderr');await assert.rejects(()=>promisify(execFile)(process.execPath,['-e','process.exit(7)']),e=>e.code===7);process.stdout.write('ok')})().catch(()=>process.exit(1));`;
  const output = execFileSync(process.execPath, ['--require', path.join(root, 'scripts/speed/process-hook.cjs'), '-e', child], { encoding: 'utf8', env: { ...process.env, O8_SPEED_TRACE: path.join(dir, 'hook.jsonl') } });
  assert.equal(output, 'ok');
  receipt.controls.childProcess = { stdout: true, stderr: true, nonzeroExit: true, promisifyMultiResult: true };
  receipt.pass = true;
} finally { await new Promise(resolve => server.close(resolve)); }
writeJson(path.join(root, 'tmp/speed-evidence/self-check.json'), receipt);
process.stdout.write(JSON.stringify(receipt, null, 2) + '\n');
