'use client';

import {
  AVAILABLE_MODELS,
  IconGear,
  IconMoon,
  IconSun,
  formatAboutVersion,
  mobileFontFamily,
  renderConnectionLabel,
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
  onThemeChange: (themeId: 'light' | 'dark') => void;
  selectedModel: ModelOption;
  onModelChange: (modelId: string) => void;
  connectionStatus: 'connected' | 'disconnected';
  appVersion: string;
  palette: MobilePalette;
}

function ToggleCard({
  label,
  detail,
  active,
  icon,
  onClick,
  palette,
}: {
  label: string;
  detail: string;
  active: boolean;
  icon: React.ReactNode;
  onClick: () => void;
  palette: MobilePalette;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        minHeight: 120,
        borderRadius: 20,
        border: `1px solid ${active ? palette.accentBorder : palette.cardBorder}`,
        background: active
          ? `linear-gradient(135deg, ${palette.accentSoft} 0%, ${palette.panelBackground} 100%)`
          : palette.cardBackground,
        color: palette.rootText,
        padding: 16,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        alignItems: 'flex-start',
        cursor: 'pointer',
        fontFamily: mobileFontFamily(),
        backdropFilter: 'blur(20px)',
        WebkitBackdropFilter: 'blur(20px)',
      }}
    >
      <div
        style={{
          width: 42,
          height: 42,
          borderRadius: 16,
          border: `1px solid ${active ? palette.accentBorder : palette.cardBorder}`,
          background: active ? palette.panelBackground : palette.panelElevated,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {icon}
      </div>
      <div style={{ textAlign: 'left' }}>
        <div style={{ fontSize: 16, fontWeight: 800, color: palette.rootText }}>
          {label}
        </div>
        <div style={{ fontSize: 12, lineHeight: 1.6, color: palette.subduedText, marginTop: 5 }}>
          {detail}
        </div>
      </div>
    </button>
  );
}

export function SettingsView({
  themeId,
  onThemeChange,
  selectedModel,
  onModelChange,
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
        <MobileGlassPanel palette={palette} style={{ padding: 20, marginBottom: 14 }}>
          <MobileSectionHeading
            eyebrow="Settings"
            title="Control center"
            subtitle="Tune the shell appearance, the default model, and the live bridge state for mobile."
            palette={palette}
          />

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, marginTop: 18 }}>
            <MobileMetricChip label="Theme" value={themeId === 'dark' ? 'Dark' : 'Light'} palette={palette} tone="accent" />
            <MobileMetricChip label="Model" value={selectedModel.label} palette={palette} />
            <MobileMetricChip label="Bridge" value={renderConnectionLabel(connectionStatus)} palette={palette} tone={connectionStatus === 'connected' ? 'success' : 'danger'} />
          </div>
        </MobileGlassPanel>

        <MobileGlassPanel palette={palette} style={{ padding: 18, marginBottom: 14 }}>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: palette.subduedText, marginBottom: 14 }}>
            Theme
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <ToggleCard
              label="Light"
              detail="Warm paper glass with crisp blue focus."
              active={themeId !== 'dark'}
              icon={<IconSun fill="#1a1a2e" />}
              onClick={() => onThemeChange('light')}
              palette={palette}
            />
            <ToggleCard
              label="Dark"
              detail="Default graphite shell with bright white type."
              active={themeId === 'dark'}
              icon={<IconMoon fill="#ffffff" />}
              onClick={() => onThemeChange('dark')}
              palette={palette}
            />
          </div>
        </MobileGlassPanel>

        <MobileGlassPanel palette={palette} style={{ padding: 18, marginBottom: 14 }}>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: palette.subduedText, marginBottom: 14 }}>
            Model
          </div>
          <MobileThreadListRoot style={{ gap: 10 }}>
            {AVAILABLE_MODELS.map((model) => {
              const active = selectedModel.id === model.id;

              return (
                <button
                  key={model.id}
                  type="button"
                  onClick={() => onModelChange(model.id)}
                  style={{
                    width: '100%',
                    borderRadius: 18,
                    border: `1px solid ${active ? palette.accentBorder : palette.cardBorder}`,
                    background: active
                      ? `linear-gradient(135deg, ${palette.accentSoft} 0%, ${palette.panelBackground} 100%)`
                      : palette.cardBackground,
                    padding: 16,
                    color: palette.rootText,
                    textAlign: 'left',
                    cursor: 'pointer',
                    fontFamily: mobileFontFamily(),
                    display: 'flex',
                    gap: 12,
                    alignItems: 'flex-start',
                  }}
                >
                  <div
                    style={{
                      width: 12,
                      height: 12,
                      marginTop: 5,
                      borderRadius: 999,
                      border: `1px solid ${active ? palette.accent : palette.cardBorder}`,
                      backgroundColor: active ? palette.accent : 'transparent',
                      flexShrink: 0,
                    }}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 15, fontWeight: 800, color: palette.rootText }}>
                      {model.label}
                    </div>
                    <div style={{ fontSize: 12, color: palette.subduedText, marginTop: 4, lineHeight: 1.6 }}>
                      {model.description}
                    </div>
                    <div style={{ fontSize: 11, color: palette.subduedText, marginTop: 6 }}>
                      {model.id}
                    </div>
                  </div>
                  <div
                    style={{
                      fontSize: 11,
                      fontWeight: 700,
                      letterSpacing: '0.08em',
                      textTransform: 'uppercase',
                      color: palette.subduedText,
                      flexShrink: 0,
                    }}
                  >
                    {model.provider}
                  </div>
                </button>
              );
            })}
          </MobileThreadListRoot>
        </MobileGlassPanel>

        <MobileGlassPanel palette={palette} style={{ padding: 18, marginBottom: 14 }}>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: palette.subduedText, marginBottom: 14 }}>
            Connection
          </div>
          <div
            style={{
              borderRadius: 18,
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
              <div style={{ fontSize: 16, fontWeight: 800, color: palette.rootText }}>
                WebSocket Bridge
              </div>
              <div style={{ fontSize: 12, lineHeight: 1.6, color: palette.subduedText, marginTop: 4 }}>
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
                width: 40,
                height: 40,
                borderRadius: 16,
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
              <div style={{ fontSize: 16, fontWeight: 800, color: palette.rootText }}>
                About o8 mobile
              </div>
              <div style={{ fontSize: 12, color: palette.subduedText, marginTop: 4 }}>
                Version {formatAboutVersion(appVersion)}
              </div>
            </div>
          </div>
          <div style={{ fontSize: 13, lineHeight: 1.7, color: palette.subduedText }}>
            Mobile command surface for approvals, conversation history, and assistant-driven work.
          </div>
        </MobileGlassPanel>
      </div>
    </MobileSurfaceRoot>
  );
}
