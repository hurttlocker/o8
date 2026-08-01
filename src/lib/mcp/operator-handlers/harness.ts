import {
  apiFetch,
  errorText,
  jsonResult,
  type McpTool,
  type McpToolResult,
} from '@/lib/mcp/operator-handlers/shared';

const repoPath = {
  type: 'string',
  description: 'Absolute path to the canonical repository.',
};

const acceptanceCriteria = {
  type: 'array',
  items: { type: 'string' },
  maxItems: 100,
  description: 'Concrete conditions the evaluator must verify.',
};

export const HARNESS_TOOLS: McpTool[] = [
  {
    name: 'o8_feature_list',
    description: 'List the durable machine-readable feature ledger for one repository, optionally filtered by status.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        repoPath,
        status: { type: 'string', enum: ['failing', 'passing', 'blocked'] },
        limit: { type: 'number', minimum: 1, maximum: 500 },
      },
      required: ['repoPath'],
    },
  },
  {
    name: 'o8_feature_next',
    description: 'Return the highest-priority failing feature for one repository.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { repoPath },
      required: ['repoPath'],
    },
  },
  {
    name: 'o8_feature_add',
    description: 'Add an operator-owned feature to the durable repository ledger.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        repoPath,
        title: { type: 'string', maxLength: 300 },
        description: { type: 'string', maxLength: 10000 },
        priority: { type: 'number', minimum: 0, maximum: 10000 },
        verificationCommand: { type: 'array', items: { type: 'string' }, maxItems: 32 },
        metadata: { type: 'object', additionalProperties: true },
      },
      required: ['repoPath', 'title'],
    },
  },
  {
    name: 'o8_feature_verify',
    description: 'Append verification evidence and update a feature to passing or failing. This records results; it does not execute a shell command.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        repoPath,
        featureId: { type: 'string' },
        status: { type: 'string', enum: ['passed', 'failed', 'skipped'] },
        evidence: { type: 'string', maxLength: 50000 },
        command: { type: 'array', items: { type: 'string' }, maxItems: 32 },
        exitCode: { type: 'number' },
        modelId: { type: 'string' },
        packetId: { type: 'string' },
      },
      required: ['repoPath', 'featureId', 'status'],
    },
  },
  {
    name: 'o8_ground_task',
    description: 'Build and persist a grounded impact map from real tracked paths and matching symbols before execution.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        repoPath,
        task: { type: 'string', maxLength: 50000 },
        featureId: { type: 'string' },
        packetId: { type: 'string' },
        acceptanceCriteria,
      },
      required: ['repoPath', 'task'],
    },
  },
  {
    name: 'o8_session_boot',
    description: 'Return the repository boot envelope: git state, instructions, ledger state, active contract/sprint, grounding, and capabilities.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        repoPath,
        task: { type: 'string', maxLength: 50000 },
        featureId: { type: 'string' },
        packetId: { type: 'string' },
        modelId: { type: 'string' },
        acceptanceCriteria,
      },
      required: ['repoPath'],
    },
  },
  {
    name: 'o8_negotiate_contract',
    description: 'List, propose, or operator-accept a generator/evaluator contract. A sprint cannot start until the contract is accepted.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        mode: { type: 'string', enum: ['list', 'propose', 'accept', 'fail', 'supersede'] },
        repoPath,
        contractId: { type: 'string' },
        featureId: { type: 'string' },
        groundingId: { type: 'string' },
        generatorTerms: { type: 'string', maxLength: 20000 },
        evaluatorTerms: { type: 'string', maxLength: 20000 },
        acceptanceCriteria,
      },
      required: ['mode', 'repoPath'],
    },
  },
  {
    name: 'o8_sprint',
    description: 'List, start, or tick a persisted one-feature-at-a-time sprint.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        mode: { type: 'string', enum: ['list', 'start', 'tick'] },
        repoPath,
        contractId: { type: 'string' },
        sprintId: { type: 'string' },
        packetId: { type: 'string' },
        note: { type: 'string', maxLength: 2000 },
      },
      required: ['mode', 'repoPath'],
    },
  },
  {
    name: 'o8_verify',
    description: 'Record one or more computational verification results and optionally tick the bound sprint.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        repoPath,
        sprintId: { type: 'string' },
        note: { type: 'string', maxLength: 2000 },
        results: {
          type: 'array',
          minItems: 1,
          maxItems: 50,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              featureId: { type: 'string' },
              status: { type: 'string', enum: ['passed', 'failed', 'skipped'] },
              evidence: { type: 'string' },
              command: { type: 'array', items: { type: 'string' }, maxItems: 32 },
              exitCode: { type: 'number' },
              modelId: { type: 'string' },
              packetId: { type: 'string' },
            },
            required: ['featureId', 'status'],
          },
        },
      },
      required: ['repoPath', 'results'],
    },
  },
  {
    name: 'o8_harness_lift_status',
    description: 'Return model-keyed component lifecycle state, weighted lift, recommendations, and measurements.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        repoPath,
        componentKey: { type: 'string' },
        modelId: { type: 'string' },
        limit: { type: 'number', minimum: 1, maximum: 1000 },
      },
      required: ['repoPath'],
    },
  },
  {
    name: 'o8_harness_measure',
    description: 'Record a paired baseline versus enabled score for one component and model. Recording never changes lifecycle state automatically.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        repoPath,
        componentKey: { type: 'string' },
        modelId: { type: 'string' },
        baselineScore: { type: 'number' },
        enabledScore: { type: 'number' },
        sampleCount: { type: 'number', minimum: 1 },
        evidence: { type: 'object', additionalProperties: true },
      },
      required: ['repoPath', 'componentKey', 'modelId', 'baselineScore', 'enabledScore', 'sampleCount'],
    },
  },
  {
    name: 'o8_harness_transition',
    description: 'Apply an explicit operator lifecycle transition. Retirement requires shadow-only state and sufficient non-positive evidence.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        repoPath,
        componentKey: { type: 'string' },
        modelId: { type: 'string' },
        lifecycle: { type: 'string', enum: ['retained', 'candidate', 'shadow_only', 'retired'] },
        reason: { type: 'string', maxLength: 2000 },
      },
      required: ['repoPath', 'componentKey', 'modelId', 'lifecycle', 'reason'],
    },
  },
  {
    name: 'o8_capabilities',
    description: 'Discover harness artifacts, recommended call order, limits, and optional model-specific lifecycle guidance.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { modelId: { type: 'string' } },
      required: [],
    },
  },
  {
    name: 'o8_evaluate_diff',
    description: 'Run an independent skeptical diff review that receives no generator transcript or self-review. Returns a structured verdict and findings.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        repoPath,
        task: { type: 'string', maxLength: 50000 },
        diff: { type: 'string', maxLength: 300000 },
        acceptanceCriteria,
      },
      required: ['repoPath', 'task', 'diff'],
    },
  },
  {
    name: 'o8_harness_bundle',
    description: 'Export or import a versioned non-secret HarnessBundle for one repository.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        mode: { type: 'string', enum: ['export', 'import'] },
        repoPath,
        bundle: { type: 'object', additionalProperties: true },
      },
      required: ['mode', 'repoPath'],
    },
  },
];

interface HarnessApiResponse {
  ok?: boolean;
  result?: unknown;
  error?: { code?: string; message?: string } | string;
}

async function callHarness(body: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const response = await apiFetch('/api/harness', {
      method: 'POST',
      body: JSON.stringify(body),
      timeoutMs: body.action === 'evaluate_diff' ? 300_000 : 90_000,
      acceptedErrorStatuses: [400, 403, 404, 409, 413],
    }) as HarnessApiResponse;
    if (response?.ok) return jsonResult(response.result);
    const message = typeof response?.error === 'string'
      ? response.error
      : response?.error?.message ?? 'Harness action failed.';
    return jsonResult({ ok: false, error: message });
  } catch (error) {
    return jsonResult({ ok: false, error: errorText(error) });
  }
}

function mode(args: Record<string, unknown>): string {
  return typeof args.mode === 'string' ? args.mode.trim() : '';
}

export async function handleFeatureList(args: Record<string, unknown>) {
  return callHarness({ action: 'feature_list', ...args });
}

export async function handleFeatureNext(args: Record<string, unknown>) {
  return callHarness({ action: 'feature_next', ...args });
}

export async function handleFeatureAdd(args: Record<string, unknown>) {
  return callHarness({ action: 'feature_add', ...args });
}

export async function handleFeatureVerify(args: Record<string, unknown>) {
  return callHarness({ action: 'feature_verify', ...args });
}

export async function handleGroundTask(args: Record<string, unknown>) {
  return callHarness({ action: 'ground', ...args });
}

export async function handleSessionBoot(args: Record<string, unknown>) {
  return callHarness({ action: 'boot', ...args });
}

export async function handleNegotiateContract(args: Record<string, unknown>) {
  const selected = mode(args);
  const action = selected === 'list' ? 'contract_list'
    : selected === 'propose' ? 'contract_propose'
      : 'contract_transition';
  const status = selected === 'accept' ? 'accepted'
    : selected === 'fail' ? 'failed'
      : selected === 'supersede' ? 'superseded'
        : undefined;
  return callHarness({ action, ...args, ...(status ? { status } : {}) });
}

export async function handleSprint(args: Record<string, unknown>) {
  const selected = mode(args);
  const action = selected === 'list' ? 'sprint_list'
    : selected === 'start' ? 'sprint_start'
      : selected === 'tick' ? 'sprint_tick'
        : '';
  if (!action) return jsonResult({ ok: false, error: 'mode must be list, start, or tick' });
  return callHarness({ action, ...args });
}

export async function handleVerify(args: Record<string, unknown>) {
  return callHarness({ action: 'verify', ...args });
}

export async function handleHarnessLiftStatus(args: Record<string, unknown>) {
  return callHarness({ action: 'harness_status', ...args });
}

export async function handleHarnessMeasure(args: Record<string, unknown>) {
  return callHarness({ action: 'harness_measure', ...args });
}

export async function handleHarnessTransition(args: Record<string, unknown>) {
  return callHarness({ action: 'harness_transition', ...args });
}

export async function handleCapabilities(args: Record<string, unknown>) {
  return callHarness({ action: 'capabilities', ...args });
}

export async function handleEvaluateDiff(args: Record<string, unknown>) {
  return callHarness({ action: 'evaluate_diff', ...args });
}

export async function handleHarnessBundle(args: Record<string, unknown>) {
  const selected = mode(args);
  if (selected !== 'export' && selected !== 'import') {
    return jsonResult({ ok: false, error: 'mode must be export or import' });
  }
  if (selected === 'import' && (!args.bundle || typeof args.bundle !== 'object' || Array.isArray(args.bundle))) {
    return jsonResult({ ok: false, error: 'bundle is required for import' });
  }
  return callHarness({ action: selected === 'export' ? 'bundle_export' : 'bundle_import', ...args });
}
