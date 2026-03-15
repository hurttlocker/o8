/**
 * ShimmerCard — Loading skeleton for lazy-loaded panels.
 * Pulse animation, Apple-style rounded card.
 */
export function ShimmerCard() {
  return (
    <div
      style={{
        margin: '16px',
        borderRadius: '16px',
        backgroundColor: '#f3f4f6',
        height: '120px',
        animation: 'shimmer-pulse 1.5s ease-in-out infinite',
      }}
    >
      <style>{`
        @keyframes shimmer-pulse {
          0%, 100% { opacity: 0.4; }
          50% { opacity: 0.8; }
        }
      `}</style>
    </div>
  );
}
