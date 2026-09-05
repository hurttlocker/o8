/**
 * The frame ↔ host bridge for interactive task artifacts (#1699).
 *
 * The frame is untrusted agent-authored HTML in an opaque-origin sandbox. It
 * talks to the host only through `postMessage`, and the host accepts only the
 * message shapes below, only from its own iframe window, only when they carry
 * the per-mount capability token the host minted, and only for actions the
 * agent declared at creation. `validateFrameMessage` is the pure gate every
 * incoming frame message crosses; it runs in the browser and in tests.
 */
import { TASK_ARTIFACT_LIMITS, TASK_ARTIFACT_ACTION_NAME_PATTERN } from './types';

export const TASK_ARTIFACT_BRIDGE_VERSION = 1;

/** Frame → host. `o8:ready` is the only message allowed before the token exists. */
export type FrameToHostMessage =
  | { type: 'o8:ready'; bridge: number }
  | { type: 'o8:height'; token: string; height: number }
  | { type: 'o8:draft'; token: string; draft: unknown }
  | { type: 'o8:submit'; token: string; requestId: string; action: string; payload: unknown };

/** Host → frame. */
export type HostToFrameMessage =
  | {
      type: 'o8:init';
      token: string;
      artifactId: string;
      title: string;
      actions: Array<{ name: string; label: string }>;
      draft: unknown;
      writable: boolean;
      reason: string | null;
    }
  | { type: 'o8:state'; writable: boolean; reason: string | null }
  | { type: 'o8:collect'; token: string; action: string }
  | { type: 'o8:result'; requestId: string; ok: boolean; error: string | null; actionId: string | null; delivery: string | null };

export type FrameMessageVerdict =
  | { ok: true; message: FrameToHostMessage }
  | { ok: false; reason: string };

const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_MESSAGE_BYTES = TASK_ARTIFACT_LIMITS.payloadMaxBytes + 4096;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function byteLength(value: unknown): number {
  try {
    const text = JSON.stringify(value);
    return typeof text === 'string' ? new TextEncoder().encode(text).length : Number.MAX_SAFE_INTEGER;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

/**
 * Gate one message the host received. `sourceIsFrame` is the host's own
 * identity check (`event.source === iframe.contentWindow`); everything else is
 * decided here so the rule set is testable without a DOM.
 */
export function validateFrameMessage(input: {
  data: unknown;
  sourceIsFrame: boolean;
  token: string | null;
  declaredActions: readonly string[];
}): FrameMessageVerdict {
  if (!input.sourceIsFrame) return { ok: false, reason: 'message did not come from the artifact frame' };
  const data = input.data;
  if (!isRecord(data) || typeof data.type !== 'string') return { ok: false, reason: 'malformed message' };
  if (byteLength(data) > MAX_MESSAGE_BYTES) return { ok: false, reason: 'message exceeds the size limit' };

  if (data.type === 'o8:ready') {
    if (data.bridge !== TASK_ARTIFACT_BRIDGE_VERSION) return { ok: false, reason: 'unsupported bridge version' };
    return { ok: true, message: { type: 'o8:ready', bridge: TASK_ARTIFACT_BRIDGE_VERSION } };
  }

  if (!input.token) return { ok: false, reason: 'frame is not initialized' };
  if (typeof data.token !== 'string' || data.token !== input.token) return { ok: false, reason: 'capability token mismatch' };

  switch (data.type) {
    case 'o8:height': {
      if (typeof data.height !== 'number' || !Number.isFinite(data.height) || data.height < 0 || data.height > 20_000) {
        return { ok: false, reason: 'invalid height' };
      }
      return { ok: true, message: { type: 'o8:height', token: data.token, height: Math.round(data.height) } };
    }
    case 'o8:draft': {
      if (byteLength(data.draft) > TASK_ARTIFACT_LIMITS.draftMaxBytes) return { ok: false, reason: 'draft exceeds the size limit' };
      return { ok: true, message: { type: 'o8:draft', token: data.token, draft: data.draft } };
    }
    case 'o8:submit': {
      if (typeof data.requestId !== 'string' || !REQUEST_ID_PATTERN.test(data.requestId)) return { ok: false, reason: 'invalid requestId' };
      if (typeof data.action !== 'string' || !TASK_ARTIFACT_ACTION_NAME_PATTERN.test(data.action)) return { ok: false, reason: 'invalid action name' };
      if (!input.declaredActions.includes(data.action)) return { ok: false, reason: `action "${data.action}" was not declared` };
      if (!isRecord(data.payload)) return { ok: false, reason: 'payload must be an object' };
      if (byteLength(data.payload) > TASK_ARTIFACT_LIMITS.payloadMaxBytes) return { ok: false, reason: 'payload exceeds the size limit' };
      return { ok: true, message: { type: 'o8:submit', token: data.token, requestId: data.requestId, action: data.action, payload: data.payload } };
    }
    default:
      return { ok: false, reason: `unknown message type "${data.type}"` };
  }
}

/** Mint the per-mount capability token. Never persisted; a reload mints a new one. */
export function mintBridgeToken(): string {
  const bytes = new Uint8Array(24);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

/**
 * The script injected at the top of every artifact document. It exposes
 * `window.o8` and nothing else. It never sees the host page, the token is
 * handed over only after the host verified the frame, and every outbound call
 * goes through `parent.postMessage`.
 */
export const TASK_ARTIFACT_FRAME_BOOTSTRAP = `(function () {
  var BRIDGE = ${TASK_ARTIFACT_BRIDGE_VERSION};
  var token = null, ready = false, seq = 0, draft = null, initMsg = null;
  var pending = {};
  var handlers = { init: [], state: [], result: [], collect: null };
  function post(m) { try { parent.postMessage(m, '*'); } catch (e) {} }
  function reportHeight() {
    if (!token) return;
    var h = Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0);
    post({ type: 'o8:height', token: token, height: h });
  }
  window.addEventListener('message', function (e) {
    if (e.source !== parent) return;
    var m = e.data;
    if (!m || typeof m.type !== 'string') return;
    if (m.type === 'o8:init') {
      token = m.token; draft = m.draft; initMsg = m; ready = true;
      handlers.init.forEach(function (fn) { try { fn(m); } catch (err) {} });
      reportHeight();
    } else if (m.type === 'o8:state') {
      handlers.state.forEach(function (fn) { try { fn(m); } catch (err) {} });
    } else if (m.type === 'o8:result') {
      var p = pending[m.requestId];
      if (p) { delete pending[m.requestId]; if (m.ok) p.resolve(m); else p.reject(new Error(m.error || 'rejected')); }
      handlers.result.forEach(function (fn) { try { fn(m); } catch (err) {} });
    } else if (m.type === 'o8:collect') {
      if (!handlers.collect) return;
      Promise.resolve().then(function () { return handlers.collect(m.action); }).then(function (payload) {
        if (payload && typeof payload === 'object') window.o8.submit(m.action, payload);
      }).catch(function () {});
    }
  });
  window.o8 = {
    onInit: function (fn) { handlers.init.push(fn); if (ready && initMsg) { try { fn(initMsg); } catch (err) {} } },
    onState: function (fn) { handlers.state.push(fn); },
    onResult: function (fn) { handlers.result.push(fn); },
    onCollect: function (fn) { handlers.collect = fn; },
    submit: function (action, payload) {
      return new Promise(function (resolve, reject) {
        if (!token) { reject(new Error('artifact is not initialized')); return; }
        var id = 'r' + (++seq);
        pending[id] = { resolve: resolve, reject: reject };
        post({ type: 'o8:submit', token: token, requestId: id, action: action, payload: payload });
      });
    },
    saveDraft: function (d) { draft = d; if (token) post({ type: 'o8:draft', token: token, draft: d }); },
    getDraft: function () { return draft; },
    reportHeight: reportHeight
  };
  if (typeof ResizeObserver !== 'undefined') {
    try {
      var ro = new ResizeObserver(function () { reportHeight(); });
      if (document.body) ro.observe(document.body);
      if (document.documentElement) ro.observe(document.documentElement);
    } catch (e) {}
  }
  window.addEventListener('load', reportHeight);
  post({ type: 'o8:ready', bridge: BRIDGE });
})();`;
