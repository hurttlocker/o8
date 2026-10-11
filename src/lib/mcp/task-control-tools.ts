import { PLUGIN_LAUNCH_TASK_SCOPE } from '@/lib/auth/plugin-token';

const inputSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    machineId: { type: 'string', minLength: 1, maxLength: 256 },
    taskId: { type: 'string', pattern: '^[a-f0-9-]{36}$' },
    contractHash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
  },
  required: ['machineId', 'taskId', 'contractHash'],
} as const;

/** Separate dormant export; production discovery needs reviewed scope activation. */
export const TASK_CONTROL_TOOLS = [
  {
    name: 'o8_launch_task', title: 'Start a prepared bounded o8 worker',
    description: 'Only after the user explicitly asks to run the prepared task, start its exact taskId and contractHash from o8_prepare_task. The first hosted launch accepts only the offered read-only OpenRouter policy with provider-default reasoning. It uses the desktop owner\'s configured API credit; no native fallback. Duplicate calls inspect the one persisted attempt and never retry a worker. A blocked or uncertain attempt requires review in o8. Cannot approve, merge or release.',
    inputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    securitySchemes: [{ type: 'oauth2', scopes: [PLUGIN_LAUNCH_TASK_SCOPE] }],
  },
  {
    name: 'o8_stop_task', title: 'Stop a prepared bounded o8 worker',
    description: 'On an explicit user Stop request, stop the exact prepared OpenRouter taskId and contractHash. Bound to the same account, client and computer; no arbitrary process control. Revokes further provider requests for that attempt. Stopping does not retry, undo completed work, approve, merge or release.',
    inputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    securitySchemes: [{ type: 'oauth2', scopes: [PLUGIN_LAUNCH_TASK_SCOPE] }],
  },
] as const;
