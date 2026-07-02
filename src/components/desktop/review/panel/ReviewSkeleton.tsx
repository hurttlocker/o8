import { UI_FONT } from './constants';

/**
 * ReviewSkeleton — instant first paint for the Workspace changes view while
 * the working-tree snapshot loads (#1340). A faint one-line "Loading…" read
 * as a blank crash on slow/large repos; this paints panel chrome + shimmer
 * rows the moment the tab mounts so the surface is never empty.
 *
 * Inline styles + var(--t-*) tokens only; scoped keyframe follows the
 * WorkspaceBootLoader idiom.
 */

const ROW_COUNT = 6;
const SHIMMER = 'o8ReviewSkeletonPulse';

function Bar({ width, height = 10 }: { width: number | string; height?: number }) {
  return (
    <span
      style={{
        display: 'inline-block',
        width,
        height,
        borderRadius: 4,
        background: 'var(--t-divider-subtle)',
        animation: `${SHIMMER} 1.4s ease-in-out infinite`,
      }}
    />
  );
}

export function ReviewSkeleton() {
  return (
    <div
      aria-hidden
      style={{ display: 'flex', flexDirection: 'column', width: '100%', fontFamily: UI_FONT }}
    >
      <style>{`@keyframes ${SHIMMER} { 0%, 100% { opacity: 0.35; } 50% { opacity: 0.7; } }`}</style>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          minHeight: 40,
          paddingTop: 6,
          paddingBottom: 6,
          paddingLeft: 14,
          paddingRight: 10,
          borderBottom: '1px solid var(--t-divider-subtle)',
          flexShrink: 0,
        }}
      >
        <Bar width={120} height={12} />
        <span style={{ flex: 1 }} />
        <Bar width={46} height={12} />
      </div>
      {Array.from({ length: ROW_COUNT }).map((_value, index) => (
        <div
          key={index}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            paddingTop: 8,
            paddingBottom: 8,
            paddingLeft: 12,
            paddingRight: 14,
            borderBottom: '1px solid var(--t-divider-subtle)',
            opacity: 1 - index * 0.12,
          }}
        >
          <Bar width={12} height={12} />
          <Bar width={`${40 + ((index * 13) % 45)}%`} />
          <span style={{ flex: 1 }} />
          <Bar width={30} height={10} />
        </div>
      ))}
    </div>
  );
}
