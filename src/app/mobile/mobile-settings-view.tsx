'use client';

import {
  AVAILABLE_MODELS,
  IconGear,
  IconMoon,
  IconSun,
  MobilePalette,
  formatAboutVersion,
  mobileCardStyle,
  mobileFontFamily,
  renderConnectionLabel,
  sectionLabelStyle,
  type ModelOption,
} from './mobile-approvals-shared';

interface SettingsViewProps {
  themeId: string;
  onThemeChange: (themeId: 'light' | 'dark') => void;
  selectedModel: ModelOption;
  onModelChange: (modelId: string) => void;
  connectionStatus: 'connected' | 'disconnected';
  appVersion: string;
  palette: MobilePalette;
}

function StatusDot({ color }: { color: string }) {
  return (
    <span
      style={{
        width: 10,
        height: 10,
        borderRadius: 999,
        backgroundColor: color,
        display: 'inline-flex',
        flexShrink: 0,
      }}
    />
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
  const sectionTitle = sectionLabelStyle(palette);
  const lightActive = themeId !== 'dark';
  const darkActive = themeId === 'dark';
  const connectionColor = connectionStatus === 'connected' ? palette.success : palette.danger;

  return (
    <div style={{ display: 'grid', gap: 16, paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 16px)', overflowY: 'auto' }}>
      <section
        style={{
          ...mobileCardStyle(palette, {
            padding: 22,
            background: palette.panelElevated,
          }),
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
          <div
            style={{
              width: 44,
              height: 44,
              borderRadius: 16,
              background: palette.panelBackground,
              border: `1px solid ${palette.cardBorder}`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <IconGear fill={palette.iconFill} />
          </div>
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: palette.subduedText }}>
              Personalize
            </div>
            <div style={{ fontSize: 22, fontWeight: 800, letterSpacing: '-0.04em', color: palette.rootText }}>
              Mobile Settings
            </div>
          </div>
        </div>
        <div style={{ display: 'grid', gap: 10 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
            <span style={{ fontSize: 13, color: palette.subduedText }}>Theme</span>
            <span style={{ fontSize: 13, color: palette.rootText }}>{lightActive ? 'Light' : 'Dark'}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
            <span style={{ fontSize: 13, color: palette.subduedText }}>Model</span>
            <span style={{ fontSize: 13, color: palette.rootText }}>{selectedModel.label}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center' }}>
            <span style={{ fontSize: 13, color: palette.subduedText }}>Bridge</span>
            <span style={{ fontSize: 13, color: palette.rootText, display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              <StatusDot color={connectionColor} />
              {renderConnectionLabel(connectionStatus)}
            </span>
          </div>
        </div>
      </section>

      <section
        style={{
          ...mobileCardStyle(palette, {
            padding: 18,
            background: palette.panelElevated,
          }),
        }}
      >
        <div style={sectionTitle}>Theme</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 14 }}>
          <button
            onClick={() => onThemeChange('light')}
            style={{
              minHeight: 110,
              borderRadius: 20,
              border: `1px solid ${lightActive ? palette.accentBorder : palette.cardBorder}`,
              background: lightActive ? palette.panelBackground : 'rgba(255,255,255,0.2)',
              padding: 16,
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'space-between',
              alignItems: 'flex-start',
              cursor: 'pointer',
              color: palette.rootText,
              fontFamily: mobileFontFamily(),
            }}
          >
            <div
              style={{
                width: 36,
                height: 36,
                borderRadius: 14,
                background: 'rgba(255,255,255,0.82)',
                border: '1px solid rgba(37,99,235,0.14)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <IconSun fill="#1a1a2e" />
            </div>
            <div>
              <div style={{ fontSize: 15, fontWeight: 700 }}>Light</div>
              <div style={{ fontSize: 12, color: palette.subduedText, marginTop: 4 }}>
                Warm paper, soft blue glass
              </div>
            </div>
          </button>
          <button
            onClick={() => onThemeChange('dark')}
            style={{
              minHeight: 110,
              borderRadius: 20,
              border: `1px solid ${darkActive ? palette.accentBorder : palette.cardBorder}`,
              background: darkActive ? palette.panelBackground : 'rgba(17,17,17,0.22)',
              padding: 16,
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'space-between',
              alignItems: 'flex-start',
              cursor: 'pointer',
              color: palette.rootText,
              fontFamily: mobileFontFamily(),
            }}
          >
            <div
              style={{
                width: 36,
                height: 36,
                borderRadius: 14,
                background: 'rgba(17,17,17,0.88)',
                border: '1px solid rgba(255,255,255,0.12)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <IconMoon fill="#ffffff" />
            </div>
            <div>
              <div style={{ fontSize: 15, fontWeight: 700 }}>Dark</div>
              <div style={{ fontSize: 12, color: palette.subduedText, marginTop: 4 }}>
                Graphite glass and aurora glow
              </div>
            </div>
          </button>
        </div>
      </section>

      <section
        style={{
          ...mobileCardStyle(palette, {
            padding: 18,
            background: palette.panelElevated,
          }),
        }}
      >
        <div style={sectionTitle}>Model</div>
        <div style={{ display: 'grid', gap: 10, marginTop: 14 }}>
          {AVAILABLE_MODELS.map((model) => {
            const active = selectedModel.id === model.id;
            return (
              <button
                key={model.id}
                onClick={() => onModelChange(model.id)}
                style={{
                  width: '100%',
                  padding: '14px 16px',
                  borderRadius: 18,
                  border: `1px solid ${active ? palette.accentBorder : palette.cardBorder}`,
                  background: active ? palette.panelBackground : palette.cardBackground,
                  color: palette.rootText,
                  display: 'flex',
                  gap: 12,
                  alignItems: 'center',
                  textAlign: 'left',
                  cursor: 'pointer',
                  fontFamily: mobileFontFamily(),
                }}
              >
                <div
                  style={{
                    width: 10,
                    height: 10,
                    borderRadius: 999,
                    backgroundColor: active ? palette.accent : 'transparent',
                    border: `1px solid ${active ? palette.accent : palette.cardBorder}`,
                    flexShrink: 0,
                  }}
                />
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 15, fontWeight: 700 }}>{model.label}</div>
                  <div style={{ fontSize: 12, color: palette.subduedText, marginTop: 3 }}>
                    {model.description}
                  </div>
                </div>
                <div
                  style={{
                    fontSize: 11,
                    fontWeight: 700,
                    letterSpacing: '0.08em',
                    textTransform: 'uppercase',
                    color: palette.subduedText,
                  }}
                >
                  {model.provider}
                </div>
              </button>
            );
          })}
        </div>
      </section>

      <section
        style={{
          ...mobileCardStyle(palette, {
            padding: 18,
            background: palette.panelElevated,
          }),
        }}
      >
        <div style={sectionTitle}>Connection</div>
        <div
          style={{
            marginTop: 14,
            padding: 16,
            borderRadius: 18,
            border: `1px solid ${connectionStatus === 'connected' ? palette.successBorder : palette.dangerBorder}`,
            background: connectionStatus === 'connected' ? palette.successSoft : palette.dangerSoft,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
          }}
        >
          <div>
            <div style={{ fontSize: 15, fontWeight: 700, color: palette.rootText }}>
              WebSocket Bridge
            </div>
            <div style={{ fontSize: 12, color: palette.subduedText, marginTop: 4 }}>
              {connectionStatus === 'connected'
                ? 'Live transport is available for the mobile shell.'
                : 'The mobile shell cannot reach the local bridge right now.'}
            </div>
          </div>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, color: palette.rootText, fontSize: 13, fontWeight: 700 }}>
            <StatusDot color={connectionColor} />
            {renderConnectionLabel(connectionStatus)}
          </div>
        </div>
      </section>

      <section
        style={{
          ...mobileCardStyle(palette, {
            padding: 18,
            background: palette.panelElevated,
          }),
        }}
      >
        <div style={sectionTitle}>About</div>
        <div style={{ display: 'grid', gap: 12, marginTop: 14 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
            <span style={{ fontSize: 13, color: palette.subduedText }}>Brand</span>
            <span style={{ fontSize: 13, fontWeight: 700, color: palette.rootText }}>o8</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
            <span style={{ fontSize: 13, color: palette.subduedText }}>Version</span>
            <span style={{ fontSize: 13, fontWeight: 700, color: palette.rootText }}>
              {formatAboutVersion(appVersion)}
            </span>
          </div>
          <div style={{ fontSize: 12, color: palette.subduedText, lineHeight: 1.6 }}>
            Mobile command surface for approvals, chat, and operator controls.
          </div>
        </div>
      </section>
    </div>
  );
}
