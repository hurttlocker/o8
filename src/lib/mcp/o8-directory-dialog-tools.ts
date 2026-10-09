import { McpInputError, safeErrorText } from '@/lib/mcp/api-error';
import { isAbsolute } from 'node:path';
import type { O8WebviewClient } from '@/lib/mcp/o8-webview-client';

export type DirectoryResolve =
  | { dialog_id: string; operation: 'select'; path: string }
  | { dialog_id: string; operation: 'cancel' };

type Result = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

function invalid(message: string): never {
  throw Object.assign(new McpInputError(message), { code: 'invalid_schema' });
}

export function parseDirectoryResolve(args: Record<string, unknown>): DirectoryResolve {
  if (Object.keys(args).some((key) => !['dialog_id', 'operation', 'path'].includes(key))) {
    invalid('Unknown directory dialog argument; only the main window is supported');
  }
  if (typeof args.dialog_id !== 'string' || !args.dialog_id) invalid('dialog_id from inspection is required');
  if (args.operation === 'cancel') {
    if (args.path !== undefined && args.path !== null) invalid('Cancel forbids path');
    return { dialog_id: args.dialog_id, operation: 'cancel' };
  }
  if (args.operation !== 'select') invalid('operation must be select or cancel');
  if (typeof args.path !== 'string' || args.path.includes('\0') || !isAbsolute(args.path)) {
    invalid('Select requires an absolute directory path without NUL');
  }
  return { dialog_id: args.dialog_id, operation: 'select', path: args.path };
}

export const DIRECTORY_DIALOG_TOOLS = [
  {
    name: 'o8_view_inspect_directory_dialog',
    description: 'Inspect the existing native directory picker attached to the app main window on macOS. Read-only; returns opaque dialog_id and live/pending state. Refuses file pickers and consent prompts. Does not prove workspace completion.',
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  {
    name: 'o8_view_resolve_directory_dialog',
    description: 'Cancel the exact native directory picker from inspection with operation cancel and path null. Observe closure with inspect, then use o8_setup open with the desired Git directory and status to verify workspace entry. Direct operation select validates the path but returns selection_not_supported without native action; AppKit navigation does not select a folder. Cancellation dispatch returns pending, not completion. Never retry after a disconnect. macOS main window only.',
    inputSchema: {
      type: 'object',
      properties: {
        dialog_id: { type: 'string', description: 'Opaque identity returned by inspection.' },
        operation: { type: 'string', enum: ['select', 'cancel'] },
        path: { type: ['string', 'null'], description: 'Absolute existing directory for select; null for cancel.' },
      },
      required: ['dialog_id', 'operation', 'path'],
      additionalProperties: false,
    },
  },
];

export function createDirectoryDialogHandlers(getClient: () => O8WebviewClient): Record<string, (args: Record<string, unknown>) => Promise<Result>> {
  async function run(action: () => Promise<unknown>): Promise<Result> {
    try {
      return { content: [{ type: 'text', text: JSON.stringify(await action()) }] };
    } catch (error) {
      const message = safeErrorText(error);
      const code = (error as { code?: string })?.code ?? (/^[a-z_]+$/.test(message) ? message : 'directory_dialog_error');
      return { isError: true, content: [{ type: 'text', text: JSON.stringify({ code, message }) }] };
    }
  }
  return {
    o8_view_inspect_directory_dialog: (args) => run(async () => {
      if (Object.keys(args).length) invalid('Inspect takes no arguments');
      return getClient().inspectDirectoryDialog();
    }),
    o8_view_resolve_directory_dialog: (args) => run(async () => {
      const payload = parseDirectoryResolve(args);
      return getClient().resolveDirectoryDialog(payload);
    }),
  };
}
