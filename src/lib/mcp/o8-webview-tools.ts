import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { O8WebviewClient } from '@/lib/mcp/o8-webview-client';

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
    description: 'USE THIS WHEN the user asks you to click something in o8, dismiss a dialog, or drive the UI to a specific state. Pass ref from o8_view_snapshot for label-based targeting, or {x, y} coordinates when you already know the position from a screenshot.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: {
          type: 'number',
          description: 'Element ref from o8_view_snapshot.',
        },
        x: {
          type: 'number',
          description: 'X coordinate in CSS pixels.',
        },
        y: {
          type: 'number',
          description: 'Y coordinate in CSS pixels.',
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
  // ── o8_browser_* — drive the page INSIDE o8's embedded browser ──
  // (canvas browser cards / the Browser tab), not the o8 UI itself.
  // Same-origin pages only, which with the picker proxies means any
  // localhost page. Actions paint a ghost cursor so the operator sees
  // the agent working.
  {
    name: 'o8_browser_read',
    description: "Read the page INSIDE o8's embedded browser (canvas browser card or Browser tab): returns { url, title, text, interactive } where interactive lists clickable/typable elements with CSS selectors — the vocabulary for o8_browser_click / o8_browser_type. Use this FIRST to see the page before acting. Localhost pages only (cross-origin pages return an error envelope).",
    inputSchema: {
      type: 'object',
      properties: {
        surface: { type: 'string', enum: ['canvas', 'panel', 'engine'], description: "Which browser surface — 'canvas' (browser cards), 'panel' (Browser tab), or 'engine' (headless installed-Chrome for external URLs). Omit to auto-route: the engine while its page is open, else the most recently active embedded surface." },
        selector: { type: 'string', description: 'Optional CSS selector — read only this subtree.' },
        maxChars: { type: 'number', description: 'Text cap (default 6000, max 14000).' },
      },
    },
  },
  {
    name: 'o8_browser_click',
    description: "Click an element INSIDE o8's embedded browser by CSS selector (from o8_browser_read's interactive list or the element picker). Fires the full pointer/mouse sequence so React apps respond, and paints a ghost cursor + ripple the operator can see.",
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector of the element to click.' },
        surface: { type: 'string', enum: ['canvas', 'panel', 'engine'], description: 'Which browser surface (engine = headless Chrome for external URLs). Omit to auto-route.' },
      },
      required: ['selector'],
    },
  },
  {
    name: 'o8_browser_type',
    description: "Type into an input/textarea INSIDE o8's embedded browser by CSS selector. Uses the native value setter + input/change events so controlled (React) inputs accept it. Set submit:true to press Enter / submit the form after.",
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector of the input or textarea.' },
        text: { type: 'string', description: 'Text to type.' },
        submit: { type: 'boolean', description: 'Press Enter / requestSubmit after typing.' },
        surface: { type: 'string', enum: ['canvas', 'panel', 'engine'], description: 'Which browser surface (engine = headless Chrome for external URLs). Omit to auto-route.' },
      },
      required: ['selector', 'text'],
    },
  },
  {
    name: 'o8_browser_wait',
    description: "Poll the page INSIDE o8's embedded browser until a CSS selector resolves (optionally with a text substring) — the settle gate between o8_browser_click and o8_browser_read.",
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector to wait for inside the framed page.' },
        text: { type: 'string', description: 'Optional substring the element must contain.' },
        timeoutMs: { type: 'number', description: 'Max wait in milliseconds (default 10000, capped at 25000).' },
        surface: { type: 'string', enum: ['canvas', 'panel', 'engine'], description: 'Which browser surface (engine = headless Chrome for external URLs). Omit to auto-route.' },
      },
      required: ['selector'],
    },
  },
];

/** Eval snippet calling one in-page browser-agent verb; returns a JSON string. */
export function browserAgentEval(verb: 'read' | 'click' | 'type' | 'probe', args: Record<string, unknown>): string {
  return `(() => {
    const agent = window.__o8BrowserAgent;
    if (!agent) return JSON.stringify({ ok: false, error: 'browser agent not installed — open a browser card (canvas) or the Browser tab first' });
    try { return JSON.stringify(agent.${verb}(${JSON.stringify(args)})); }
    catch (err) { return JSON.stringify({ ok: false, error: String((err && err.message) || err) }); }
  })()`;
}

function parseAgentResult(raw: string): McpToolResult {
  try {
    return jsonResult(JSON.parse(raw));
  } catch {
    return textResult(raw);
  }
}

// ── Browser-verb bridge over HTTP ──
//
// The o8_browser_* handlers POST /api/browser/agent instead of eval'ing the
// socket directly: the route owns tier routing (embedded iframe vs the
// playwright-core engine in the Next server), so MCP, CLI, and Symon all
// share one brain. Small dupe of resolveApiBase/readToken with
// operator-mission-tools.ts — this file must stay importable without
// Next-specific deps.
function browserApiBase(): string {
  try {
    const dataDir = process.env.CORTEX_IDE_DATA_DIR || join(homedir(), '.o8');
    const portFile = join(dataDir, 'api-port');
    if (existsSync(portFile)) {
      const port = parseInt(readFileSync(portFile, 'utf-8').trim(), 10);
      if (Number.isInteger(port) && port > 0 && port < 65536) return `http://127.0.0.1:${port}`;
    }
  } catch { /* fall through */ }
  const envBase = process.env.O8_API_BASE?.trim();
  if (envBase) return envBase;
  const envPort = process.env.O8_API_PORT?.trim();
  if (envPort) return `http://127.0.0.1:${envPort}`;
  return 'http://localhost:3001';
}

function browserApiToken(): string | null {
  try {
    const dataDir = process.env.CORTEX_IDE_DATA_DIR || join(homedir(), '.o8');
    const tokenPath = join(dataDir, 'ws-token');
    if (!existsSync(tokenPath)) return null;
    return readFileSync(tokenPath, 'utf-8').trim() || null;
  } catch {
    return null;
  }
}

async function browserAgentPost(verb: string, args: Record<string, unknown>): Promise<McpToolResult> {
  const token = browserApiToken();
  const response = await fetch(`${browserApiBase()}/api/browser/agent`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ verb, args }),
  });
  return parseAgentResult(await response.text());
}

export function createO8WebviewToolHandlers(getClient: () => O8WebviewClient): Record<string, ToolHandler> {
  return {
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
      const ref = parseOptionalNumber(args.ref);
      const x = parseOptionalNumber(args.x);
      const y = parseOptionalNumber(args.y);
      const result = await getClient().click({ ref, x, y });
      return jsonResult(result);
    }),

    o8_view_type: async (args) => withStructuredErrors(async () => {
      const text = requiredString(args, 'text');
      const result = await getClient().type(text);
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

    // The o8_browser_* family rides the HTTP bridge (/api/browser/agent) so
    // tier routing — embedded iframe vs headless-Chrome engine — lives in ONE
    // place, shared with the `o8 browser` CLI and Symon.
    o8_browser_read: async (args) => withStructuredErrors(async () => {
      const agentArgs: Record<string, unknown> = {};
      if (args.surface === 'canvas' || args.surface === 'panel' || args.surface === 'engine') agentArgs.surface = args.surface;
      if (typeof args.selector === 'string' && args.selector) agentArgs.selector = args.selector;
      const maxChars = parseOptionalNumber(args.maxChars);
      if (maxChars) agentArgs.maxChars = maxChars;
      const result = await browserAgentPost('read', agentArgs);
      const text = result.content[0];
      return text?.type === 'text' ? capText(text.text, READ_RESULT_BYTE_CAP) : result;
    }),

    o8_browser_click: async (args) => withStructuredErrors(async () => {
      const agentArgs: Record<string, unknown> = { selector: requiredString(args, 'selector') };
      if (args.surface === 'canvas' || args.surface === 'panel' || args.surface === 'engine') agentArgs.surface = args.surface;
      return browserAgentPost('click', agentArgs);
    }),

    o8_browser_type: async (args) => withStructuredErrors(async () => {
      const agentArgs: Record<string, unknown> = {
        selector: requiredString(args, 'selector'),
        text: requiredString(args, 'text'),
      };
      if (args.submit === true) agentArgs.submit = true;
      if (args.surface === 'canvas' || args.surface === 'panel' || args.surface === 'engine') agentArgs.surface = args.surface;
      return browserAgentPost('type', agentArgs);
    }),

    o8_browser_wait: async (args) => withStructuredErrors(async () => {
      const agentArgs: Record<string, unknown> = { selector: requiredString(args, 'selector') };
      if (typeof args.text === 'string' && args.text) agentArgs.text = args.text;
      if (args.surface === 'canvas' || args.surface === 'panel' || args.surface === 'engine') agentArgs.surface = args.surface;
      const timeoutMs = Math.min(25_000, Math.max(500, parseOptionalNumber(args.timeoutMs) ?? 10_000));
      const deadline = Date.now() + timeoutMs;
      // Probes are one-shot — poll here until found/timeout.
      let last: unknown = { ok: false, error: 'never probed' };
      while (Date.now() < deadline) {
        const result = await browserAgentPost('probe', agentArgs);
        const text = result.content[0];
        if (text?.type !== 'text') return result;
        try {
          const parsed = JSON.parse(text.text) as { ok?: boolean; pending?: boolean };
          last = parsed;
          if (parsed.ok) return jsonResult(parsed);
          if (!parsed.pending) return jsonResult(parsed); // hard error — stop polling
        } catch {
          // unparseable — keep polling
        }
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      return jsonResult({ ok: false, timedOut: true, timeoutMs, last });
    }),
  };
}
