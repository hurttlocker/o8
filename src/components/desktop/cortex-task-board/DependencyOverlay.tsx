'use client';

import { memo } from 'react';
import { X } from '../lucide-shims';
import type { DependencyOverlayProps } from './types';
import { dependencyDeleteButtonStyle } from './constants';

function DependencyOverlayBase({
  renderedDependencies,
  renderedDraftDependency,
  dependencyLayout,
  onRemoveDependency,
}: DependencyOverlayProps) {
  return (
    <svg
      aria-hidden
      style={{
        position: 'absolute',
        inset: 0,
        width: dependencyLayout.width || '100%',
        height: dependencyLayout.height || '100%',
        overflow: 'visible',
        pointerEvents: 'none',
        zIndex: 1,
      }}
    >
      {renderedDependencies.map((dependency) => (
        <g key={dependency.id}>
          <path
            d={dependency.path}
            fill="none"
            stroke="rgba(37,99,235,0.18)"
            strokeWidth="7"
            strokeLinecap="round"
          />
          <path
            d={dependency.path}
            fill="none"
            stroke="rgba(37,99,235,0.68)"
            strokeWidth="2"
            strokeLinecap="round"
            strokeDasharray="6 6"
          />
          <foreignObject
            x={dependency.midpointX - 14}
            y={dependency.midpointY - 14}
            width={28}
            height={28}
            style={{ pointerEvents: 'auto' }}
          >
            <button
              type="button"
              onClick={() => void onRemoveDependency(dependency.id)}
              style={dependencyDeleteButtonStyle}
            >
              <X size={11} />
            </button>
          </foreignObject>
        </g>
      ))}

      {renderedDraftDependency ? (
        <>
          <path
            d={renderedDraftDependency.path}
            fill="none"
            stroke="rgba(37,99,235,0.15)"
            strokeWidth="6"
            strokeLinecap="round"
          />
          <path
            d={renderedDraftDependency.path}
            fill="none"
            stroke="rgba(37,99,235,0.82)"
            strokeWidth="2"
            strokeLinecap="round"
            strokeDasharray="7 5"
          />
        </>
      ) : null}
    </svg>
  );
}

export const DependencyOverlay = memo(DependencyOverlayBase);
