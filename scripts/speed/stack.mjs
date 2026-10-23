import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { buildFixturePlan, materializeFixture } from '../bench/interactions/fixtures.mjs';
import { freePort, healthy, launch, root, stop } from './common.mjs';

export function fixture(parent, sessions = 4) {
  const plan = buildFixturePlan(1, 2887);
  const keys = Array.from({ length: sessions }, (_, i) => `codex-owned:speed-fixture-${i}`);
  plan.tabs = keys.map((key, i) => ({ id: `speed-chat-${i}`, label: `Speed session ${i}`, kind: 'chat', chatRuntime: 'codex', chatSessionKey: key }));
  const seeded = materializeFixture(plan, { root: parent });
  const file = path.join(seeded.dataDir, 'terminal-states/tile-root.json');
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  state.activeTabId = plan.tabs[0].id;
  state.tabs.forEach((tab, i) => Object.assign(tab, plan.tabs[i]));
  fs.writeFileSync(file, JSON.stringify(state));
  return { ...seeded, keys };
}
export async function startStack(seeded, evidence, mode = 'production') {
  const apiPort = await freePort();
  let wsPort = await freePort();
  while (wsPort === apiPort) wsPort = await freePort();
  const token = randomBytes(32).toString('hex');
  fs.writeFileSync(path.join(seeded.dataDir, 'ws-token'), token, { mode: 0o600 });
  const env = { ...process.env, NODE_ENV: mode === 'production' ? 'production' : 'development',
    O8_DATA_DIR: seeded.dataDir, CORTEX_IDE_DATA_DIR: seeded.dataDir,
    CORTEX_IDE_REPO_ROOT: seeded.repoDir, CORTEX_IDE_REVIEW_REPO_ROOT: seeded.repoDir,
    PORT: String(apiPort), O8_API_PORT: String(apiPort), WS_PORT: String(wsPort), O8_WS_PORT: String(wsPort),
    WS_TOKEN: token, O8_TAURI_MCP_SOCKET: path.join(seeded.dataDir, 'native.sock'),
    O8_DASH_TMUX_SERVER_NAME: `o8-speed-${process.pid}`, O8_INTERACTION_RUN_TAG: `speed-${process.pid}`,
    O8_SPEED_TRACE: path.join(evidence, 'process-spans.jsonl'),
  };
  delete env.__NEXT_PRIVATE_STANDALONE_CONFIG;
  delete env.O8_PACKAGED_APP;
  delete env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  delete env.CLERK_PUBLISHABLE_KEY;
  delete env.NODE_OPTIONS;
  delete env.CORTEX_IDE_DB_PATH;
  delete env.CORTEX_IDE_OWNED_CODEX_ROOT;
  delete env.CORTEX_IDE_OWNED_CLAUDE_CODE_ROOT;
  delete env.O8_BOOT_ID;
  delete env.O8_INSTANCE_ID;
  const hook = path.join(root, 'scripts/speed/process-hook.cjs');
  const next = launch(['--inspect=127.0.0.1:0', '--require', hook, 'node_modules/next/dist/bin/next', mode === 'production' ? 'start' : 'dev', '-p', String(apiPort), '-H', '127.0.0.1'], env, path.join(evidence, 'next.log'));
  const ws = launch(['--inspect=127.0.0.1:0', '--require', hook, '--import', './scripts/register-server-only-stub.mjs', '--import', 'tsx', 'src/ws-server.ts'], env, path.join(evidence, 'ws.log'));
  try {
    const [nextHealthyMs, wsHealthyMs] = await Promise.all([
      healthy(`http://127.0.0.1:${apiPort}/api/panel/status`, next, token),
      healthy(`http://127.0.0.1:${wsPort}/health`, ws, token),
    ]);
    return { env, token, apiPort, wsPort, base: `http://127.0.0.1:${apiPort}`, next, ws, nextHealthyMs, wsHealthyMs,
      close: async () => { await Promise.all([stop(next), stop(ws)]); } };
  } catch (error) {
    await Promise.all([stop(next), stop(ws)]);
    throw error;
  }
}
