import { randomUUID } from 'node:crypto';

import { O8WebviewClient } from '@/lib/mcp/o8-webview-client';

const TTS_TIMEOUT_MS = 5 * 60_000;
const POLL_MS = 100;

let client: O8WebviewClient | null = null;
let nativeTtsTail: Promise<void> = Promise.resolve();

function webviewClient(): O8WebviewClient {
  if (!client) client = new O8WebviewClient();
  return client;
}

async function speakBroadcastWithNativeTtsOnce(text: string): Promise<void> {
  const key = `__o8BroadcastTts_${randomUUID().replaceAll('-', '')}`;
  const keyLiteral = JSON.stringify(key);
  const code = `(() => {
    const key = ${keyLiteral};
    window[key] = { state: 'pending' };
    try {
      const invoke = window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke;
      if (typeof invoke !== 'function') throw new Error('Tauri invoke is unavailable');
      invoke('broadcast_tts_speak', { text: ${JSON.stringify(text)} })
        .then((heard) => { window[key] = { state: heard ? 'done' : 'interrupted' }; })
        .catch((error) => { window[key] = { state: 'error', error: String(error) }; });
      return 'started';
    } catch (error) {
      window[key] = { state: 'error', error: String(error) };
      return 'failed';
    }
  })()`;
  await webviewClient().evalJs(code);

  const deadline = Date.now() + TTS_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const result = await webviewClient().evalJs(`(() => JSON.stringify(window[${keyLiteral}] || { state: 'missing' }))()`);
    const state = JSON.parse(result.result) as { state?: string; error?: string };
    if (state.state === 'done') {
      await webviewClient().queueEvalJs(`(() => { delete window[${keyLiteral}]; return 'ok'; })()`);
      return;
    }
    if (state.state === 'error' || state.state === 'interrupted' || state.state === 'missing') {
      throw new Error(state.error || `Native Broadcast TTS ${state.state}.`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  throw new Error('Native Broadcast TTS timed out.');
}

export function speakBroadcastWithNativeTts(text: string): Promise<void> {
  const run = nativeTtsTail.then(() => speakBroadcastWithNativeTtsOnce(text));
  nativeTtsTail = run.catch(() => undefined);
  return run;
}
