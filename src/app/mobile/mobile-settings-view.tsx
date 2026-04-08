'use client';

import {
  CLI_MODELS,
  API_MODELS,
  EFFORT_LEVELS,
  MOBILE_BODY_TRACKING,
  MOBILE_CARD_RADIUS,
  MOBILE_HEADING_TRACKING,
  MOBILE_TOUCH_TARGET,
  IconGear,
  formatAboutVersion,
  mobileFontFamily,
  renderConnectionLabel,
  type CliEffort,
  type MobilePalette,
  type ModelOption,
} from './mobile-approvals-shared';
import {
  MobileGlassPanel,
  MobileMetricChip,
  MobileSectionHeading,
  MobileStatusDot,
  MobileSurfaceRoot,
  MobileThreadListRoot,
  mobileSafeBottom,
} from './mobile-shell-primitives';

interface SettingsViewProps {
  themeId: string;
  onThemeChange: (theme: 'light' | 'dark') => void;
  selectedModel: ModelOption;
  onModelChange: (modelId: string) => void;
  effortLevel: CliEffort | null;
  onEffortChange: (effort: CliEffort | null) => void;
  connectionStatus: 'connected' | 'disconnected';
  appVersion: string;
  palette: MobilePalette;
}

export function SettingsView({
  themeId,
  onThemeChange,
  selectedModel,
  onModelChange,
  effortLevel,
  onEffortChange,
  connectionStatus,
  appVersion,
  palette,
}: SettingsViewProps) {
  const connectionColor = connectionStatus === 'connected' ? palette.success : palette.danger;

  return (
    <MobileSurfaceRoot>
      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          paddingBottom: mobileSafeBottom(24),
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, padding: '0 4px' }}>
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: palette.rootText, letterSpacing: MOBILE_BODY_TRACKING }}>
              {selectedModel.label}
            </div>
            <div style={{ width: 6, height: 6, borderRadius: 999, backgroundColor: connectionColor, flexShrink: 0 }} />
          </div>
          <div style={{ fontSize: 11, fontWeight: 600, color: palette.subduedText }}>
            {themeId === 'light' ? 'Light' : 'Dark'}
          </div>
        </div>

        <MobileGlassPanel palette={palette} style={{ padding: 18, marginBottom: 14 }}>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: palette.subduedText, marginBottom: 14 }}>
            Appearance
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            {(['dark', 'light'] as const).map((mode) => {
              const active = themeId === mode;
              return (
                <button
                  key={mode}
                  type="button"
                  onClick={() => onThemeChange(mode)}
                  style={{
                    flex: 1,
                    minHeight: MOBILE_TOUCH_TARGET,
                    borderRadius: MOBILE_CARD_RADIUS,
                    border: `1px solid ${active ? palette.accentBorder : palette.cardBorder}`,
                    background: active ? palette.accentSoft : palette.panelBackground,
                    color: active ? palette.accent : palette.rootText,
                    fontSize: 14,
                    fontWeight: 700,
                    letterSpacing: MOBILE_BODY_TRACKING,
                    fontFamily: mobileFontFamily(),
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 8,
                  }}
                >
                  <svg width="18" height="18" viewBox="0 0 256 256" fill={active ? palette.accent : palette.iconFill}>
                    <path d={mode === 'dark'
                      ? 'M233.54,142.23a8,8,0,0,0-8-2,88.08,88.08,0,0,1-109.8-109.8,8,8,0,0,0-10-10,104.84,104.84,0,0,0-52.91,37A104,104,0,0,0,135.21,232.43,104.84,104.84,0,0,0,183,218.14a104.84,104.84,0,0,0,37-52.91A8,8,0,0,0,233.54,142.23Z'
                      : 'M120,40V32a8,8,0,0,1,16,0v8a8,8,0,0,1-16,0Zm72,88a64,64,0,1,1-64-64A64.07,64.07,0,0,1,192,128Zm-16,0a48,48,0,1,0-48,48A48.05,48.05,0,0,0,176,128ZM58.34,69.66A8,8,0,0,0,69.66,58.34l-8-8A8,8,0,0,0,50.34,61.66Zm0,116.68-8,8a8,8,0,0,0,11.32,11.32l8-8a8,8,0,0,0-11.32-11.32ZM192,72a8,8,0,0,0,5.66-2.34l8-8a8,8,0,0,0-11.32-11.32l-8,8A8,8,0,0,0,192,72Zm5.66,114.34a8,8,0,0,0-11.32,11.32l8,8a8,8,0,0,0,11.32-11.32ZM40,120H32a8,8,0,0,0,0,16h8a8,8,0,0,0,0-16Zm88,88a8,8,0,0,0-8,8v8a8,8,0,0,0,16,0v-8A8,8,0,0,0,128,208Zm96-88h-8a8,8,0,0,0,0,16h8a8,8,0,0,0,0-16Z'
                    } />
                  </svg>
                  {mode === 'dark' ? 'Dark' : 'Light'}
                </button>
              );
            })}
          </div>
        </MobileGlassPanel>

        <MobileGlassPanel palette={palette} style={{ padding: 18, marginBottom: 14 }}>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: palette.subduedText, marginBottom: 12 }}>
            Model
          </div>

          {/* All models — grouped by provider */}
          {(() => {
            const allModels = [...CLI_MODELS, ...API_MODELS];
            const providerOrder = ['anthropic', 'google', 'openai'] as const;
            const providerLabels: Record<string, string> = { anthropic: 'Anthropic', google: 'Google', openai: 'OpenAI' };
            const providerColors: Record<string, string> = { anthropic: '#d97706', google: '#4285f4', openai: '#10a37f' };
            return providerOrder.map((provider) => {
              const models = allModels.filter((m) => m.provider === provider);
              if (models.length === 0) return null;
              return (
                <div key={provider} style={{ marginBottom: 8 }}>
                  <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: providerColors[provider] ?? palette.subduedText, marginBottom: 4, paddingLeft: 12 }}>
                    {providerLabels[provider] ?? provider}
                  </div>
                  {models.map((model) => {
                    const active = selectedModel.id === model.id;
                    return (
                      <button key={model.id} type="button" onClick={() => onModelChange(model.id)} style={{ width: '100%', height: MOBILE_TOUCH_TARGET, display: 'flex', alignItems: 'center', gap: 10, padding: '0 12px', borderRadius: 10, border: 'none', background: active ? palette.accentSoft : 'transparent', cursor: 'pointer', fontFamily: mobileFontFamily(), marginBottom: 2 }}>
                        <div style={{ width: 8, height: 8, borderRadius: 999, border: active ? 'none' : `1.5px solid ${palette.mutedText}`, backgroundColor: active ? palette.accent : 'transparent', flexShrink: 0 }} />
                        <div style={{ flex: 1, fontSize: 14, fontWeight: active ? 700 : 500, color: active ? palette.rootText : palette.mutedText, textAlign: 'left', letterSpacing: MOBILE_BODY_TRACKING }}>{model.label}</div>
                      </button>
                    );
                  })}
                </div>
              );
            });
          })()}
        </MobileGlassPanel>

        {selectedModel.cliRuntime === 'claude-code' ? (
          <MobileGlassPanel palette={palette} style={{ padding: 18, marginBottom: 14 }}>
            <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: palette.subduedText, marginBottom: 12 }}>
              Thinking Effort
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              {EFFORT_LEVELS.map((level) => {
                const activeEffort = effortLevel ?? selectedModel.defaultEffort ?? 'high';
                const active = activeEffort === level.value;
                return (
                  <button
                    key={level.value}
                    type="button"
                    onClick={() => onEffortChange(level.value)}
                    style={{
                      flex: 1,
                      minHeight: 38,
                      borderRadius: 10,
                      border: `1px solid ${active ? palette.accentBorder : palette.cardBorder}`,
                      background: active ? palette.accentSoft : palette.panelBackground,
                      color: active ? palette.accent : palette.mutedText,
                      fontSize: 12,
                      fontWeight: active ? 700 : 500,
                      letterSpacing: MOBILE_BODY_TRACKING,
                      fontFamily: mobileFontFamily(),
                      cursor: 'pointer',
                      padding: '6px 4px',
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: 2,
                    }}
                  >
                    <span>{level.label}</span>
                  </button>
                );
              })}
            </div>
            <div style={{ fontSize: 11, color: palette.subduedText, marginTop: 8, letterSpacing: MOBILE_BODY_TRACKING }}>
              {EFFORT_LEVELS.find((l) => l.value === (effortLevel ?? selectedModel.defaultEffort ?? 'high'))?.description ?? ''}
            </div>
          </MobileGlassPanel>
        ) : null}

        <MobileGlassPanel palette={palette} style={{ padding: 18, marginBottom: 14 }}>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: palette.subduedText, marginBottom: 14 }}>
            Connection
          </div>
          <div
            style={{
              borderRadius: MOBILE_CARD_RADIUS,
              border: `1px solid ${connectionStatus === 'connected' ? palette.successBorder : palette.dangerBorder}`,
              background: connectionStatus === 'connected' ? palette.successSoft : palette.dangerSoft,
              padding: '14px 16px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 12,
            }}
          >
            <div>
              <div style={{ fontSize: 16, fontWeight: 800, color: palette.rootText, letterSpacing: MOBILE_HEADING_TRACKING }}>
                WebSocket Bridge
              </div>
              <div style={{ fontSize: 12, lineHeight: 1.6, color: palette.subduedText, marginTop: 4, letterSpacing: MOBILE_BODY_TRACKING }}>
                {connectionStatus === 'connected'
                  ? 'Live transport is available for the mobile shell.'
                  : 'The mobile shell cannot reach the local bridge right now.'}
              </div>
            </div>
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 8,
                fontSize: 13,
                fontWeight: 700,
                color: palette.rootText,
                flexShrink: 0,
              }}
            >
              <MobileStatusDot color={connectionColor} />
              {renderConnectionLabel(connectionStatus)}
            </span>
          </div>
        </MobileGlassPanel>

        <MobileGlassPanel palette={palette} style={{ padding: 18 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
            <div
              style={{
                width: 44,
                height: 44,
                borderRadius: MOBILE_CARD_RADIUS,
                border: `1px solid ${palette.cardBorder}`,
                background: palette.panelBackground,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
              }}
            >
              <IconGear fill={palette.iconFill} />
            </div>
            <div>
              <div style={{ fontSize: 16, fontWeight: 800, color: palette.rootText, letterSpacing: MOBILE_HEADING_TRACKING }}>
                About o8 mobile
              </div>
              <div style={{ fontSize: 12, color: palette.subduedText, marginTop: 4, letterSpacing: MOBILE_BODY_TRACKING }}>
                Version {formatAboutVersion(appVersion)}
              </div>
            </div>
          </div>
          <div style={{ fontSize: 13, lineHeight: 1.7, color: palette.subduedText, letterSpacing: MOBILE_BODY_TRACKING }}>
            Native-feeling command surface for approvals, chat history, and assistant-driven work on the go.
          </div>
        </MobileGlassPanel>
      </div>
    </MobileSurfaceRoot>
  );
}
