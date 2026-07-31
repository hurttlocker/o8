export interface SymonTextPlannerSelection {
  engine: 'claude' | 'codex';
  model: string;
  effort: string;
}

export function buildSymonTextPlannerInfoEval(selection?: SymonTextPlannerSelection): string {
  const requested = JSON.stringify(selection ?? null);
  return `(() => {
    const A = window.__o8SymonAgent;
    if (!A || !A.text || typeof A.text.plannerInfo !== 'function') return JSON.stringify({ state: 'no_bridge' });
    const requested = ${requested};
    const stores = (window.__o8SymonTextPlannerInfo = window.__o8SymonTextPlannerInfo || {});
    const key = JSON.stringify(requested);
    const store = (stores[key] = stores[key] || { done: false });
    if (!store.started) {
      store.started = true;
      Promise.resolve().then(() => A.text.plannerInfo(requested || undefined)).then((info) => {
        Object.assign(store, { done: true, info });
      }).catch((error) => {
        Object.assign(store, { done: true, error: String((error && error.message) || error) });
      });
    }
    if (store.error) {
      const detail = store.error;
      delete stores[key];
      return JSON.stringify({ state: 'error', detail });
    }
    if (store.done) {
      const info = store.info;
      delete stores[key];
      return JSON.stringify({ state: 'done', info });
    }
    return JSON.stringify({ state: 'pending' });
  })()`;
}

export function buildSymonTextTurnEval(
  sessionId: string,
  turnId: string,
  prompt: string,
  planner: SymonTextPlannerSelection,
): string {
  const session = JSON.stringify(sessionId);
  const turn = JSON.stringify(turnId);
  const content = JSON.stringify(prompt);
  const selection = JSON.stringify(planner);
  return `(() => {
    const A = window.__o8SymonAgent;
    if (!A || !A.text || typeof A.text.runTurn !== 'function') return JSON.stringify({ state: 'no_bridge' });
    const calls = (window.__o8SymonToolCalls = window.__o8SymonToolCalls || {});
    const sessionId = ${session};
    const callId = ${turn};
    const key = JSON.stringify([sessionId, callId]);
    let slot = calls[key];
    if (!slot) {
      slot = calls[key] = { startedAt: Date.now(), lastTouched: Date.now(), done: false, textTurn: true };
      Promise.resolve().then(() => A.text.runTurn(${content}, sessionId, callId, ${selection})).then((result) => {
        Object.assign(slot, { done: true, completedAt: Date.now(), result });
      }).catch((error) => {
        Object.assign(slot, { done: true, completedAt: Date.now(), error: String((error && error.message) || error) });
      });
    }
    slot.lastTouched = Date.now();
    if (!slot.textTurn) return JSON.stringify({ state: 'call_mismatch' });
    if (slot.done) return slot.error
      ? JSON.stringify({ state: 'error', detail: slot.error })
      : JSON.stringify({ state: 'done', result: slot.result });
    if (Array.isArray(A.pendingConfirmations)) {
      const hit = A.pendingConfirmations.find((candidate) => candidate && candidate.sessionId === sessionId && candidate.callId === callId);
      if (hit && hit.confirmationId !== slot.confirmationId) {
        slot.confirmation = hit;
        slot.confirmationId = hit.confirmationId;
        slot.decisionSubmitted = false;
      }
    }
    if (slot.confirmation && !slot.decisionSubmitted) {
      return JSON.stringify({ state: 'needs_confirmation', confirmation: slot.confirmation });
    }
    return JSON.stringify({ state: 'pending' });
  })()`;
}

export function buildSymonTextInterruptEval(sessionId: string, turnId: string): string {
  const session = JSON.stringify(sessionId);
  const turn = JSON.stringify(turnId);
  return `(() => {
    const A = window.__o8SymonAgent;
    if (!A || !A.text || typeof A.text.interruptTurn !== 'function') return JSON.stringify({ state: 'no_bridge' });
    const sessionId = ${session};
    const turnId = ${turn};
    const interrupts = (window.__o8SymonTextInterrupts = window.__o8SymonTextInterrupts || {});
    const key = JSON.stringify([sessionId, turnId]);
    let slot = interrupts[key];
    if (!slot) {
      slot = interrupts[key] = { done: false };
      Promise.resolve().then(() => A.text.interruptTurn(sessionId, turnId)).then((active) => {
        Object.assign(slot, { done: true, active: Boolean(active) });
      }).catch((error) => {
        Object.assign(slot, { done: true, error: String((error && error.message) || error) });
      });
    }
    if (!slot.done) return JSON.stringify({ state: 'pending' });
    return slot.error
      ? JSON.stringify({ state: 'error', detail: slot.error })
      : JSON.stringify({ state: 'done', active: slot.active });
  })()`;
}
