'use client';

import { memo, useCallback, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import {
  Check,
  ChevronRight,
  Cpu,
  Globe,
  MessageSquare,
  Sparkles,
  Terminal,
  Zap,
} from './lucide-shims';
import {
  GlassButton,
  SetupWizardStepFrame,
  StepDots,
  ToolRow,
} from './setup-wizard/atoms';
import { ApiKeyInput } from './setup-wizard/ApiKeyInput';
import { MissingToolCard } from './setup-wizard/MissingToolCard';
import { PathChoiceCard } from './setup-wizard/PathChoiceCard';
import { buildToolList, deriveWizardMode, getMissingActions } from './setup-wizard/helpers';
import {
  THEME_GLASS_BORDER_STRONG,
  THEME_GLASS_ELEVATED,
  THEME_GLASS_MUTED,
  THEME_GLASS_SHADOW,
  THEME_SHELL_BACKDROP,
  THEME_TEXT,
  THEME_TEXT_MUTED,
  THEME_TEXT_SECONDARY,
} from './setup-wizard/theme';
import type { DetectionResult, FullWizardPath } from './setup-wizard/types';

export type { DetectionResult } from './setup-wizard/types';

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
          Launch agents, connect providers, and manage your workspace from one control surface.
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
          onClick={onComplete}
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
              description="Install a CLI agent to start automating engineering work."
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
              Optional: Local Models
            </div>
            <div style={{ fontSize: 12, color: THEME_TEXT_MUTED, lineHeight: 1.5 }}>
              Run local models on your machine for search and offline experimentation.
            </div>
          </div>

          <MissingToolCard
            action={{
              id: 'ollama',
              name: 'Ollama',
              description: 'Runs local models for search, experiments, and offline workflows.',
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

        <SetupWizardStepFrame
          stepKey={`${mode}:${step}:${fullWizardPath ?? 'none'}`}
          direction={animDirection}
        >
          {renderCurrentStep()}
        </SetupWizardStepFrame>

        {totalSteps > 1 && (
          <div style={{ marginTop: 20 }}>
            <StepDots total={totalSteps} current={step} />
          </div>
        )}
      </div>
    </div>
  );
});
