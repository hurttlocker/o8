/**
 * Symon Agent Mode — webview eval builders for the tool relay
 * (`/api/mobile/symon/tool`). Extracted from the route module: Next.js route
 * files may only export route handlers/config, so shared-with-tests helpers
 * live here (docs/internals/symon-agent-mode.md §POST /api/mobile/symon/tool).
 */

/**
 * Kick off (once) + poll the webview invoke, correlated by callId in a window
 * cache. `deriveOk` runs in-page (mirrors realtime-client.ts). Slots older than
 * 5 min are reaped so a dropped/late result can't leak memory.
 */
export function buildToolEval(
  sessionId: string,
  callId: string,
  tool: string,
  args: unknown,
  utterance?: string,
): string {
  const session = JSON.stringify(sessionId);
  const id = JSON.stringify(callId);
  const name = JSON.stringify(tool);
  const argsJson = JSON.stringify(args ?? {});
  const utteranceJson = JSON.stringify(utterance || undefined);
  return `(() => {
    const w = window;
    const A = w.__o8SymonAgent;
    const store = (w.__o8SymonToolCalls = w.__o8SymonToolCalls || {});
    const NOW = Date.now();
    const sessionId = ${session};
    const callId = ${id};
    const key = JSON.stringify([sessionId, callId]);
    for (const k in store) {
      const entry = store[k];
      if (!entry) continue;
      const terminalAt = entry.completedAt || entry.lastTouched || entry.startedAt || 0;
      const abandonedAt = entry.lastTouched || entry.startedAt || 0;
      if ((entry.done && NOW - terminalAt > 300000) || (k !== key && NOW - abandonedAt > 300000)) {
        delete store[k];
      }
    }
    if (!A || typeof A.invokeTool !== 'function') return JSON.stringify({ state: 'no_bridge' });
    let slot = store[key];
    if (!slot) {
      slot = store[key] = { startedAt: NOW, lastTouched: NOW, done: false, decisionSubmitted: false, tool: ${name} };
      Promise.resolve().then(() => A.invokeTool(${name}, ${argsJson}, { sessionId, callId }, ${utteranceJson})).then((result) => {
        const errored = !!(result && typeof result === 'object' && 'error' in result);
        store[key] = Object.assign(store[key] || {}, { done: true, completedAt: Date.now(), ok: !errored, result: result });
      }).catch((e) => {
        store[key] = Object.assign(store[key] || {}, { done: true, completedAt: Date.now(), ok: false, result: { error: 'tool_failed', detail: String((e && e.message) || e) } });
      });
    }
    if (!slot.done) slot.lastTouched = NOW;
    if (slot.tool !== ${name}) return JSON.stringify({ state: 'call_mismatch' });
    if (slot.done) return JSON.stringify({ state: 'done', ok: slot.ok, result: slot.result });
    if (Array.isArray(A.pendingConfirmations)) {
      const hit = A.pendingConfirmations.find((c) => c && c.sessionId === sessionId && c.callId === callId && c.tool === ${name});
      if (hit && hit.confirmationId !== slot.confirmationId) {
        slot.confirmation = hit;
        slot.confirmationId = hit.confirmationId;
        slot.decisionSubmitted = false;
        delete slot.confirmResolution;
      }
    }
    if (slot.confirmation && !slot.decisionSubmitted) {
      return JSON.stringify({ state: 'needs_confirmation', confirmation: slot.confirmation });
    }
    return JSON.stringify({ state: 'pending' });
  })()`;
}

export function buildToolInterruptEval(sessionId: string, callId: string): string {
  const session = JSON.stringify(sessionId);
  const id = JSON.stringify(callId);
  return `(() => {
    const w = window;
    const A = w.__o8SymonAgent;
    if (!A || typeof A.interruptTool !== 'function') return JSON.stringify({ state: 'no_bridge' });
    const sessionId = ${session};
    const callId = ${id};
    const key = JSON.stringify([sessionId, callId]);
    const interrupts = (w.__o8SymonToolInterrupts = w.__o8SymonToolInterrupts || {});
    const NOW = Date.now();
    for (const interruptKey in interrupts) {
      const candidate = interrupts[interruptKey];
      if (candidate && NOW - (candidate.startedAt || 0) > 300000) delete interrupts[interruptKey];
    }
    let entry = interrupts[key];
    if (!entry) {
      entry = interrupts[key] = { startedAt: NOW, done: false };
      Promise.resolve().then(() => A.interruptTool({ sessionId, callId })).then((active) => {
        interrupts[key] = Object.assign(interrupts[key] || {}, { done: true, active: Boolean(active) });
      }).catch((error) => {
        interrupts[key] = Object.assign(interrupts[key] || {}, {
          done: true,
          error: String((error && error.message) || error),
        });
      });
    }
    if (entry.done && entry.error) {
      delete interrupts[key];
      return JSON.stringify({ state: 'error', detail: entry.error });
    }
    if (entry.done) return JSON.stringify({ state: 'done', active: entry.active });
    return JSON.stringify({ state: 'pending' });
  })()`;
}
