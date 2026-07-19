import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  createO8WebviewBrowserHandlers,
  O8_WEBVIEW_BROWSER_TOOLS,
} from '@/lib/mcp/o8-webview-browser-tools';
import {
  createO8WebviewCompositeHandlers,
  O8_WEBVIEW_COMPOSITE_TOOLS,
} from '@/lib/mcp/o8-webview-composites';
import { O8WebviewClient } from '@/lib/mcp/o8-webview-client';
import { buildPrepareComposerTargetScript } from '@/lib/mcp/o8-webview-composer-target';

type TextContent = { type: 'text'; text: string };
type ImageContent = { type: 'image'; data: string; mimeType: string };
type McpToolResult = {
  content: Array<TextContent | ImageContent>;
  isError?: boolean;
};

type McpTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

type ToolHandler = (args: Record<string, unknown>) => Promise<McpToolResult>;

function textResult(text: string, isError = false): McpToolResult {
  return {
    content: [{ type: 'text', text }],
    isError,
  };
}

function jsonResult(data: unknown, isError = false): McpToolResult {
  return textResult(JSON.stringify(data), isError);
}

// Cap eval results at 8KB before they cross the MCP socket. Issue #868:
// busy pages (eg. /context-graph) sometimes leak large blobs — base64
// screenshots, full document.body.outerHTML — through eval, hanging the
// socket and burning agent context. The cap lives at the o8_view_eval
// handler boundary, NOT in evalJs(), because internal callers (click,
// readPage, waitFor) depend on full strings round-tripping through eval.
const EVAL_RESULT_BYTE_CAP = 8 * 1024;

// Reject base64 image blobs explicitly — eval is not the right channel
// for binary image data. Detect both data URLs (`data:image/...;base64,...`)
// and raw long base64 strings whose first bytes decode to a known image
// magic number.
const IMAGE_DATA_URL_RE = /^data:image\/[a-z0-9+.\-]+;base64,/i;

function looksLikeBase64Image(text: string): boolean {
  if (text.length < 256) {
    return false;
  }
  if (IMAGE_DATA_URL_RE.test(text)) {
    return true;
  }
  // Heuristic: long, well-formed base64, with image magic in the first
  // few bytes. We sample only the first 64 chars (48 bytes decoded) so
  // we don't allocate the full payload to inspect it.
  const head = text.slice(0, 64);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(head)) {
    return false;
  }
  try {
    const bytes = Buffer.from(head, 'base64');
    if (bytes.length < 4) {
      return false;
    }
    // PNG: 89 50 4E 47, JPEG: FF D8 FF, GIF: 47 49 46 38
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
      return true;
    }
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
      return true;
    }
    if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

function capEvalResult(raw: string): McpToolResult {
  if (looksLikeBase64Image(raw)) {
    return jsonResult({
      ok: false,
      error: {
        code: 'EVAL_RETURNED_IMAGE',
        message: 'eval result looks like a base64 image blob — use o8_view_screenshot for image data',
        sizeBytes: Buffer.byteLength(raw, 'utf8'),
      },
    }, true);
  }

  const sizeBytes = Buffer.byteLength(raw, 'utf8');
  if (sizeBytes <= EVAL_RESULT_BYTE_CAP) {
    return textResult(raw);
  }

  // Slice at a UTF-8-safe byte boundary, then JSON-encode the envelope.
  const buf = Buffer.from(raw, 'utf8').subarray(0, EVAL_RESULT_BYTE_CAP);
  const preview = buf.toString('utf8');
  return jsonResult({
    truncated: true,
    sizeBytes,
    capBytes: EVAL_RESULT_BYTE_CAP,
    preview,
  });
}

// o8_view_read returns document.body.innerText, which is unbounded — a long
// transcript / log / chat page floods the caller's context. readPage() calls
// evalJs internally, so it does NOT pass through the o8_view_eval-handler cap;
// cap it here with the same truncation-envelope shape.
const READ_RESULT_BYTE_CAP = 16 * 1024;

function capText(raw: string, capBytes: number): McpToolResult {
  const sizeBytes = Buffer.byteLength(raw, 'utf8');
  if (sizeBytes <= capBytes) {
    return textResult(raw);
  }
  const preview = Buffer.from(raw, 'utf8').subarray(0, capBytes).toString('utf8');
  return jsonResult({
    truncated: true,
    sizeBytes,
    capBytes,
    preview,
  });
}

// Sibling of #868 — three Phase 2 audit agents (Recall Card, status-grouped
// lanes, packet spec) flagged that the Rust execute_js bridge silently
// returns the empty string when the user's last expression evaluates to a
// non-JSON-serializable value (functions, DOM elements, circular refs) or
// when a multi-statement script doesn't explicitly return.
//
// Fix: wrap the user's code in an outer IIFE that:
//   1. Evaluates the code via indirect eval — `(0, eval)(code)` — which
//      preserves completion-value semantics so `var x = 42; x` returns 42
//      (whereas `new Function(body)` would silently return undefined).
//   2. Catches any throw and returns `{ ok: false, error }`.
//   3. Probes `JSON.stringify` on the result. If it succeeds AND the value
//      key survives the round-trip, returns `{ ok: true, value }`. If
//      stringify throws (circular ref) OR drops the value key (function,
//      undefined, top-level non-enumerable), falls back to `String(result)`
//      so toString() still surfaces the value.
//   4. console.warn on the renderer side when the fallback fires so
//      operators can see in DevTools that a non-serializable came back.
//
// This eliminates the "silently returns undefined" bug for medium-complexity
// expressions like `JSON.stringify(arrayOfObjects)`,
// `(() => { var x = ...; x.click(); return x.id; })()`, and
// `var x = setItem(...); x`.

// Phase 4 follow-up — bare object-literal expressions are a known JS parser
// ambiguity. `{a: 1}` parses as a block statement (label `a:` + expression
// `1`), so the indirect eval returns `1` rather than `{a:1}`. Detect single
// object-literal expressions via a small balanced-brace + statement-keyword
// heuristic and parens-wrap them so the parser sees an expression. Multi-
// statement code (var/let/const/return + body) still goes through the
// regular path.
function looksLikeObjectLiteralExpression(trimmed: string): boolean {
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return false;
  // Cheap statement-keyword reject — reduces false positives without a
  // full tokenizer. These won't appear inside a normal object literal in
  // a way that matters for the heuristic.
  if (/\b(?:var|let|const|return|function|if|for|while|do|switch|try|throw|class)\b/.test(trimmed)) {
    return false;
  }
  let depth = 0;
  let inString: '"' | "'" | '`' | null = null;
  let escaped = false;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (escaped) { escaped = false; continue; }
    if (inString) {
      if (ch === '\\') { escaped = true; continue; }
      if (ch === inString) { inString = null; }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { inString = ch; continue; }
    if (ch === '{' || ch === '[' || ch === '(') { depth++; continue; }
    if (ch === '}' || ch === ']' || ch === ')') {
      depth--;
      // If the outer `{` closes before the very end, this isn't a single
      // object-literal expression (eg. `{a:1}{b:2}`).
      if (depth === 0 && i !== trimmed.length - 1) return false;
      continue;
    }
    if (ch === ';' && depth === 1) return false;
  }
  return depth === 0;
}

function wrapEvalCode(userCode: string): string {
  const trimmed = userCode.trim();
  // Run the user code via indirect eval — `(0, eval)(code)` evaluates in the
  // global scope AND returns the completion value of the last statement,
  // which is what the user expects when they write `var x = 42; x`. Direct
  // `new Function(code)` would silently return undefined because function
  // bodies require an explicit `return`.
  //
  // Phase 4 follow-up: bare object literals (`{a:1}`) need a parens wrap
  // so the parser sees them as expressions instead of block statements.
  //
  // After we have the value, probe JSON.stringify behaviour:
  //   - If JSON.stringify drops the value key (function, undefined,
  //     non-enumerable), fall back to String(value) and tag the envelope
  //     with nonSerializable:true.
  //   - If JSON.stringify throws (circular ref), fall back identically.
  //   - Otherwise return the envelope as-is.
  //
  // Errors during eval surface as { ok: false, error: { message, name, stack } }.
  const evalSource = looksLikeObjectLiteralExpression(trimmed)
    ? `(${trimmed})`
    : trimmed;
  const codeJson = JSON.stringify(evalSource);
  return `(() => {
  const __o8_user_code__ = ${codeJson};
  let __o8_value__;
  try {
    // Indirect eval — (0, eval) — evaluates in global scope and preserves
    // completion-value semantics for statement bodies.
    __o8_value__ = (0, eval)(__o8_user_code__);
  } catch (__o8_err__) {
    return JSON.stringify({
      ok: false,
      error: {
        message: (__o8_err__ && __o8_err__.message) || String(__o8_err__),
        name: (__o8_err__ && __o8_err__.name) || 'Error',
        stack: (__o8_err__ && __o8_err__.stack) || null,
      },
    });
  }

  // Probe JSON serializability. JSON.stringify on a top-level non-serializable
  // (function, undefined) returns undefined; on a property with such a value
  // it drops the key. We detect both via a marker: stringify { value: x } and
  // check the parsed envelope still has the key.
  let __o8_serialized__;
  let __o8_throwOnSerialize__ = false;
  try {
    __o8_serialized__ = JSON.stringify({ ok: true, value: __o8_value__ });
  } catch (__o8_serialize_err__) {
    __o8_throwOnSerialize__ = true;
    try {
      console.warn('[o8_view_eval] JSON.stringify threw, falling back to String():', __o8_serialize_err__ && __o8_serialize_err__.message);
    } catch (_) {}
  }

  // Detect the dropped-key case: stringify succeeded but the value field is
  // missing in the round-tripped envelope (function or undefined property).
  let __o8_keyDropped__ = false;
  if (!__o8_throwOnSerialize__ && typeof __o8_serialized__ === 'string') {
    try {
      const __o8_parsed__ = JSON.parse(__o8_serialized__);
      if (!('value' in __o8_parsed__)) {
        __o8_keyDropped__ = true;
        try {
          console.warn('[o8_view_eval] non-serializable result (key dropped), falling back to String(): typeof =', typeof __o8_value__);
        } catch (_) {}
      }
    } catch (_) {
      __o8_throwOnSerialize__ = true;
    }
  }

  if (!__o8_throwOnSerialize__ && !__o8_keyDropped__ && typeof __o8_serialized__ === 'string') {
    return __o8_serialized__;
  }

  // Fallback path — String(value) the result so the caller still sees
  // something useful (eg. "[object HTMLDivElement]" for DOM nodes,
  // "function ..." for functions). Includes nonSerializable:true so callers
  // can distinguish this case from a normal serialized return.
  let __o8_string__;
  try {
    __o8_string__ = String(__o8_value__);
  } catch (__o8_string_err__) {
    __o8_string__ = '[unstringifiable value]';
  }
  try {
    return JSON.stringify({
      ok: true,
      value: __o8_string__,
      nonSerializable: true,
      valueType: typeof __o8_value__,
    });
  } catch (_) {
    return '{"ok":true,"value":"[unrepresentable]","nonSerializable":true}';
  }
})()`;
}

function imageResult(base64: string, mimeType: string, meta: Record<string, unknown>): McpToolResult {
  return {
    content: [
      { type: 'image', data: base64, mimeType },
      { type: 'text', text: JSON.stringify(meta) },
    ],
  };
}

/** Persist a captured screenshot to a temp file so consumers that can't carry
 *  the base64 (the canvas, whose orchestrator stream truncates tool output) can
 *  still SHOW it via /api/panel/serve-image. Returns the path, or null if the
 *  write fails — the base64 in the result is always the source of truth. */
const SCREENSHOT_DIR = '/tmp/o8-screenshots';
function persistScreenshot(base64: string, mimeType: string): string | null {
  try {
    mkdirSync(SCREENSHOT_DIR, { recursive: true });
    const ext = mimeType.includes('jpeg') ? 'jpg' : 'png';
    const file = join(SCREENSHOT_DIR, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`);
    writeFileSync(file, Buffer.from(base64, 'base64'));
    return file;
  } catch {
    return null;
  }
}

function structuredErrorResult(error: unknown): McpToolResult {
  const message = error instanceof Error ? error.message : String(error);
  const code = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;

  return jsonResult({
    ok: false,
    error: {
      message,
      code: code ?? null,
    },
  }, true);
}

function parseOptionalNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return undefined;
}

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${key} is required`);
  }
  return value.trim();
}

async function withStructuredErrors(
  action: () => Promise<McpToolResult>,
): Promise<McpToolResult> {
  try {
    return await action();
  } catch (error) {
    return structuredErrorResult(error);
  }
}

export const O8_WEBVIEW_TOOLS: McpTool[] = [
  ...O8_WEBVIEW_COMPOSITE_TOOLS,
  ...O8_WEBVIEW_BROWSER_TOOLS,
  {
    name: 'o8_view_screenshot',
    description: 'USE THIS WHEN the user asks what their o8 screen looks like, wants you to debug a visual bug, or says "look at o8 / take a screenshot / what do you see". Returns base64 PNG of the running o8 desktop app window. The Rust-side capture works even when the JS thread is busy.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'o8_view_snapshot',
    description: 'USE THIS BEFORE o8_view_click when you need to find a button or element by its label rather than guessing coordinates. Returns a numbered accessibility tree of the current o8 view. Each clickable element gets a ref number you pass to o8_view_click.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'o8_view_click',
    description: 'Click an element in o8. PREFER semantic targeting: pass `text` (the element\'s visible text or aria-label) or `role`+`name` — resolved and clicked in a single in-page step, robust under load and immune to coordinate drift. `ref` (from o8_view_snapshot) also works. Use {x, y} CSS-pixel coordinates only as a last resort when no stable label exists — agents should drive o8 by intent, not pixels.',
    inputSchema: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'Visible text or aria-label of the element to click, e.g. "New session" or "Archived". Exact match wins; falls back to a contains-match on clickable elements. The agent-first way to click — no coordinates, no prior snapshot.',
        },
        role: {
          type: 'string',
          description: 'ARIA role or tag name to target, paired with `name` (e.g. role "button", name "Restart").',
        },
        name: {
          type: 'string',
          description: 'Accessible name (aria-label or text) to match alongside `role`.',
        },
        ref: {
          type: 'number',
          description: 'Element ref from o8_view_snapshot.',
        },
        x: {
          type: 'number',
          description: 'X coordinate in CSS pixels (last-resort fallback).',
        },
        y: {
          type: 'number',
          description: 'Y coordinate in CSS pixels (last-resort fallback).',
        },
      },
    },
  },
  {
    name: 'o8_view_type',
    description: 'USE THIS AFTER o8_view_click on a text input — types text into the currently focused element in the o8 window. For chat messages, prefer o8_send instead since it routes through the orchestrator properly.',
    inputSchema: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'Text to type into the focused element.',
        },
      },
      required: ['text'],
    },
  },
  {
    name: 'o8_view_read',
    description: 'USE THIS WHEN you need to know what text is currently displayed in o8 without taking a screenshot — eg. to confirm a banner message, read a packet card title, or verify an empty-state appeared. Faster + cheaper than screenshot for text-based checks.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'o8_view_eval',
    description: 'Execute JavaScript in the o8 webview. Result wrapped as JSON envelope { ok: true, value } on success or { ok: false, error: { message, name, stack } } on throw. Non-JSON-serializable values (DOM nodes, functions, circular refs) fall back to String(result) and come back as { ok: true, value: "<toString>", nonSerializable: true, valueType: "<typeof>" }. Single expressions and multi-statement scripts both work — the wrapper auto-detects expression vs. body. Capped at 8KB — payloads larger than the cap come back as { truncated: true, sizeBytes, capBytes, preview }. Base64 image blobs are rejected — use o8_view_screenshot for image data.',
    inputSchema: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description: 'JavaScript code to execute inside the o8 webview.',
        },
      },
      required: ['code'],
    },
  },
  {
    name: 'o8_view_navigate',
    description: 'USE THIS WHEN you need to deep-link the o8 UI to a specific route or tab (settings, mobile preview, /text specimen) without taking a screenshot to find a nav element first. router.push under the hood — true SPA transition, no full Tauri webview reload, so subsequent o8_view_eval / o8_view_click calls remain responsive immediately.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Route or URL path to push into history.',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'o8_view_open_browser',
    description: "USE THIS to open o8's in-app Browser tab (and optionally point it at a URL such as a localhost dev server) in ONE deterministic call — instead of snapshotting/clicking to find and open it. Dispatches a window event the Browser panel handles synchronously, so it opens even if this call reports a busy-thread timeout (don't retry on timeout; take a screenshot to confirm). Omit `url` to just reveal the Browser tab with its detected localhost previews.",
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'Optional URL to open (e.g. http://localhost:3000). A new tab is created if one for this URL does not already exist.',
        },
      },
    },
  },
  {
    name: 'o8_view_scroll',
    description: 'Scroll the o8 webview — by direction (up/down, one viewport or a pixel amount), to a snapshot ref (scrollIntoView), or to top/bottom. Use to bring offscreen content into view before a screenshot or click.',
    inputSchema: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['up', 'down'], description: 'Scroll direction.' },
        amount: { type: 'number', description: 'Pixels to scroll; omit for one viewport.' },
        toRef: { type: 'number', description: 'A ref from o8_view_snapshot to scrollIntoView.' },
        toTop: { type: 'boolean', description: 'Scroll to the top of the page.' },
        toBottom: { type: 'boolean', description: 'Scroll to the bottom of the page.' },
      },
    },
  },
  {
    name: 'o8_view_press_key',
    description: "Press a key (with optional modifiers) in the o8 webview — e.g. Escape to close a modal, Enter to submit, or Cmd+K (key:'k', meta:true) to open the command palette. Fires a synthetic KeyboardEvent on the focused element: drives o8's own React keybindings, not OS-level shortcuts.",
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: "Key value, e.g. 'Escape', 'Enter', 'k', 'ArrowDown'." },
        meta: { type: 'boolean', description: 'Cmd (macOS) / Meta modifier.' },
        ctrl: { type: 'boolean', description: 'Ctrl modifier.' },
        shift: { type: 'boolean', description: 'Shift modifier.' },
        alt: { type: 'boolean', description: 'Alt / Option modifier.' },
      },
      required: ['key'],
    },
  },
  {
    name: 'o8_view_wait_for',
    description: 'Poll the o8 webview until a CSS selector resolves (optionally until its text includes a substring). Use to avoid racey sleep/screenshot retry loops when waiting for UI state — eg. a modal to open, a toast to appear, or a transcript line to render.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description: 'CSS selector to poll for via document.querySelector.',
        },
        text: {
          type: 'string',
          description: 'Optional substring that must appear in the element\'s innerText/textContent.',
        },
        timeoutMs: {
          type: 'number',
          description: 'Max wait in milliseconds (default 10000, capped at 25000).',
        },
      },
      required: ['selector'],
    },
  },
];

/**
 * Build the eval that runs ONE `__o8BrowserAgent` verb in the NATIVE browser-view
 * page and POSTs the result back to o8's secure cid-only sink. The untrusted page
 * has no Tauri IPC bridge, so it can't use `mcp_result` — it does a cross-origin
 * no-cors `text/plain` POST (a "simple request": no CORS preflight, full body) to
 * `resultUrl` (o8's loopback /api/browser/native-result), which can ONLY resolve
 * a pending eval by `cid`. See `native_browser_view_security`.
 */
export function buildNativeVerbEval(
  verb: 'read' | 'localize' | 'rect' | 'click' | 'type' | 'probe' | 'grab',
  args: Record<string, unknown>,
  cid: string,
  resultUrl: string,
): string {
  return `(function(){
    var __cid = ${JSON.stringify(cid)};
    var __url = ${JSON.stringify(resultUrl)};
    function __post(p){ try { fetch(__url, { method: 'POST', mode: 'no-cors', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ cid: __cid, payload: p }) }).catch(function(){}); } catch(e){} }
    var r;
    try {
      var agent = window.__o8BrowserAgent;
      if (!agent) { __post({ ok: false, error: 'native browser agent not installed yet' }); return; }
      r = agent.${verb}(${JSON.stringify(args)});
    } catch (e) { r = { ok: false, error: String((e && e.message) || e) }; }
    __post(r);
  })()`;
}

/**
 * Eval snippet calling one in-page browser-agent verb and RETURNING the result
 * OBJECT (not JSON-stringified). The native browser-view tier evals this via
 * `browser_view_eval_result`, which NSJSON-encodes the WKWebView return value — so
 * the verb returns a plain object and the host pulls the JSON back. This replaces
 * the in-page `fetch` POST channel, which HTTPS pages mixed-content block.
 */
export function nativeReturnEval(verb: 'read' | 'localize' | 'rect' | 'click' | 'type' | 'probe' | 'grab', args: Record<string, unknown>): string {
  return `(function(){
    var a = window.__o8BrowserAgent;
    if (!a) return { ok: false, error: 'native browser agent not installed yet' };
    try { return a.${verb}(${JSON.stringify(args)}); }
    catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  })()`;
}

/** Eval snippet calling one in-page browser-agent verb; returns a JSON string. */
export function browserAgentEval(verb: 'read' | 'localize' | 'rect' | 'click' | 'type' | 'probe' | 'grab', args: Record<string, unknown>): string {
  return `(() => {
    const agent = window.__o8BrowserAgent;
    if (!agent) return JSON.stringify({ ok: false, error: 'browser agent not installed — open a browser card (canvas) or the Browser tab first' });
    try { return JSON.stringify(agent.${verb}(${JSON.stringify(args)})); }
    catch (err) { return JSON.stringify({ ok: false, error: String((err && err.message) || err) }); }
  })()`;
}

/**
 * #agent-surface-ergonomics — build an in-page expression that resolves an
 * element by visible text / aria-label (or role + name) and clicks it in the
 * SAME synchronous step. o8 is the governance layer for AI agents, so an agent
 * must drive it by INTENT, not pixels. The click is dispatched in-page (React's
 * bubbling onClick fires even when the match is a text node inside the handler),
 * so it survives a busy-thread eval timeout and never drifts as layout reflows.
 * Returns { clicked, matchedText, tag, x, y } or { clicked: false, reason }.
 */
export function buildSemanticClickExpr(locator: { text: string; role: string; name: string }): string {
  const TEXT = JSON.stringify(locator.text);
  const ROLE = JSON.stringify(locator.role);
  const NAME = JSON.stringify(locator.name);
  return `(() => {
    const TEXT = ${TEXT}, ROLE = ${ROLE}, NAME = ${NAME};
    const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
    const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && el.offsetParent !== null; };
    const CLICKABLE = 'button,[role="button"],a,[role="tab"],[role="menuitem"],[role="option"],input,label,summary';
    let cand = [];
    if (ROLE && NAME) {
      const want = norm(NAME).toLowerCase();
      cand = Array.from(document.querySelectorAll('*')).filter(vis).filter((el) =>
        ((el.getAttribute('role') || el.tagName.toLowerCase()) === ROLE) &&
        (norm(el.getAttribute('aria-label') || el.textContent).toLowerCase() === want));
    } else if (TEXT) {
      const want = norm(TEXT).toLowerCase();
      const all = Array.from(document.querySelectorAll(CLICKABLE + ',div,span,li,p')).filter(vis);
      let hits = all.filter((el) => norm(el.textContent).toLowerCase() === want || norm(el.getAttribute('aria-label') || '').toLowerCase() === want);
      hits = hits.filter((el) => !hits.some((o) => o !== el && el.contains(o)));
      if (!hits.length) {
        hits = Array.from(document.querySelectorAll(CLICKABLE)).filter(vis)
          .filter((el) => norm(el.textContent).toLowerCase().includes(want))
          .sort((a, b) => norm(a.textContent).length - norm(b.textContent).length)
          .slice(0, 1);
      }
      cand = hits;
    }
    const el = cand[0];
    if (!el) return { clicked: false, reason: 'no-match', text: TEXT, role: ROLE, name: NAME };
    try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) {}
    const r = el.getBoundingClientRect();
    const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
    // Fire a full pointer+mouse sequence, not just el.click(): canvas cards
    // (tap/drag) listen on onPointerDown/onPointerUp, which a bare click()
    // never triggers — the agent-surface gap that forced raw PointerEvent
    // dispatch via o8_view_eval. el.click() still runs last so plain buttons,
    // links, and form submits keep working.
    const mo = { bubbles: true, cancelable: true, composed: true, view: window, clientX: cx, clientY: cy, button: 0 };
    const po = Object.assign({ pointerId: 1, pointerType: 'mouse', isPrimary: true }, mo);
    const seq = [
      ['pointerover', typeof PointerEvent === 'function' ? PointerEvent : MouseEvent, Object.assign({ buttons: 0 }, po)],
      ['pointerdown', typeof PointerEvent === 'function' ? PointerEvent : MouseEvent, Object.assign({ buttons: 1 }, po)],
      ['mousedown', MouseEvent, Object.assign({ buttons: 1 }, mo)],
      ['pointerup', typeof PointerEvent === 'function' ? PointerEvent : MouseEvent, Object.assign({ buttons: 0 }, po)],
      ['mouseup', MouseEvent, Object.assign({ buttons: 0 }, mo)],
      ['click', MouseEvent, Object.assign({ buttons: 0, detail: 1 }, mo)],
    ];
    for (const [type, Ctor, init] of seq) { try { el.dispatchEvent(new Ctor(type, init)); } catch (e) {} }
    return { clicked: true, matchedText: norm(el.textContent).slice(0, 48), tag: el.tagName, x: Math.round(cx), y: Math.round(cy) };
  })()`;
}

export function createO8WebviewToolHandlers(getClient: () => O8WebviewClient): Record<string, ToolHandler> {
  return {
    ...createO8WebviewCompositeHandlers(getClient),
    ...createO8WebviewBrowserHandlers(),
    o8_view_screenshot: async () => withStructuredErrors(async () => {
      const screenshot = await getClient().screenshot();
      const path = persistScreenshot(screenshot.imageBase64, screenshot.mimeType);
      return imageResult(screenshot.imageBase64, screenshot.mimeType, {
        ok: true,
        width: screenshot.width,
        height: screenshot.height,
        mimeType: screenshot.mimeType,
        ...(path ? { path } : {}),
      });
    }),

    o8_view_snapshot: async () => withStructuredErrors(async () => {
      const snapshot = await getClient().snapshot();
      return textResult(snapshot.tree);
    }),

    o8_view_click: async (args) => withStructuredErrors(async () => {
      const text = typeof args.text === 'string' ? args.text.trim() : '';
      const role = typeof args.role === 'string' ? args.role.trim() : '';
      const name = typeof args.name === 'string' ? args.name.trim() : '';
      // Semantic locator (#agent-surface-ergonomics): resolve + click in ONE
      // in-page step — robust under load, immune to coordinate drift, no prior
      // snapshot needed. The click fires inside the same eval that finds the
      // element, so it lands even if the eval transport reports a busy-thread
      // timeout. Coordinates/ref remain a fallback for label-less targets.
      if (text || (role && name)) {
        const evalResult = await getClient().evalJs(wrapEvalCode(buildSemanticClickExpr({ text, role, name })));
        return capEvalResult(evalResult.result);
      }
      const ref = parseOptionalNumber(args.ref);
      const x = parseOptionalNumber(args.x);
      const y = parseOptionalNumber(args.y);
      const result = await getClient().click({ ref, x, y });
      return jsonResult(result);
    }),

    o8_view_type: async (args) => withStructuredErrors(async () => {
      const text = requiredString(args, 'text');
      const client = getClient();
      const prepared = JSON.parse((await client.evalJs(buildPrepareComposerTargetScript())).result) as { ok?: boolean; error?: string };
      if (prepared.ok !== true) throw new Error(prepared.error ?? 'No visible editable target is available.');
      const result = await client.type(text);
      return jsonResult(result);
    }),

    o8_view_read: async () => withStructuredErrors(async () => {
      const result = await getClient().readPage();
      return capText(result.text, READ_RESULT_BYTE_CAP);
    }),

    o8_view_eval: async (args) => withStructuredErrors(async () => {
      const code = requiredString(args, 'code');
      const wrapped = wrapEvalCode(code);
      const result = await getClient().evalJs(wrapped);
      return capEvalResult(result.result);
    }),

    o8_view_navigate: async (args) => withStructuredErrors(async () => {
      const path = requiredString(args, 'path');
      const result = await getClient().navigate(path);
      return jsonResult(result);
    }),

    o8_view_open_browser: async (args) => withStructuredErrors(async () => {
      const url = typeof args.url === 'string' && args.url.trim() ? args.url.trim() : null;
      // Dispatch the window event O8Panel listens for: switch to the Browser tab
      // and (if a URL is given) navigate the inner iframe. Fire-and-forget inside
      // evalJs — the handler runs synchronously, so the browser opens even if the
      // eval transport reports a busy-thread timeout.
      const code = `(() => { try { window.dispatchEvent(new CustomEvent('o8:open-browser', { detail: { url: ${JSON.stringify(url)} } })); return 'opened'; } catch (err) { return 'error: ' + String((err && err.message) || err); } })()`;
      const result = await getClient().evalJs(code);
      return jsonResult({ ok: true, url, raw: result.result });
    }),

    o8_view_scroll: async (args) => withStructuredErrors(async () => {
      const direction = args.direction === 'up' || args.direction === 'down' ? args.direction : undefined;
      const amount = args.amount === 'half' ? 'half' : parseOptionalNumber(args.amount);
      const result = await getClient().scroll({
        direction,
        amount,
        toRef: parseOptionalNumber(args.toRef),
        toTop: args.toTop === true,
        toBottom: args.toBottom === true,
      });
      return jsonResult(result);
    }),

    o8_view_press_key: async (args) => withStructuredErrors(async () => {
      const key = requiredString(args, 'key');
      const result = await getClient().pressKey({
        key,
        meta: args.meta === true,
        ctrl: args.ctrl === true,
        shift: args.shift === true,
        alt: args.alt === true,
      });
      return jsonResult(result);
    }),

    o8_view_wait_for: async (args) => withStructuredErrors(async () => {
      const selector = requiredString(args, 'selector');
      const text = typeof args.text === 'string' && args.text.length > 0 ? args.text : undefined;
      const timeoutMs = parseOptionalNumber(args.timeoutMs);
      const result = await getClient().waitFor({ selector, text, timeoutMs });
      return jsonResult(result);
    }),

  };
}
