'use client';

import {
  AVAILABLE_MODELS,
  MOBILE_BODY_TRACKING,
  MOBILE_CARD_RADIUS,
  MOBILE_HEADING_TRACKING,
  IconGear,
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
  selectedModel: ModelOption;
  onModelChange: (modelId: string) => void;
  connectionStatus: 'connected' | 'disconnected';
  appVersion: string;
  palette: MobilePalette;
}

export function SettingsView({
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
            title="o8 mobile"
            subtitle="Brand-locked controls for the default model, transport status, and runtime identity."
            palette={palette}
          />

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, marginTop: 18 }}>
            <MobileMetricChip label="Palette" value="o8 Dark" palette={palette} tone="accent" />
            <MobileMetricChip label="Model" value={selectedModel.label} palette={palette} />
            <MobileMetricChip
              label="Bridge"
              value={renderConnectionLabel(connectionStatus)}
              palette={palette}
              tone={connectionStatus === 'connected' ? 'success' : 'danger'}
            />
          </div>
        </MobileGlassPanel>

        <MobileGlassPanel palette={palette} style={{ padding: 18, marginBottom: 14 }}>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: palette.subduedText, marginBottom: 14 }}>
            Brand system
          </div>
          <div
            style={{
              borderRadius: MOBILE_CARD_RADIUS,
              border: `1px solid ${palette.accentBorder}`,
              background: 'rgba(37, 99, 235, 0.12)',
              padding: 16,
            }}
          >
            <div style={{ fontSize: 17, fontWeight: 800, color: palette.rootText, letterSpacing: MOBILE_HEADING_TRACKING }}>
              Fixed o8 Dark shell
            </div>
            <div style={{ fontSize: 13, lineHeight: 1.65, color: palette.subduedText, letterSpacing: MOBILE_BODY_TRACKING, marginTop: 8 }}>
              The mobile shell stays locked to the brand palette with a graphite base, explicit blue focus, red destructive state, 14px radii, 44px touch targets, and system typography.
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 14 }}>
              <MobileMetricChip label="Background" value="#111111" palette={palette} />
              <MobileMetricChip label="Accent" value="#2563eb" palette={palette} tone="accent" />
            </div>
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
                    minHeight: 72,
                    borderRadius: MOBILE_CARD_RADIUS,
                    border: `1px solid ${active ? palette.accentBorder : palette.cardBorder}`,
                    background: active ? palette.accentSoft : palette.panelBackground,
                    padding: 16,
                    color: palette.rootText,
                    textAlign: 'left',
                    cursor: 'pointer',
                    fontFamily: mobileFontFamily(),
                    letterSpacing: MOBILE_BODY_TRACKING,
                    display: 'flex',
                    gap: 12,
                    alignItems: 'flex-start',
                    backdropFilter: 'blur(20px)',
                    WebkitBackdropFilter: 'blur(20px)',
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
                    <div style={{ fontSize: 15, fontWeight: 800, color: palette.rootText, letterSpacing: MOBILE_HEADING_TRACKING }}>
                      {model.label}
                    </div>
                    <div style={{ fontSize: 12, color: palette.subduedText, marginTop: 4, lineHeight: 1.6, letterSpacing: MOBILE_BODY_TRACKING }}>
                      {model.description}
                    </div>
                    <div style={{ fontSize: 11, color: palette.subduedText, marginTop: 6, letterSpacing: MOBILE_BODY_TRACKING }}>
                      {model.id}
                    </div>
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
