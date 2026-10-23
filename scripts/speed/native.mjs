#!/usr/bin/env node
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fixture } from './stack.mjs';
import { distribution, evidencePath, freePort, healthy, launch, root, round, rss, sleep, stop, writeJson } from './common.mjs';
import { nativeFixture, refreshNativeHistory } from './native-fixture.mjs';
import { inspector, postGc, summarizeHeap } from './memory.mjs';
import { paintController } from './native-paint.mjs';

export async function evaluate(socketPath, code) {
  if (!socketPath.startsWith(root + path.sep)) throw new Error('Native observation requires an owned worktree socket');
  const socket = net.createConnection(socketPath);
  const id = `speed-${Date.now()}-${Math.random()}`;
  const tokenPath = `${socketPath}.token`;
  const authToken = fs.existsSync(tokenPath) ? fs.readFileSync(tokenPath, 'utf8').trim() : undefined;
  try {
    return await new Promise((resolve, reject) => {
      let buffer = '';
      const timer = setTimeout(() => { socket.destroy(); reject(new Error('Owned native evaluation timed out')); }, 10000);
      socket.on('error', error => { clearTimeout(timer); reject(error); });
      socket.on('connect', () => socket.write(JSON.stringify({ id, command: 'execute_js', payload: { window_label: 'main', code }, ...(authToken ? { authToken } : {}) }) + '\n'));
      socket.on('data', chunk => {
        buffer += chunk;
        const newline = buffer.indexOf('\n');
        if (newline < 0) return;
        clearTimeout(timer);
        const response = JSON.parse(buffer.slice(0, newline));
        if (response.success === false) reject(new Error(String(response.error)));
        else {
          let data = response.data;
          if (data && typeof data === 'object') data = data.result ?? data.text ?? data.data ?? data;
          resolve(data);
        }
      });
    });
  } finally { socket.destroy(); }
}
const option = (name, fallback) => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;

async function main() {
  const binary = fs.realpathSync(option('binary', 'src-tauri/target/debug/o8'));
  if (!binary.startsWith(root + path.sep)) throw new Error('Only a binary built inside this worktree can be measured');
  const build = JSON.parse(fs.readFileSync(path.join(root, 'tmp/speed-evidence/native-build.json'), 'utf8'));
  if (build.identifier !== 'ai.o8.speed-baseline' || build.sha256 !== createHash('sha256').update(fs.readFileSync(binary)).digest('hex')) throw new Error('Use build-native.mjs to produce and attest a binary with a separate native settings namespace');
  const output = evidencePath(option('output', 'tmp/speed-evidence/native.json'));
  const soakMs = Number(option('soak-ms', '3600000'));
  const startupOnly = process.argv.includes('--startup-only');
  const pairedHeaps = process.argv.includes('--paired-heaps');
  if (!Number.isSafeInteger(soakMs) || soakMs < 0) throw new Error('Invalid soak-ms');
  const parent = path.join(path.dirname(output), `native-${Date.now()}`);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const receipt = { schema: 'o8/speed-native/v1', samples: [], failures: [], binary: path.relative(root, binary), build, soakMs, startupOnly, heapSnapshotMode: pairedHeaps ? 'paired' : 'after-only',
    limits: 'Local debug native build, optional speech helpers excluded. Loader FCP uses WebKit Paint Timing; rAF acknowledgement and accepted input are upper bounds, not OS compositor timestamps. No installed application control.' };
  const live = [];
  const close = async () => { for (const entry of live) { clearInterval(entry.feed); entry.nextInspector?.close(); entry.wsInspector?.close(); await stop(entry.owned); await entry.paint?.close(); } };
  process.once('SIGINT', () => { void close().then(() => process.exit(130)); });
  process.once('SIGTERM', () => { void close().then(() => process.exit(143)); });
  try {
    for (let i = 0; i < 3; i++) {
      const seeded = fixture(parent);
      const provider = nativeFixture(seeded);
      const tabState = fs.readFileSync(path.join(seeded.dataDir, 'terminal-states/tile-root.json'), 'utf8');
      let apiPort, paint;
      for (let attempt = 0; attempt < 20; attempt++) {
        apiPort = await freePort();
        try { paint = await paintController(apiPort); break; } catch { /* measurement port raced or was reserved */ }
      }
      if (!paint) throw new Error('No private native paint listener available');
      let wsPort = await freePort();
      while (wsPort === apiPort || wsPort === paint.port) wsPort = await freePort();
      const socket = path.join(parent, `n${i}.sock`);
      const env = { ...process.env, O8_PRESHIP_GATE: '1', O8_FORCE_BUNDLED_SERVERS: '1', O8_DATA_DIR: seeded.dataDir,
        CORTEX_IDE_DATA_DIR: seeded.dataDir, CORTEX_IDE_REPO_ROOT: seeded.repoDir, CORTEX_IDE_REVIEW_REPO_ROOT: seeded.repoDir,
        O8_API_PORT: String(apiPort), O8_WS_PORT: String(wsPort), O8_TAURI_MCP_SOCKET: socket,
        O8_DASH_TMUX_SERVER_NAME: `o8-speed-native-${process.pid}`, O8_NODE_BIN: process.execPath,
        O8_BOOT_TRACE: '1', NODE_OPTIONS: '--inspect=127.0.0.1:0' };
      delete env.O8_DEV_FRONTEND_URL;
      delete env.CORTEX_IDE_DB_PATH;
      delete env.CORTEX_IDE_OWNED_CODEX_ROOT;
      delete env.CORTEX_IDE_OWNED_CLAUDE_CODE_ROOT;
      delete env.O8_BOOT_ID;
      delete env.O8_INSTANCE_ID;
      const launchEpochMs = Date.now();
      const owned = launch([], env, path.join(parent, `native-${i}.log`), binary);
      const entry = { seeded, socket, owned, paint };
      live.push(entry);
      const health = (async () => {
        const tokenFile = path.join(seeded.dataDir, 'ws-token');
        while (!fs.existsSync(tokenFile)) {
          if (performance.now() - owned.started > 180000) throw new Error('Native token creation timed out');
          if (owned.child.exitCode !== null) throw new Error('Owned native process exited before token creation');
          await sleep(20);
        }
        const token = fs.readFileSync(tokenFile, 'utf8').trim();
        return Promise.all([
          healthy(`http://127.0.0.1:${apiPort}/api/panel/status`, owned, token),
          healthy(`http://127.0.0.1:${wsPort}/health`, owned, token),
        ]);
      })().then(times => ({ times }), error => ({ error }));
      const row = { sample: i + 1, launchEpochMs, firstPaintUpperBoundMs: null, interactiveMs: null };
      receipt.samples.push(row);
      while (performance.now() - owned.started < 180000) {
        if (owned.child.exitCode !== null) throw new Error(`Owned native build exited ${owned.child.exitCode}`);
        if (fs.existsSync(socket)) {
          try {
            const painted = await evaluate(socket, "(async () => { await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); return JSON.stringify({ url: location.pathname, body: !!document.body, composer: !!document.querySelector('textarea[data-o8-active-composer=\"true\"]'), hydrated: document.documentElement.getAttribute('data-o8-dashboard-hydrated') }); })()");
            const state = typeof painted === 'string' ? JSON.parse(painted) : painted;
            if (state.body && row.firstPaintUpperBoundMs === null) row.firstPaintUpperBoundMs = round(performance.now() - owned.started);
            if (state.composer && state.hydrated === '1') {
              const accepted = await evaluate(socket, "(() => { const input = document.querySelector('textarea[data-o8-active-composer=\"true\"]'); input.focus(); const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; setter.call(input, 'Unsent native speed probe'); input.dispatchEvent(new Event('input', { bubbles: true })); return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(document.activeElement === input && input.value === 'Unsent native speed probe')))); })()");
              if (accepted === true || accepted === 'true') { row.interactiveMs = round(performance.now() - owned.started); break; }
            }
          } catch { /* webview can navigate while the probe is in flight */ }
        }
        await sleep(100);
      }
      if (row.interactiveMs === null) throw new Error('Native composer did not accept input before deadline');
      const bootLog = fs.readFileSync(owned.logPath, 'utf8');
      const contextStart = bootLog.match(/BEFORE generate_context! at (\d+)ms/);
      const contextEnd = bootLog.match(/generate_context! DONE at (\d+)ms/);
      row.contextMs = contextStart && contextEnd ? Number(contextEnd[1]) - Number(contextStart[1]) : null;
      row.loaderPaintMarks = paint.marks.map(mark => ({ stage: mark.stage, durationMs: round(mark.epochMs - launchEpochMs), deliveryMs: round(mark.receivedEpochMs - mark.epochMs) }));
      row.loaderFirstContentfulPaintMs = row.loaderPaintMarks.find(mark => mark.stage === 'loader-first-contentful-paint')?.durationMs ?? null;
      row.bootRss = rss({ shell: owned.child.pid });
      const token = fs.readFileSync(path.join(seeded.dataDir, 'ws-token'), 'utf8').trim();
      const healthResult = await health;
      if (healthResult.error) throw healthResult.error;
      [row.nextHealthyMs, row.wsHealthyMs] = healthResult.times;
      if (startupOnly) {
        writeJson(output, receipt);
        await stop(owned);
        await paint.close();
        live.pop();
        continue;
      }
      fs.writeFileSync(path.join(seeded.dataDir, 'terminal-states/tile-root.json'), tabState);
      try { await evaluate(socket, `(() => { sessionStorage.setItem('cortex-global-repo-id', ${JSON.stringify(seeded.repoNames[0])}); location.reload(); return true; })()`); } catch { /* navigation resets the callback */ }
      let rendered = 0;
      for (let attempt = 0; attempt < 60; attempt++) {
        try {
          await evaluate(socket, `(() => { document.querySelector('[data-o8-workspace-tab="speed-chat-0"]')?.click(); return true; })()`);
          await refreshNativeHistory(wsPort, token, seeded.keys, attempt === 0);
          rendered = Number(await evaluate(socket, "document.querySelectorAll('[data-o8-message-id]').length"));
          if (rendered > 0) break;
        } catch { /* restoring the selected repository and tabs */ }
        await sleep(500);
      }
      if (!rendered) throw new Error('Native workload did not render persisted provider history');
      row.workload = { simulatedProvider: true, persistedEntriesPerSession: 300, renderedMessages: rendered, websocketHistoryLimit: 200, cadenceMs: 1000 };
      row.workloadBootRss = rss({ shell: owned.child.pid });
      entry.nextInspector = await inspector({ logPath: path.join(seeded.dataDir, 'logs/next-server.log') });
      entry.wsInspector = await inspector({ logPath: path.join(seeded.dataDir, 'logs/ws-server.log') });
      row.beforePostGc = { next: await postGc(entry.nextInspector), ws: await postGc(entry.wsInspector) };
      if (pairedHeaps) {
        const heapBefore = path.join(parent, `next-${i}-before.heapsnapshot`);
        await entry.nextInspector.snapshot(heapBefore);
        row.heapBefore = summarizeHeap(heapBefore);
      }
      let busy = false;
      entry.feed = setInterval(async () => {
        if (busy) return;
        busy = true;
        try { provider.advance(); await refreshNativeHistory(wsPort, token, seeded.keys); }
        catch (error) { (row.feedErrors ??= []).push(error.message); }
        finally { busy = false; }
      }, 1000);
      entry.row = row;
      entry.startedSoak = performance.now();
      row.soak = [];
      writeJson(output, receipt);
    }
    while (live.some(entry => performance.now() - entry.startedSoak < soakMs)) {
      await sleep(Math.min(15000, Math.max(1, ...live.map(entry => soakMs - (performance.now() - entry.startedSoak)))));
      for (const entry of live) if (performance.now() - entry.startedSoak >= (entry.row.soak.length + 1) * 60000) {
        const elapsedMs = round(performance.now() - entry.startedSoak);
        const rendered = JSON.parse(await evaluate(entry.socket, "JSON.stringify({ messages: document.querySelectorAll('[data-o8-message-id]').length, tick: Math.max(0, ...Array.from(document.body.innerText.matchAll(/Native streaming sample (\\d+)/g), match => Number(match[1]))) })"));
        entry.row.soak.push({ elapsedMs, rss: rss({ shell: entry.owned.child.pid }), next: await entry.nextInspector.usage(), ws: await entry.wsInspector.usage(), rendered });
      }
      writeJson(output, receipt);
    }
    for (const entry of live) {
      clearInterval(entry.feed);
      entry.row.actualSoakMs = round(performance.now() - entry.startedSoak);
      entry.row.hourRss = rss({ shell: entry.owned.child.pid });
      entry.row.renderedMessages = await evaluate(entry.socket, "document.querySelectorAll('[data-o8-message-id]').length");
      entry.row.afterPostGc = { next: await postGc(entry.nextInspector), ws: await postGc(entry.wsInspector) };
      const heapAfter = path.join(parent, `next-${entry.row.sample - 1}-after.heapsnapshot`);
      await entry.nextInspector.snapshot(heapAfter);
      entry.row.heapAfter = summarizeHeap(heapAfter);
      const vmmap = execFileSync('vmmap', ['-summary', String(entry.owned.child.pid)], { encoding: 'utf8', timeout: 60000 });
      fs.writeFileSync(path.join(parent, `shell-${entry.row.sample}-vmmap.private.txt`), vmmap, { mode: 0o600 });
      entry.row.nativeAllocationSummary = vmmap.slice(vmmap.indexOf('MALLOC ZONE'));
    }
    receipt.summary = { firstPaintUpperBoundMs: distribution(receipt.samples.map(row => row.firstPaintUpperBoundMs)), interactiveMs: distribution(receipt.samples.map(row => row.interactiveMs)) };
  } catch (error) { receipt.failures.push(error.message); }
  finally { await close(); }
  receipt.complete = receipt.failures.length === 0 && receipt.samples.length === 3 && receipt.samples.every(row => row.actualSoakMs >= 3600000 && !(row.feedErrors?.length) && Number(row.renderedMessages) > 0);
  writeJson(output, receipt);
  process.stdout.write(JSON.stringify(receipt, null, 2) + '\n');
  if (receipt.failures.length) process.exitCode = 1;
}
if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) await main();
