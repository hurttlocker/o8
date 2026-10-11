type McpTool = { name: string; description: string; inputSchema: Record<string, unknown> };

export const O8_WEBVIEW_PRIMITIVE_TOOLS: McpTool[] = [
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
  {
    name: 'o8_view_windows',
    description: 'USE THIS WHEN typing or clicking lands nowhere, or you need to know what is actually on screen. Lists every o8 window with visible / focused / position / size. o8 runs transparent click-through overlays (`dock`, `spatial-ink`, `agent-partials`) alongside `main`; when one of them holds focus, keystrokes vanish into it and nothing in the DOM explains why. Fix it with o8_view_manage_window {operation: "focus", windowLabel: "main"}.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'o8_view_manage_window',
    description: 'Show / hide / focus / center / minimize an o8 window by label. Most common use: return focus to `main` after o8_view_windows shows an overlay holding it. Labels come from o8_view_windows.',
    inputSchema: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: ['show', 'hide', 'focus', 'center', 'minimize', 'maximize', 'unmaximize', 'toggleFullscreen'],
          description: 'What to do to the window.',
        },
        windowLabel: {
          type: 'string',
          description: 'Window label from o8_view_windows (e.g. "main", "dock", "spatial-ink", "agent-partials"). Defaults to "main".',
        },
      },
      required: ['operation'],
    },
  },
];
