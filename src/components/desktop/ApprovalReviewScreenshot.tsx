'use client';

import { useEffect, useState } from 'react';
import type { ApprovalRecord } from '@/lib/approvals/types';
import type { LaneEvent } from '@/lib/lane/types';
import { findLatestLaneReviewScreenshot, laneReviewScreenshotSrc } from '@/lib/lane/review-screenshot';

const MAX_LOOKUP_ATTEMPTS = 8;
const LOOKUP_RETRY_MS = 1_500;

function normalizedMetadataValue(value: string | undefined) {
  const normalized = value?.trim();
  return normalized || null;
}

export function ApprovalReviewScreenshot({ approval }: { approval: ApprovalRecord }) {
  const laneId = normalizedMetadataValue(approval.metadata?.Lane);
  const directPath = normalizedMetadataValue(approval.metadata?.ReviewScreenshotPath);
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    setExpanded(false);
  }, [approval.id]);

  useEffect(() => {
    let cancelled = false;

    if (directPath) {
      setImageSrc(`/api/panel/serve-image?path=${encodeURIComponent(directPath)}`);
      return () => {
        cancelled = true;
      };
    }

    if (!laneId) {
      setImageSrc(null);
      return () => {
        cancelled = true;
      };
    }

    setImageSrc(null);

    void (async () => {
      for (let attempt = 0; attempt < MAX_LOOKUP_ATTEMPTS && !cancelled; attempt += 1) {
        try {
          const response = await fetch(`/api/lanes/${encodeURIComponent(laneId)}?events=20`, {
            cache: 'no-store',
          });

          if (response.ok) {
            const data = await response.json() as { events?: LaneEvent[] };
            const screenshot = findLatestLaneReviewScreenshot(data.events ?? [], {
              beforeTimestamp: approval.createdAt,
            });
            const nextSrc = screenshot ? laneReviewScreenshotSrc(screenshot) : null;
            if (nextSrc) {
              if (!cancelled) {
                setImageSrc(nextSrc);
              }
              return;
            }
          }
        } catch {
          // Best effort — the lane transition should never depend on the thumbnail lookup.
        }

        if (attempt < MAX_LOOKUP_ATTEMPTS - 1) {
          await new Promise((resolve) => window.setTimeout(resolve, LOOKUP_RETRY_MS));
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [approval.createdAt, directPath, laneId]);

  if (!imageSrc) {
    return null;
  }

  return (
    <>
      <div style={{ marginTop: 10 }}>
        <button
          type="button"
          onClick={() => setExpanded(true)}
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            width: '100%',
            padding: 10,
            borderWidth: 1,
            borderStyle: 'solid',
            borderColor: 'rgba(37, 99, 235, 0.14)',
            borderRadius: 16,
            background: 'linear-gradient(180deg, rgba(255, 255, 255, 0.96) 0%, rgba(239, 246, 255, 0.94) 100%)',
            boxShadow: '0 12px 30px rgba(37, 99, 235, 0.08)',
            cursor: 'pointer',
            textAlign: 'left',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 10,
            }}
          >
            <div style={{ minWidth: 0 }}>
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  color: '#1d4ed8',
                  letterSpacing: '0.04em',
                  textTransform: 'uppercase',
                }}
              >
                Review Snapshot
              </div>
              <div
                style={{
                  marginTop: 2,
                  fontSize: 11,
                  lineHeight: 1.45,
                  color: 'rgba(15, 23, 42, 0.72)',
                }}
              >
                Captured automatically when this lane crossed into review.
              </div>
            </div>
            <div
              style={{
                flexShrink: 0,
                fontSize: 10,
                fontWeight: 700,
                color: 'rgba(29, 78, 216, 0.82)',
                letterSpacing: '0.02em',
              }}
            >
              Click to expand
            </div>
          </div>

          <img
            src={imageSrc}
            alt={`Review snapshot for ${approval.title}`}
            onError={() => setImageSrc(null)}
            style={{
              display: 'block',
              width: '100%',
              maxHeight: 168,
              objectFit: 'cover',
              borderRadius: 12,
              borderWidth: 1,
              borderStyle: 'solid',
              borderColor: 'rgba(148, 163, 184, 0.26)',
              background: 'rgba(226, 232, 240, 0.55)',
            }}
          />
        </button>
      </div>

      {expanded ? (
        <div
          role="presentation"
          onClick={() => setExpanded(false)}
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 1400,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 28,
            background: 'rgba(15, 23, 42, 0.72)',
            backdropFilter: 'blur(10px)',
          }}
        >
          <div
            role="presentation"
            onClick={(event) => event.stopPropagation()}
            style={{
              width: 'min(1120px, 100%)',
              maxHeight: '100%',
              padding: 16,
              borderRadius: 22,
              background: 'rgba(255, 255, 255, 0.98)',
              borderWidth: 1,
              borderStyle: 'solid',
              borderColor: 'rgba(148, 163, 184, 0.24)',
              boxShadow: '0 30px 80px rgba(15, 23, 42, 0.28)',
              overflow: 'auto',
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 12,
                marginBottom: 14,
              }}
            >
              <div>
                <div
                  style={{
                    fontSize: 12,
                    fontWeight: 700,
                    color: '#1d4ed8',
                    letterSpacing: '0.04em',
                    textTransform: 'uppercase',
                  }}
                >
                  Review Snapshot
                </div>
                <div
                  style={{
                    marginTop: 3,
                    fontSize: 13,
                    fontWeight: 600,
                    color: 'rgba(15, 23, 42, 0.9)',
                    letterSpacing: '-0.01em',
                  }}
                >
                  {approval.title}
                </div>
              </div>

              <button
                type="button"
                onClick={() => setExpanded(false)}
                style={{
                  minWidth: 86,
                  height: 38,
                  padding: '0 14px',
                  borderWidth: 1,
                  borderStyle: 'solid',
                  borderColor: 'rgba(148, 163, 184, 0.28)',
                  borderRadius: 999,
                  background: 'rgba(248, 250, 252, 0.95)',
                  color: 'rgba(15, 23, 42, 0.82)',
                  fontSize: 12,
                  fontWeight: 700,
                  cursor: 'pointer',
                }}
              >
                Close
              </button>
            </div>

            <img
              src={imageSrc}
              alt={`Expanded review snapshot for ${approval.title}`}
              onError={() => setExpanded(false)}
              style={{
                display: 'block',
                width: '100%',
                height: 'auto',
                borderRadius: 18,
                borderWidth: 1,
                borderStyle: 'solid',
                borderColor: 'rgba(148, 163, 184, 0.24)',
                background: 'rgba(241, 245, 249, 0.82)',
              }}
            />
          </div>
        </div>
      ) : null}
    </>
  );
}
