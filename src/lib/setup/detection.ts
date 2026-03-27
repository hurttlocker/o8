export interface ToolDetection {
  detected: boolean;
  version?: string;
  error?: string;
  port?: number;
  agentCount?: number;
  responding?: boolean;
  activeThreads?: number;
  recentSessions?: number;
  hasDb?: boolean;
  memoryCount?: number;
  factCount?: number;
  models?: string[];
  hasEmbeddingModel?: boolean;
  path?: string;
}

export interface ApiKeyStatus {
  provider: string;
  configured: boolean;
}

export interface DetectionResult {
  tools: {
    openclaw: ToolDetection;
    codex: ToolDetection;
    claudeCode: ToolDetection;
    gemini: ToolDetection;
    cortex: ToolDetection;
    ollama: ToolDetection;
  };
  apiKeys: ApiKeyStatus[];
  hasAnything: boolean;
  hasAgentSurface: boolean;
  hasCliAgent: boolean;
  hasApiKey: boolean;
  hasMemory: boolean;
  hasEmbeddings: boolean;
  recommendedPath: string;
  summary: string;
}

export type SetupCompletionGoal = 'quick-setup' | 'agents' | 'chat';

export interface SetupCompletionStatus {
  complete: boolean;
  title: string;
  description: string;
  missing: string[];
}

export function normalizeSetupDetection(raw: Record<string, unknown>): DetectionResult {
  const toolsArray = (raw.tools ?? []) as Array<{
    id: string;
    detected: boolean;
    version?: string;
    path?: string;
    details?: Record<string, unknown>;
  }>;
  const findTool = (id: string) => toolsArray.find((tool) => tool.id === id);

  const mkTool = (id: string) => {
    const tool = findTool(id);
    return {
      detected: tool?.detected ?? false,
      version: tool?.version,
      path: tool?.path,
      ...(tool?.details ?? {}),
    };
  };

  const apiKeysTool = findTool('api-keys');
  const rawProviders = (apiKeysTool?.details?.providers ?? []) as Array<string | { provider: string; configured: boolean }>;
  const apiKeys = rawProviders.map((provider) => {
    if (typeof provider === 'string') {
      return { provider, configured: true };
    }
    return { provider: provider.provider, configured: provider.configured };
  });

  return {
    tools: {
      openclaw: {
        ...mkTool('openclaw'),
        detected: (findTool('openclaw')?.detected) || Boolean(findTool('openclaw')?.version),
        agentCount: (findTool('openclaw')?.details?.agentCount as number) ?? 0,
      },
      codex: { ...mkTool('codex'), activeThreads: (findTool('codex')?.details?.threadCount as number) ?? 0 },
      claudeCode: { ...mkTool('claude-code'), recentSessions: (findTool('claude-code')?.details?.sessionCount as number) ?? 0 },
      gemini: mkTool('gemini'),
      cortex: {
        ...mkTool('cortex'),
        factCount: (findTool('cortex')?.details?.factCount as number) ?? 0,
        memoryCount: (findTool('cortex')?.details?.memoryCount as number) ?? 0,
      },
      ollama: {
        ...mkTool('ollama'),
        models: (findTool('ollama')?.details?.models as string[]) ?? [],
        hasEmbeddingModel: (findTool('ollama')?.details?.hasEmbed as boolean) ?? false,
      },
    },
    apiKeys,
    hasAnything: Boolean(raw.hasAnything),
    hasAgentSurface: Boolean(raw.hasAgentSurface),
    hasCliAgent: Boolean(raw.hasCliAgent),
    hasApiKey: Boolean(raw.hasApiKey),
    hasMemory: Boolean(raw.hasMemory),
    hasEmbeddings: Boolean(raw.hasEmbeddings),
    recommendedPath: String(raw.recommendedPath ?? 'full-wizard'),
    summary: String(raw.summary ?? ''),
  };
}

export function hasConfiguredApiKey(detection: DetectionResult): boolean {
  return detection.hasApiKey || detection.apiKeys.some((provider) => provider.configured);
}

export function hasAgentRuntime(detection: DetectionResult): boolean {
  return detection.hasAgentSurface
    || detection.hasCliAgent
    || detection.tools.openclaw.detected
    || detection.tools.codex.detected
    || detection.tools.claudeCode.detected
    || detection.tools.gemini.detected;
}

export function hasAnyUsableSetupPath(detection: DetectionResult): boolean {
  return hasAgentRuntime(detection) || hasConfiguredApiKey(detection);
}

export function evaluateSetupCompletion(
  detection: DetectionResult,
  goal: SetupCompletionGoal,
): SetupCompletionStatus {
  const apiKeyReady = hasConfiguredApiKey(detection);
  const agentRuntimeReady = hasAgentRuntime(detection);

  if (goal === 'agents') {
    return agentRuntimeReady
      ? {
          complete: true,
          title: 'You\'re Ready',
          description: 'An agent runtime is connected. You can add the optional tooling later in Settings.',
          missing: [],
        }
      : {
          complete: false,
          title: 'Setup Still Needs an Agent Runtime',
          description: 'Before setup can be marked complete, Cortex needs at least one coding runtime it can talk to.',
          missing: [
            'Install Codex, Claude Code, or Gemini CLI, or connect the OpenClaw agent surface.',
          ],
        };
  }

  if (goal === 'chat') {
    return apiKeyReady
      ? {
          complete: true,
          title: 'You\'re Ready',
          description: 'A model provider key is configured, so chat is ready to use.',
          missing: [],
        }
      : {
          complete: false,
          title: 'Setup Still Needs an API Key',
          description: 'Before setup can be marked complete, save a working API key for at least one chat provider.',
          missing: [
            'Add an Anthropic, OpenAI, or Google AI key and recheck setup.',
          ],
        };
  }

  return hasAnyUsableSetupPath(detection)
    ? {
        complete: true,
        title: 'You\'re Ready',
        description: 'Cortex has a usable runtime or provider configured. You can finish the optional pieces later in Settings.',
        missing: [],
      }
    : {
        complete: false,
        title: 'Setup Still Needs One More Thing',
        description: 'Before setup can be marked complete, Cortex needs either an agent runtime or a model provider key.',
        missing: [
          'Install a coding runtime such as Codex or Claude Code, or connect OpenClaw.',
          'Or save an Anthropic, OpenAI, or Google AI API key for chat.',
        ],
      };
}
