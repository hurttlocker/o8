import { memo } from 'react';
import type { CSSProperties } from 'react';
import type { SurfaceStatusProps } from './types';
import { sessionStatusSummary } from './utils';
import {
  MOBILE_SYSTEM_FONT,
  neomorphicSurfaceStyle,
  orchestratorColor,
  orchestratorLabel,
  orchestratorTone,
} from './neomorph';

function noticeStyle(tone: 'red' | 'orange' | 'blue' | 'slate'): CSSProperties {
  return neomorphicSurfaceStyle(tone, {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    paddingTop: 12,
    paddingRight: 14,
    paddingBottom: 12,
    paddingLeft: 14,
    borderRadius: 18,
  });
}

export const SurfaceStatus = memo(function SurfaceStatus({
  selectedSession,
  selectedReviewPacket,
  isOwnedCodexSession,
  orchestratorStatus = 'hidden',
  orchestratorNote,
  refreshError,
  surfaceNote,
  transcriptError,
  selectedReviewPacketError,
}: SurfaceStatusProps) {
  const status = sessionStatusSummary(selectedSession, selectedReviewPacket, isOwnedCodexSession);
  const notices = [refreshError, surfaceNote, transcriptError, selectedReviewPacketError].filter(Boolean);
  const statusTone = status.tone === 'critical'
    ? 'red'
    : status.tone === 'high' || status.tone === 'watch'
      ? 'orange'
      : 'blue';

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        paddingTop: 0,
        paddingRight: 14,
        paddingBottom: 0,
        paddingLeft: 14,
      }}
    >
      {selectedSession?.activity && selectedSession.status !== 'idle' ? (
        <div
          style={neomorphicSurfaceStyle('blue', {
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            paddingTop: 12,
            paddingRight: 14,
            paddingBottom: 12,
            paddingLeft: 14,
            borderRadius: 20,
          })}
        >
          <span
            style={{
              width: 10,
              height: 10,
              borderRadius: '50%',
              backgroundColor: '#2563eb',
              boxShadow: '0 0 12px rgba(37, 99, 235, 0.28)',
              flexShrink: 0,
            }}
          />
          <div style={{ minWidth: 0, flex: 1 }}>
            <div
              style={{
                fontSize: 11,
                fontWeight: 700,
                color: '#1d4ed8',
                textTransform: 'uppercase',
                letterSpacing: '-0.02em',
              }}
            >
              Live activity
            </div>
            <div
              style={{
                marginTop: 2,
                fontSize: 14,
                fontWeight: 700,
                color: '#0f172a',
                lineHeight: 1.35,
                letterSpacing: '-0.01em',
              }}
            >
              {selectedSession.activity.headline}
            </div>
            {selectedSession.activity.filePath ? (
              <div
                style={{
                  marginTop: 4,
                  fontSize: 12,
                  fontWeight: 600,
                  color: '#64748b',
                  lineHeight: 1.35,
                  letterSpacing: '-0.01em',
                }}
              >
                {selectedSession.activity.filePath.split('/').pop()}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {orchestratorStatus !== 'hidden' ? (
        <div
          style={neomorphicSurfaceStyle(orchestratorTone(orchestratorStatus), {
            display: 'flex',
            alignItems: 'flex-start',
            gap: 12,
            paddingTop: 12,
            paddingRight: 14,
            paddingBottom: 12,
            paddingLeft: 14,
            borderRadius: 20,
          })}
        >
          <span
            style={{
              width: 10,
              height: 10,
              borderRadius: '50%',
              backgroundColor: orchestratorColor(orchestratorStatus),
              boxShadow: `0 0 12px ${orchestratorColor(orchestratorStatus)}33`,
              flexShrink: 0,
              marginTop: 4,
            }}
          />
          <div style={{ minWidth: 0, flex: 1 }}>
            <div
              style={{
                fontSize: 11,
                fontWeight: 700,
                color: orchestratorColor(orchestratorStatus),
                textTransform: 'uppercase',
                letterSpacing: '-0.02em',
              }}
            >
              {`Desktop orchestrator · ${orchestratorLabel(orchestratorStatus)}`}
            </div>
            <div
              style={{
                marginTop: 4,
                fontSize: 13,
                fontWeight: 600,
                color: '#0f172a',
                lineHeight: 1.4,
                letterSpacing: '-0.01em',
              }}
            >
              {orchestratorNote ?? 'Mobile is linked to the desktop control plane for this repo.'}
            </div>
          </div>
        </div>
      ) : null}

      {status.tone !== 'calm' ? (
        <div style={noticeStyle(statusTone)}>
          <span
            style={{
              width: 9,
              height: 9,
              borderRadius: '50%',
              backgroundColor: statusTone === 'red' ? '#ef4444' : statusTone === 'orange' ? '#f59e0b' : '#2563eb',
              flexShrink: 0,
              boxShadow: statusTone === 'red'
                ? '0 0 10px rgba(239, 68, 68, 0.26)'
                : statusTone === 'orange'
                  ? '0 0 10px rgba(245, 158, 11, 0.26)'
                  : '0 0 10px rgba(37, 99, 235, 0.22)',
            }}
          />
          <div style={{ minWidth: 0, flex: 1 }}>
            <div
              style={{
                fontSize: 11,
                fontWeight: 700,
                color: statusTone === 'red' ? '#b91c1c' : statusTone === 'orange' ? '#c2410c' : '#1d4ed8',
                textTransform: 'uppercase',
                letterSpacing: '-0.02em',
              }}
            >
              Session status
            </div>
            <div
              style={{
                marginTop: 4,
                fontSize: 13,
                fontWeight: 700,
                color: '#0f172a',
                lineHeight: 1.35,
                letterSpacing: '-0.01em',
              }}
            >
              {status.headline}
            </div>
            <div
              style={{
                marginTop: 2,
                fontSize: 12,
                fontWeight: 600,
                color: '#64748b',
                lineHeight: 1.35,
                letterSpacing: '-0.01em',
              }}
            >
              {status.meta}
            </div>
          </div>
        </div>
      ) : null}

      {notices.map((notice, index) => (
        <div
          key={`${index}:${notice}`}
          style={noticeStyle(index === 0 && refreshError ? 'red' : 'slate')}
        >
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              backgroundColor: index === 0 && refreshError ? '#ef4444' : '#64748b',
              flexShrink: 0,
            }}
          />
          <span
            style={{
              fontSize: 12,
              fontWeight: 600,
              color: '#334155',
              lineHeight: 1.45,
              letterSpacing: '-0.01em',
              fontFamily: MOBILE_SYSTEM_FONT,
            }}
          >
            {notice}
          </span>
        </div>
      ))}
    </div>
  );
});
