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

function imageResult(base64: string, mimeType: string, meta: Record<string, unknown>): McpToolResult {
  return {
    content: [
      { type: 'image', data: base64, mimeType },
      { type: 'text', text: JSON.stringify(meta) },
    ],
  };
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
    description: 'Capture a screenshot of the o8 desktop app window as base64 PNG. Use when you need to see the current UI state.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'o8_view_snapshot',
    description: 'Get a numbered accessibility tree of the current o8 view. Use to discover clickable elements by their ref.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'o8_view_click',
    description: 'Click an element in the o8 window. Pass ref from a snapshot, or {x, y} coordinates.',
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
    description: 'Type text into the currently focused element in the o8 window.',
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
    description: 'Get all visible text from the current o8 view.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'o8_view_eval',
    description: 'Execute JavaScript in the o8 webview. Returns stringified result. Use when snapshot/click can\'t reach the target.',
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
    description: 'Navigate the o8 app to a new route by dispatching history.pushState. Use for deep-linking into specific tabs.',
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

export function createO8WebviewToolHandlers(getClient: () => O8WebviewClient): Record<string, ToolHandler> {
  return {
    o8_view_screenshot: async () => withStructuredErrors(async () => {
      const screenshot = await getClient().screenshot();
      return imageResult(screenshot.imageBase64, screenshot.mimeType, {
        ok: true,
        width: screenshot.width,
        height: screenshot.height,
        mimeType: screenshot.mimeType,
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
      return textResult(result.text);
    }),

    o8_view_eval: async (args) => withStructuredErrors(async () => {
      const code = requiredString(args, 'code');
      const result = await getClient().evalJs(code);
      return textResult(result.result);
    }),

    o8_view_navigate: async (args) => withStructuredErrors(async () => {
      const path = requiredString(args, 'path');
      const result = await getClient().navigate(path);
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
