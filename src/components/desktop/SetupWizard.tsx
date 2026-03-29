'use client';

import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import {
  Check,
  ChevronRight,
  Terminal,
  Key,
  Brain,
  Globe,
  Zap,
  Copy,
  Cpu,
  Layers,
  MessageSquare,
  Sparkles,
} from 'lucide-react';

// ── Types ──

interface ToolDetection {
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
}

interface ApiKeyStatus {
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

type WizardMode = 'ready' | 'quick-setup' | 'full-wizard';
type FullWizardPath = 'agents' | 'chat' | 'explore';

const THEME_TEXT = 'var(--t-text)';
const THEME_TEXT_SECONDARY = 'var(--t-text-secondary)';
const THEME_TEXT_MUTED = 'var(--t-text-muted)';
const THEME_TEXT_FAINT = 'var(--t-text-faint)';
const THEME_PANEL = 'var(--t-panel)';
const THEME_PANEL_BORDER = 'var(--t-panel-border)';
const THEME_DIVIDER = 'var(--t-divider)';
const THEME_DIVIDER_SUBTLE = 'var(--t-divider-subtle)';
const THEME_ACCENT = 'var(--t-accent)';
const THEME_ACCENT_SOFT = 'var(--t-accent-soft)';
const THEME_ACCENT_SOFT_STRONG = 'var(--t-accent-soft-strong)';
const THEME_ACCENT_BORDER = 'var(--t-accent-border)';
const THEME_ACCENT_RING = 'var(--t-accent-ring)';
const THEME_SEARCH_BG = 'var(--t-search-bg)';
const THEME_SEARCH_BORDER = 'var(--t-search-border)';
const THEME_GLASS_ELEVATED = 'var(--t-glass-elevated, var(--t-panel-translucent))';
const THEME_GLASS_MUTED = 'var(--t-glass-muted, var(--t-panel-translucent))';
const THEME_GLASS_MUTED_STRONG = 'var(--t-glass-muted-strong, var(--t-panel))';
const THEME_GLASS_BORDER_STRONG = 'var(--t-glass-border-strong, var(--t-panel-border))';
const THEME_GLASS_SHADOW = 'var(--t-glass-shadow, var(--t-panel-shadow))';
const THEME_SHELL_BACKDROP = 'var(--t-shell-backdrop, rgba(15, 23, 42, 0.16))';

// ── Helpers ──

function deriveWizardMode(detection: DetectionResult): WizardMode {
  const { recommendedPath } = detection;
  if (recommendedPath === 'ready' || recommendedPath === 'add-memory') return 'ready';
  if (detection.hasAnything) return 'quick-setup';
  return 'full-wizard';
}

interface ToolDisplayInfo {
  id: string;
  name: string;
  detected: boolean;
  version?: string;
  detail?: string;
  icon: ReactNode;
}

function buildToolList(detection: DetectionResult): ToolDisplayInfo[] {
  const { tools, apiKeys } = detection;
  const configuredKeys = apiKeys.filter((k) => k.configured);

  return [
    {
      id: 'openclaw',
      name: 'OpenClaw Connector (Beta)',
      detected: tools.openclaw.detected,
      version: tools.openclaw.version,
      detail: tools.openclaw.agentCount ? `${tools.openclaw.agentCount} agents` : undefined,
      icon: <Layers size={16} strokeWidth={2} />,
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
      id: 'api-keys',
      name: 'API Keys',
      detected: configuredKeys.length > 0,
      detail: configuredKeys.length > 0 ? configuredKeys.map((k) => k.provider).join(', ') : undefined,
      icon: <Key size={16} strokeWidth={2} />,
    },
    {
      id: 'cortex',
      name: 'Cortex Memory',
      detected: tools.cortex.detected,
      version: tools.cortex.version,
      detail: tools.cortex.memoryCount ? `${tools.cortex.memoryCount} memories` : undefined,
      icon: <Brain size={16} strokeWidth={2} />,
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

// ── Animated check ──

function AnimatedCheck({ delay = 0 }: { delay?: number }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setVisible(true), delay);
    return () => clearTimeout(t);
  }, [delay]);

  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: 20,
      height: 20,
      borderRadius: '50%',
      background: visible ? '#22c55e' : 'rgba(34,197,94,0.15)',
      transition: 'all 400ms cubic-bezier(0.34, 1.56, 0.64, 1)',
      transform: visible ? 'scale(1)' : 'scale(0.5)',
      opacity: visible ? 1 : 0.3,
      flexShrink: 0,
    }}>
      <Check size={12} strokeWidth={3} color="#fff" style={{
        opacity: visible ? 1 : 0,
        transition: 'opacity 300ms ease',
        transitionDelay: '100ms',
      }} />
    </span>
  );
}

function GrayDot() {
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: 20,
      height: 20,
      borderRadius: '50%',
      background: THEME_DIVIDER_SUBTLE,
      flexShrink: 0,
    }}>
      <span style={{
        width: 6,
        height: 6,
        borderRadius: '50%',
        background: THEME_TEXT_FAINT,
      }} />
    </span>
  );
}

// ── Copy command button ──

function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      padding: '10px 12px',
      borderRadius: 10,
      background: THEME_GLASS_MUTED,
      border: `1px solid ${THEME_PANEL_BORDER}`,
      fontFamily: '"SF Mono", ui-monospace, monospace',
      fontSize: 12,
      color: THEME_TEXT,
      lineHeight: '18px',
    }}>
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {command}
      </span>
      <button
        onClick={() => {
          navigator.clipboard.writeText(command);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        }}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 28,
          height: 28,
          borderRadius: 6,
          border: 'none',
          background: copied ? 'rgba(34, 197, 94, 0.14)' : THEME_PANEL,
          color: copied ? '#22c55e' : THEME_TEXT_MUTED,
          cursor: 'pointer',
          flexShrink: 0,
          transition: 'all 150ms ease',
        }}
      >
        {copied ? <Check size={14} strokeWidth={2.5} /> : <Copy size={14} strokeWidth={2} />}
      </button>
    </div>
  );
}

// ── Step dots ──

function StepDots({ total, current }: { total: number; current: number }) {
  return (
    <div style={{ display: 'flex', gap: 6, justifyContent: 'center' }}>
      {Array.from({ length: total }).map((_, i) => (
        <span key={i} style={{
          width: i === current ? 18 : 6,
          height: 6,
          borderRadius: 999,
          background: i === current
            ? THEME_ACCENT
            : i < current ? THEME_ACCENT_SOFT_STRONG : THEME_DIVIDER,
          transition: 'all 300ms cubic-bezier(0.34, 1.56, 0.64, 1)',
        }} />
      ))}
    </div>
  );
}

// ── Glass button ──

function GlassButton({
  label,
  onClick,
  variant = 'primary',
  icon,
  disabled,
  style: overrideStyle,
}: {
  label: string;
  onClick: () => void;
  variant?: 'primary' | 'secondary' | 'ghost';
  icon?: ReactNode;
  disabled?: boolean;
  style?: CSSProperties;
}) {
  const base: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    padding: variant === 'ghost' ? '8px 12px' : '12px 24px',
    borderRadius: 12,
    fontSize: 14,
    fontWeight: 700,
    fontFamily: 'inherit',
    letterSpacing: '-0.01em',
    cursor: disabled ? 'not-allowed' : 'pointer',
    transition: 'all 200ms ease',
    border: 'none',
    opacity: disabled ? 0.5 : 1,
    ...(variant === 'primary' ? {
      background: `linear-gradient(180deg, #60a5fa 0%, ${THEME_ACCENT} 100%)`,
      color: '#fff',
      boxShadow: `0 12px 28px ${THEME_ACCENT_RING}, inset 0 1px 0 rgba(255,255,255,0.2)`,
    } : variant === 'secondary' ? {
      background: THEME_GLASS_MUTED_STRONG,
      color: THEME_TEXT,
      border: `1px solid ${THEME_PANEL_BORDER}`,
      boxShadow: '0 10px 24px rgba(0,0,0,0.06)',
    } : {
      background: 'transparent',
      color: THEME_TEXT_MUTED,
    }),
    ...overrideStyle,
  };

  return (
    <button disabled={disabled} onClick={disabled ? undefined : onClick} style={base}>
      {icon}
      {label}
    </button>
  );
}

function SetupWizardStepFrame({
  stepKey,
  direction,
  children,
}: {
  stepKey: string;
  direction: 'forward' | 'back';
  children: ReactNode;
}) {
  const [entering, setEntering] = useState(true);

  useEffect(() => {
    const t = window.setTimeout(() => setEntering(false), 50);
    return () => window.clearTimeout(t);
  }, []);

  return (
    <div
      key={stepKey}
      style={{
        opacity: entering ? 0 : 1,
        transform: entering
          ? direction === 'forward'
            ? 'translateY(12px) scale(0.985)'
            : 'translateY(-12px) scale(0.985)'
          : 'translateY(0) scale(1)',
        transition: 'opacity 220ms ease, transform 220ms cubic-bezier(0.34, 1.56, 0.64, 1)',
      }}
    >
      {children}
    </div>
  );
}

// ── Tool row ──

function ToolRow({ tool, index }: { tool: ToolDisplayInfo; index: number }) {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      padding: '8px 0',
    }}>
      {tool.detected ? <AnimatedCheck delay={index * 80} /> : <GrayDot />}
      <span style={{
        color: tool.detected ? THEME_TEXT : THEME_TEXT_MUTED,
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        fontSize: 13,
        fontWeight: 600,
      }}>
        {tool.icon}
        {tool.name}
      </span>
      {tool.version && (
        <span style={{
          fontSize: 10,
          fontWeight: 600,
          color: THEME_TEXT_MUTED,
          padding: '2px 6px',
          borderRadius: 999,
          background: THEME_DIVIDER_SUBTLE,
        }}>
          v{tool.version}
        </span>
      )}
      {tool.detail && (
        <span style={{
          fontSize: 11,
          color: THEME_TEXT_MUTED,
          marginLeft: 'auto',
        }}>
          {tool.detail}
        </span>
      )}
    </div>
  );
}

// ── Missing tool setup cards ──

interface MissingToolAction {
  id: string;
  name: string;
  description: string;
  command?: string;
  link?: string;
  icon: ReactNode;
}

function getMissingActions(detection: DetectionResult): MissingToolAction[] {
  const actions: MissingToolAction[] = [];
  const { tools, apiKeys } = detection;

  if (!tools.openclaw.detected) {
    actions.push({
      id: 'openclaw',
      name: 'OpenClaw Connector (Beta)',
      description: 'Optional beta connector for mirroring personal OpenClaw sessions into the IDE.',
      command: 'npm i -g openclaw && openclaw gateway start',
      icon: <Layers size={16} strokeWidth={2} />,
    });
  }

  if (!tools.codex.detected && !tools.claudeCode.detected) {
    actions.push({
      id: 'codex',
      name: 'CLI Agent (Codex)',
      description: 'A coding agent that runs in your terminal. Works on real repos with real tools.',
      command: 'npm i -g @openai/codex',
      icon: <Terminal size={16} strokeWidth={2} />,
    });
  }

  if (!apiKeys.some((k) => k.configured)) {
    actions.push({
      id: 'api-keys',
      name: 'API Keys',
      description: 'Add an API key from Anthropic, OpenAI, or Google to power model conversations.',
      icon: <Key size={16} strokeWidth={2} />,
    });
  }

  if (!tools.cortex.detected) {
    actions.push({
      id: 'cortex',
      name: 'Cortex Memory',
      description: 'Persistent AI memory. Your agents remember context across sessions.',
      command: 'go install github.com/hurttlocker/cortex@latest',
      icon: <Brain size={16} strokeWidth={2} />,
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

// ── Missing tool card ──

function MissingToolCard({
  action,
  onSkip,
}: {
  action: MissingToolAction;
  onSkip: () => void;
}) {
  return (
    <div style={{
      padding: '14px 16px',
      borderRadius: 14,
      background: THEME_GLASS_MUTED_STRONG,
      border: `1px solid ${THEME_PANEL_BORDER}`,
      display: 'flex',
      flexDirection: 'column',
      gap: 8,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ color: THEME_ACCENT }}>{action.icon}</span>
        <span style={{ fontSize: 13, fontWeight: 700, color: THEME_TEXT }}>{action.name}</span>
        <button
          onClick={onSkip}
          style={{
            marginLeft: 'auto',
            fontSize: 11,
            fontWeight: 600,
            color: THEME_TEXT_MUTED,
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            fontFamily: 'inherit',
          }}
        >
          Skip
        </button>
      </div>
      <div style={{ fontSize: 12, color: THEME_TEXT_SECONDARY, lineHeight: 1.5 }}>
        {action.description}
      </div>
      {action.command && <CopyCommand command={action.command} />}
      {action.link && (
        <a
          href={action.link}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: THEME_ACCENT,
            textDecoration: 'none',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
          }}
        >
          <Globe size={12} strokeWidth={2} />
          {action.link.replace('https://', '')}
          <ChevronRight size={12} strokeWidth={2} />
        </a>
      )}
    </div>
  );
}

// ── Full wizard path choice ──

function PathChoiceCard({
  icon,
  title,
  description,
  selected,
  onClick,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '14px 16px',
        borderRadius: 14,
        border: selected
          ? `1.5px solid ${THEME_ACCENT_BORDER}`
          : `1px solid ${THEME_PANEL_BORDER}`,
        background: selected
          ? THEME_ACCENT_SOFT_STRONG
          : THEME_GLASS_MUTED,
        cursor: 'pointer',
        textAlign: 'left',
        fontFamily: 'inherit',
        width: '100%',
        transition: 'all 200ms ease',
        boxShadow: selected ? `0 14px 30px ${THEME_ACCENT_RING}` : 'none',
      }}
    >
      <span style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 36,
        height: 36,
        borderRadius: 10,
        background: selected ? THEME_ACCENT_SOFT : THEME_DIVIDER_SUBTLE,
        color: selected ? THEME_ACCENT : THEME_TEXT_MUTED,
        flexShrink: 0,
      }}>
        {icon}
      </span>
      <div>
        <div style={{ fontSize: 13, fontWeight: 700, color: THEME_TEXT, letterSpacing: '-0.01em' }}>
          {title}
        </div>
        <div style={{ fontSize: 12, color: THEME_TEXT_SECONDARY, marginTop: 2, lineHeight: 1.4 }}>
          {description}
        </div>
      </div>
      <ChevronRight size={16} strokeWidth={2} style={{
        marginLeft: 'auto',
        color: selected ? THEME_ACCENT : THEME_TEXT_FAINT,
        flexShrink: 0,
      }} />
    </button>
  );
}

// ── API key inline input ──

function ApiKeyInput({ onSave }: { onSave: (provider: string, key: string) => void }) {
  const [provider, setProvider] = useState('anthropic');
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const providers = [
    { id: 'anthropic', name: 'Anthropic', env: 'ANTHROPIC_API_KEY', prefix: 'sk-ant-' },
    { id: 'openai', name: 'OpenAI', env: 'OPENAI_API_KEY', prefix: 'sk-' },
    { id: 'google', name: 'Google AI', env: 'GOOGLE_AI_API_KEY', prefix: 'AI' },
  ];

  const current = providers.find((p) => p.id === provider)!;

  const handleSave = async () => {
    if (!apiKey.trim()) return;
    setSaving(true);
    try {
      onSave(current.env, apiKey.trim());
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{
      padding: '14px 16px',
      borderRadius: 14,
      background: THEME_GLASS_MUTED_STRONG,
      border: `1px solid ${THEME_PANEL_BORDER}`,
      display: 'flex',
      flexDirection: 'column',
      gap: 10,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ color: THEME_ACCENT }}><Key size={16} strokeWidth={2} /></span>
        <span style={{ fontSize: 13, fontWeight: 700, color: THEME_TEXT }}>API Key</span>
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        {providers.map((p) => (
          <button
            key={p.id}
            onClick={() => setProvider(p.id)}
            style={{
              padding: '4px 10px',
              borderRadius: 6,
              border: provider === p.id
                ? `1px solid ${THEME_ACCENT_BORDER}`
                : `1px solid ${THEME_DIVIDER}`,
              background: provider === p.id ? THEME_ACCENT_SOFT : THEME_GLASS_MUTED,
              color: provider === p.id ? THEME_ACCENT : THEME_TEXT_MUTED,
              fontSize: 11,
              fontWeight: 600,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            {p.name}
          </button>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          type="password"
          placeholder={`${current.prefix}...`}
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          style={{
            flex: 1,
            padding: '8px 10px',
            borderRadius: 8,
            border: `1px solid ${THEME_SEARCH_BORDER}`,
            background: THEME_SEARCH_BG,
            fontSize: 12,
            fontFamily: '"SF Mono", ui-monospace, monospace',
            color: THEME_TEXT,
            outline: 'none',
          }}
        />
        <GlassButton
          label={saved ? 'Saved' : 'Save'}
          variant="secondary"
          onClick={handleSave}
          disabled={saving || !apiKey.trim()}
          style={{ padding: '8px 16px', fontSize: 12 }}
        />
      </div>
    </div>
  );
}

// ── Main Wizard Component ──

export const SetupWizard = memo(function SetupWizard({
  detection,
  onComplete,
}: {
  detection: DetectionResult;
  onComplete: () => void;
}) {
  const mode = useMemo(() => deriveWizardMode(detection), [detection]);
  const toolList = useMemo(() => buildToolList(detection), [detection]);
  const missingActions = useMemo(() => getMissingActions(detection), [detection]);

  const [step, setStep] = useState(0);
  const [fullWizardPath, setFullWizardPath] = useState<FullWizardPath | null>(null);
  const [skippedSteps, setSkippedSteps] = useState<string[]>([]);
  const [animDirection, setAnimDirection] = useState<'forward' | 'back'>('forward');
  const remainingQuickSetupActions = useMemo(
    () => missingActions.filter((action) => !skippedSteps.includes(action.id)),
    [missingActions, skippedSteps],
  );
  const quickSetupComplete = remainingQuickSetupActions.length === 0;

  const totalSteps = useMemo(() => {
    if (mode === 'ready') return 1;
    if (mode === 'quick-setup') return 3;
    return 4;
  }, [mode]);

  const goForward = useCallback(() => {
    setAnimDirection('forward');
    setStep((s) => Math.min(s + 1, totalSteps - 1));
  }, [totalSteps]);

  const goBack = useCallback(() => {
    setAnimDirection('back');
    setStep((s) => Math.max(s - 1, 0));
  }, []);

  const skipStep = useCallback((stepId: string) => {
    setSkippedSteps((prev) => [...prev, stepId]);
  }, []);

  // ── Step content renderers ──

  const renderReady = () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div style={{ textAlign: 'center' }}>
        <div style={{
          fontSize: 22,
          fontWeight: 800,
          color: THEME_TEXT,
          letterSpacing: '-0.03em',
          marginBottom: 6,
        }}>
          Welcome to o8
        </div>
        <div style={{ fontSize: 13, color: THEME_TEXT_SECONDARY, lineHeight: 1.6 }}>
          {detection.summary}
        </div>
      </div>

      <div style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        padding: '4px 0',
      }}>
        {toolList.filter((t) => t.detected).map((tool, i) => (
          <ToolRow key={tool.id} tool={tool} index={i} />
        ))}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'center' }}>
        <GlassButton
          label="Get Started"
          onClick={onComplete}
          icon={<Zap size={16} strokeWidth={2} />}
        />
        <button
          onClick={() => {
            onComplete();
            // Settings will be available from NavRail
          }}
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: THEME_TEXT_MUTED,
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            fontFamily: 'inherit',
          }}
        >
          Configure more in Settings
        </button>
      </div>
    </div>
  );

  const renderQuickSetupStep = () => {
    if (step === 0) {
      // Show detection summary
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          <div style={{ textAlign: 'center' }}>
            <div style={{
              fontSize: 22,
              fontWeight: 800,
              color: THEME_TEXT,
              letterSpacing: '-0.03em',
              marginBottom: 6,
            }}>
              Almost Ready
            </div>
            <div style={{ fontSize: 13, color: THEME_TEXT_SECONDARY, lineHeight: 1.6 }}>
              We found some tools on your machine. A few more things to set up.
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {toolList.map((tool, i) => (
              <ToolRow key={tool.id} tool={tool} index={i} />
            ))}
          </div>

          <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
            <GlassButton label="Set up missing tools" onClick={goForward} icon={<ChevronRight size={16} strokeWidth={2} />} />
            <GlassButton label="Skip all" variant="ghost" onClick={onComplete} />
          </div>
        </div>
      );
    }

    if (step === 1) {
      // Missing tools setup
      const remaining = remainingQuickSetupActions;

      if (quickSetupComplete) {
        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 20, alignItems: 'center' }}>
            <div style={{
              width: 56,
              height: 56,
              borderRadius: '50%',
              background: 'linear-gradient(135deg, #22c55e, #16a34a)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: '0 8px 24px rgba(34,197,94,0.3)',
            }}>
              <Check size={28} strokeWidth={3} color="#fff" />
            </div>

            <div style={{ textAlign: 'center' }}>
              <div style={{
                fontSize: 22,
                fontWeight: 800,
                color: THEME_TEXT,
                letterSpacing: '-0.03em',
                marginBottom: 6,
              }}>
                Setup complete
              </div>
              <div style={{ fontSize: 13, color: THEME_TEXT_SECONDARY, lineHeight: 1.6 }}>
                All required setup items are resolved. You can open the dashboard now.
              </div>
            </div>

            <GlassButton label="Open Dashboard" onClick={onComplete} icon={<Zap size={16} strokeWidth={2} />} />
          </div>
        );
      }

      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ textAlign: 'center' }}>
            <div style={{
              fontSize: 18,
              fontWeight: 800,
              color: THEME_TEXT,
              letterSpacing: '-0.02em',
              marginBottom: 4,
            }}>
              Set Up Missing Tools
            </div>
            <div style={{ fontSize: 12, color: THEME_TEXT_MUTED }}>
              Install what you need, skip the rest.
            </div>
          </div>

          {remaining.length > 0 ? (
            <div style={{
              padding: '10px 12px',
              borderRadius: 10,
              border: '1px solid rgba(245,158,11,0.22)',
              background: 'rgba(245,158,11,0.08)',
              color: THEME_TEXT_SECONDARY,
              fontSize: 11,
              lineHeight: 1.45,
            }}>
              {remaining.length} setup item{remaining.length === 1 ? '' : 's'} still need attention before Cortex can claim the setup is ready.
            </div>
          ) : null}

          <div style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            maxHeight: 320,
            overflowY: 'auto',
            scrollbarWidth: 'thin',
            scrollbarColor: 'var(--t-divider-strong) transparent',
          } as CSSProperties}>
            {remaining.map((action) =>
              action.id === 'api-keys' ? (
                <div key={action.id}>
                  <ApiKeyInput onSave={(env, key) => {
                    // Save to .env.local via settings API
                    fetch('/api/setup/config', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ [`env_${env}`]: key }),
                    }).catch(() => {});
                    skipStep(action.id);
                  }} />
                  <button
                    onClick={() => skipStep(action.id)}
                    style={{
                      fontSize: 11,
                      fontWeight: 600,
                      color: THEME_TEXT_MUTED,
                      background: 'none',
                      border: 'none',
                      cursor: 'pointer',
                      fontFamily: 'inherit',
                      marginTop: 4,
                      marginLeft: 4,
                    }}
                  >
                    Skip API key setup
                  </button>
                </div>
              ) : (
                <MissingToolCard
                  key={action.id}
                  action={action}
                  onSkip={() => skipStep(action.id)}
                />
              ),
            )}
          </div>

          <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between' }}>
            <GlassButton label="Back" variant="ghost" onClick={goBack} />
            <GlassButton
              label="Continue"
              onClick={goForward}
              icon={<ChevronRight size={16} strokeWidth={2} />}
              disabled={!quickSetupComplete}
            />
          </div>
        </div>
      );
    }

    // Step 2: Ready
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 20, alignItems: 'center' }}>
        <div style={{
          width: 56,
          height: 56,
          borderRadius: '50%',
          background: 'linear-gradient(135deg, #22c55e, #16a34a)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          boxShadow: '0 8px 24px rgba(34,197,94,0.3)',
        }}>
          <Check size={28} strokeWidth={3} color="#fff" />
        </div>

        <div style={{ textAlign: 'center' }}>
          <div style={{
            fontSize: 22,
            fontWeight: 800,
            color: THEME_TEXT,
            letterSpacing: '-0.03em',
            marginBottom: 6,
          }}>
            You{"'"}re Ready
          </div>
          <div style={{ fontSize: 13, color: THEME_TEXT_SECONDARY, lineHeight: 1.6 }}>
            o8 is set up. You can always configure more in Settings.
          </div>
        </div>

        <GlassButton label="Open Dashboard" onClick={onComplete} icon={<Zap size={16} strokeWidth={2} />} />
      </div>
    );
  };

  const renderFullWizardStep = () => {
    if (step === 0) {
      // Path choice
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          <div style={{ textAlign: 'center' }}>
            <div style={{
              fontSize: 22,
              fontWeight: 800,
              color: THEME_TEXT,
              letterSpacing: '-0.03em',
              marginBottom: 6,
            }}>
              Welcome to o8
            </div>
            <div style={{ fontSize: 13, color: THEME_TEXT_SECONDARY, lineHeight: 1.6 }}>
              Your command center for AI engineering. What do you want to do?
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <PathChoiceCard
              icon={<Terminal size={18} strokeWidth={2} />}
              title="I want AI agents working on my code"
              description="Install OpenClaw + a CLI agent to start automating engineering work."
              selected={fullWizardPath === 'agents'}
              onClick={() => setFullWizardPath('agents')}
            />
            <PathChoiceCard
              icon={<MessageSquare size={18} strokeWidth={2} />}
              title="I want to chat with AI models"
              description="Bring your own API key and start conversing with Claude, GPT, or Gemini."
              selected={fullWizardPath === 'chat'}
              onClick={() => setFullWizardPath('chat')}
            />
            <PathChoiceCard
              icon={<Globe size={18} strokeWidth={2} />}
              title="Just let me explore"
              description="Skip setup and head straight to the dashboard."
              selected={fullWizardPath === 'explore'}
              onClick={() => setFullWizardPath('explore')}
            />
          </div>

          <div style={{ display: 'flex', justifyContent: 'center' }}>
            <GlassButton
              label="Continue"
              onClick={() => {
                if (fullWizardPath === 'explore') {
                  onComplete();
                } else {
                  goForward();
                }
              }}
              disabled={!fullWizardPath}
              icon={<ChevronRight size={16} strokeWidth={2} />}
            />
          </div>
        </div>
      );
    }

    if (step === 1) {
      if (fullWizardPath === 'agents') {
        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={{ textAlign: 'center' }}>
              <div style={{
                fontSize: 18,
                fontWeight: 800,
                color: THEME_TEXT,
                letterSpacing: '-0.02em',
                marginBottom: 4,
              }}>
                Install Agent Runtime
              </div>
              <div style={{ fontSize: 12, color: THEME_TEXT_MUTED, lineHeight: 1.5 }}>
                Set up the tools that power your AI agents.
              </div>
            </div>

            <MissingToolCard
              action={{
                id: 'openclaw',
                name: 'OpenClaw Connector (Beta)',
                description: 'Optional beta connector for mirroring personal OpenClaw sessions into the IDE.',
                command: 'npm i -g openclaw && openclaw gateway start',
                icon: <Layers size={16} strokeWidth={2} />,
              }}
              onSkip={() => skipStep('openclaw')}
            />
            <MissingToolCard
              action={{
                id: 'codex',
                name: 'Codex CLI (Recommended)',
                description: 'A powerful coding agent by OpenAI. Runs in your terminal with full repo access.',
                command: 'npm i -g @openai/codex',
                icon: <Terminal size={16} strokeWidth={2} />,
              }}
              onSkip={() => skipStep('codex')}
            />
            <MissingToolCard
              action={{
                id: 'claude-code',
                name: 'Claude Code',
                description: 'Anthropic\'s CLI coding assistant. Deep codebase understanding.',
                command: 'npm i -g @anthropic-ai/claude-code',
                icon: <Sparkles size={16} strokeWidth={2} />,
              }}
              onSkip={() => skipStep('claude-code')}
            />

            <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between' }}>
              <GlassButton label="Back" variant="ghost" onClick={goBack} />
              <GlassButton label="Continue" onClick={goForward} icon={<ChevronRight size={16} strokeWidth={2} />} />
            </div>
          </div>
        );
      }

      // Chat path (BYOK)
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ textAlign: 'center' }}>
            <div style={{
              fontSize: 18,
              fontWeight: 800,
              color: THEME_TEXT,
              letterSpacing: '-0.02em',
              marginBottom: 4,
            }}>
              Connect Your AI Provider
            </div>
            <div style={{ fontSize: 12, color: THEME_TEXT_MUTED, lineHeight: 1.5 }}>
              Add an API key to start chatting with AI models.
            </div>
          </div>

          <ApiKeyInput onSave={(env, key) => {
            fetch('/api/setup/config', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ [`env_${env}`]: key }),
            }).catch(() => {});
          }} />

          <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between' }}>
            <GlassButton label="Back" variant="ghost" onClick={goBack} />
            <GlassButton label="Continue" onClick={goForward} icon={<ChevronRight size={16} strokeWidth={2} />} />
          </div>
        </div>
      );
    }

    if (step === 2) {
      // Optional memory setup
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ textAlign: 'center' }}>
            <div style={{
              fontSize: 18,
              fontWeight: 800,
              color: THEME_TEXT,
              letterSpacing: '-0.02em',
              marginBottom: 4,
            }}>
              Optional: Persistent Memory
            </div>
            <div style={{ fontSize: 12, color: THEME_TEXT_MUTED, lineHeight: 1.5 }}>
              Give your agents long-term memory and semantic search.
            </div>
          </div>

          <MissingToolCard
            action={{
              id: 'cortex',
              name: 'Cortex Memory',
              description: 'A personal knowledge graph. Agents remember context across sessions.',
              command: 'go install github.com/hurttlocker/cortex@latest',
              icon: <Brain size={16} strokeWidth={2} />,
            }}
            onSkip={() => skipStep('cortex')}
          />
          <MissingToolCard
            action={{
              id: 'ollama',
              name: 'Ollama (Embeddings)',
              description: 'Runs embedding models locally for semantic search in Cortex.',
              link: 'https://ollama.com',
              icon: <Cpu size={16} strokeWidth={2} />,
            }}
            onSkip={() => skipStep('ollama')}
          />

          <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between' }}>
            <GlassButton label="Back" variant="ghost" onClick={goBack} />
            <GlassButton label="Continue" onClick={goForward} icon={<ChevronRight size={16} strokeWidth={2} />} />
          </div>
        </div>
      );
    }

    // Step 3: Ready
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 20, alignItems: 'center' }}>
        <div style={{
          width: 56,
          height: 56,
          borderRadius: '50%',
          background: 'linear-gradient(135deg, #22c55e, #16a34a)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          boxShadow: '0 8px 24px rgba(34,197,94,0.3)',
        }}>
          <Check size={28} strokeWidth={3} color="#fff" />
        </div>

        <div style={{ textAlign: 'center' }}>
          <div style={{
            fontSize: 22,
            fontWeight: 800,
            color: THEME_TEXT,
            letterSpacing: '-0.03em',
            marginBottom: 6,
          }}>
            You{"'"}re Ready
          </div>
          <div style={{ fontSize: 13, color: THEME_TEXT_SECONDARY, lineHeight: 1.6 }}>
            o8 is set up and ready to go. You can always fine-tune settings later.
          </div>
        </div>

        <GlassButton label="Open Dashboard" onClick={onComplete} icon={<Zap size={16} strokeWidth={2} />} />
      </div>
    );
  };

  const renderCurrentStep = () => {
    if (mode === 'ready') return renderReady();
    if (mode === 'quick-setup') return renderQuickSetupStep();
    return renderFullWizardStep();
  };

  return (
    <div style={{
      position: 'fixed',
      inset: 0,
      zIndex: 99999,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: THEME_SHELL_BACKDROP,
      backdropFilter: 'blur(32px) saturate(1.04)',
      WebkitBackdropFilter: 'blur(32px) saturate(1.04)',
    } as CSSProperties}>
      {/* Glass card */}
      <div style={{
        width: '100%',
        maxWidth: 520,
        margin: '0 20px',
        padding: '32px 28px 24px',
        borderRadius: 20,
        background: THEME_GLASS_ELEVATED,
        border: `1px solid ${THEME_GLASS_BORDER_STRONG}`,
        backdropFilter: 'blur(38px) saturate(1.06)',
        WebkitBackdropFilter: 'blur(38px) saturate(1.06)',
        boxShadow: THEME_GLASS_SHADOW,
        position: 'relative',
        overflow: 'hidden',
      } as CSSProperties}>
        {/* Skip button (top right) */}
        <button
          onClick={onComplete}
          style={{
            position: 'absolute',
            top: 14,
            right: 14,
            width: 28,
            height: 28,
            borderRadius: 8,
            border: 'none',
            background: THEME_GLASS_MUTED,
            color: THEME_TEXT_MUTED,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1,
          }}
          title="Skip setup"
        >
          <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>

        {/* Animated step content */}
        <SetupWizardStepFrame
          stepKey={`${mode}:${step}:${fullWizardPath ?? 'none'}`}
          direction={animDirection}
        >
          {renderCurrentStep()}
        </SetupWizardStepFrame>

        {/* Step dots */}
        {totalSteps > 1 && (
          <div style={{ marginTop: 20 }}>
            <StepDots total={totalSteps} current={step} />
          </div>
        )}
      </div>
    </div>
  );
});
