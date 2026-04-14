import { Cpu, Globe, Key, Sparkles, Terminal, Zap } from '../lucide-shims';
import type { DetectionResult, MissingToolAction, ToolDisplayInfo, WizardMode } from './types';

export function deriveWizardMode(detection: DetectionResult): WizardMode {
  const { recommendedPath } = detection;
  if (recommendedPath === 'ready') return 'ready';
  if (detection.hasAnything) return 'quick-setup';
  return 'full-wizard';
}

export function buildToolList(detection: DetectionResult): ToolDisplayInfo[] {
  const { tools, apiKeys } = detection;
  const configuredKeys = apiKeys.filter((k) => k.configured);

  return [
    // o8 Operator is always "detected" — it's our branded free tier, baked in.
    {
      id: 'operator',
      name: 'o8 Operator',
      detected: true,
      detail: 'Free • zero setup',
      icon: <Zap size={16} strokeWidth={2} />,
    },
    {
      id: 'codex',
      name: 'Codex CLI',
      detected: tools.codex.detected,
      version: tools.codex.version,
      detail: tools.codex.activeThreads ? `${tools.codex.activeThreads} threads` : undefined,
      icon: <Terminal size={16} strokeWidth={2} />,
    },
    {
      id: 'claude-code',
      name: 'Claude Code',
      detected: tools.claudeCode.detected,
      version: tools.claudeCode.version,
      detail: tools.claudeCode.recentSessions ? `${tools.claudeCode.recentSessions} sessions` : undefined,
      icon: <Sparkles size={16} strokeWidth={2} />,
    },
    {
      id: 'gemini',
      name: 'Gemini CLI',
      detected: tools.gemini.detected,
      version: tools.gemini.version,
      icon: <Globe size={16} strokeWidth={2} />,
    },
    {
      id: 'opencode',
      name: 'OpenCode',
      detected: tools.opencode?.detected ?? false,
      version: tools.opencode?.version,
      detail: tools.opencode?.authedProviders?.length
        ? `${tools.opencode.authedProviders.length} providers`
        : undefined,
      icon: <Terminal size={16} strokeWidth={2} />,
    },
    {
      id: 'openrouter',
      name: 'OpenRouter',
      detected: configuredKeys.some((k) => k.provider === 'openrouter'),
      detail: configuredKeys.some((k) => k.provider === 'openrouter') ? 'key configured' : undefined,
      icon: <Key size={16} strokeWidth={2} />,
    },
    {
      id: 'ollama',
      name: 'Ollama',
      detected: tools.ollama.detected,
      detail: tools.ollama.models?.length ? `${tools.ollama.models.length} models` : undefined,
      icon: <Cpu size={16} strokeWidth={2} />,
    },
  ];
}

export function getMissingActions(detection: DetectionResult): MissingToolAction[] {
  const actions: MissingToolAction[] = [];
  const { tools, apiKeys } = detection;

  // o8 Operator is always available — only suggest CLIs / OpenRouter for power users.
  const hasAnyCli = tools.codex.detected
    || tools.claudeCode.detected
    || tools.gemini.detected
    || (tools.opencode?.detected ?? false);

  if (!hasAnyCli) {
    actions.push({
      id: 'opencode',
      name: 'OpenCode CLI (optional)',
      description: '75+ providers in one CLI — install and run `opencode auth login` to bring your own keys.',
      command: 'npm i -g opencode-ai',
      icon: <Terminal size={16} strokeWidth={2} />,
    });
  }

  const hasOpenRouter = apiKeys.some((k) => k.configured && k.provider === 'openrouter');
  if (!hasOpenRouter) {
    actions.push({
      id: 'openrouter',
      name: 'OpenRouter (optional)',
      description: 'One key, 100+ models. Powers the Operator fallback when Gemini quota runs out.',
      link: 'https://openrouter.ai/keys',
      icon: <Key size={16} strokeWidth={2} />,
    });
  }

  if (!tools.ollama.detected) {
    actions.push({
      id: 'ollama',
      name: 'Ollama',
      description: 'Local models for embeddings and inference. Powers semantic search.',
      link: 'https://ollama.com',
      icon: <Cpu size={16} strokeWidth={2} />,
    });
  }

  return actions;
}
