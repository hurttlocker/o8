function baseIconStyle() {
  return { display: 'block', flexShrink: 0 } as const;
}

export function PhosphorPlay({ size = 14 }: { size?: number }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} fill="currentColor" viewBox="0 0 256 256" style={baseIconStyle()}>
      <path d="M240,128a15.74,15.74,0,0,1-7.6,13.51L88.32,229.65a16,16,0,0,1-16.2.3A15.86,15.86,0,0,1,64,216.13V39.87a15.86,15.86,0,0,1,8.12-13.82,16,16,0,0,1,16.2.3L232.4,114.49A15.74,15.74,0,0,1,240,128Z" />
    </svg>
  );
}

export function PhosphorSplitVertical({ size = 14 }: { size?: number }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} fill="currentColor" viewBox="0 0 256 256" style={baseIconStyle()}>
      <path d="M208,144H48a8,8,0,0,0,0,16h72v32H96a8,8,0,0,0-5.66,13.66l32,32a8,8,0,0,0,11.32,0l32-32A8,8,0,0,0,160,192H136V160h72a8,8,0,0,0,0-16Zm-80,76.69L115.31,208h25.38ZM48,112H208a8,8,0,0,0,0-16H136V64h24a8,8,0,0,0,5.66-13.66l-32-32a8,8,0,0,0-11.32,0l-32,32A8,8,0,0,0,96,64h24V96H48a8,8,0,0,0,0,16Zm80-76.69L140.69,48H115.31Z" />
    </svg>
  );
}

export function PhosphorSplitHorizontal({ size = 14 }: { size?: number }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} fill="currentColor" viewBox="0 0 256 256" style={baseIconStyle()}>
      <path d="M104,40a8,8,0,0,0-8,8v72H64V96a8,8,0,0,0-13.66-5.66l-32,32a8,8,0,0,0,0,11.32l32,32A8,8,0,0,0,64,160V136H96v72a8,8,0,0,0,16,0V48A8,8,0,0,0,104,40ZM48,140.69,35.31,128,48,115.31Zm189.66-18.35-32-32A8,8,0,0,0,192,96v24H160V48a8,8,0,0,0-16,0V208a8,8,0,0,0,16,0V136h32v24a8,8,0,0,0,13.66,5.66l32-32A8,8,0,0,0,237.66,122.34ZM208,140.69V115.31L220.69,128Z" />
    </svg>
  );
}

export function PhosphorXCircle({ size = 14 }: { size?: number }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} fill="currentColor" viewBox="0 0 256 256" style={baseIconStyle()}>
      <path d="M165.66,101.66,139.31,128l26.35,26.34a8,8,0,0,1-11.32,11.32L128,139.31l-26.34,26.35a8,8,0,0,1-11.32-11.32L116.69,128,90.34,101.66a8,8,0,0,1,11.32-11.32L128,116.69l26.34-26.35a8,8,0,0,1,11.32,11.32ZM232,128A104,104,0,1,1,128,24,104.11,104.11,0,0,1,232,128Zm-16,0a88,88,0,1,0-88,88A88.1,88.1,0,0,0,216,128Z" />
    </svg>
  );
}

export function PhosphorCaretLeft({ size = 12 }: { size?: number }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} fill="currentColor" viewBox="0 0 256 256" style={baseIconStyle()}>
      <path d="M165.66,202.34a8,8,0,0,1-11.32,11.32l-80-80a8,8,0,0,1,0-11.32l80-80a8,8,0,0,1,11.32,11.32L91.31,128Z" />
    </svg>
  );
}

export function PhosphorCaretRight({ size = 12 }: { size?: number }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} fill="currentColor" viewBox="0 0 256 256" style={baseIconStyle()}>
      <path d="M181.66,133.66l-80,80a8,8,0,0,1-11.32-11.32L164.69,128,90.34,53.66a8,8,0,0,1,11.32-11.32l80,80A8,8,0,0,1,181.66,133.66Z" />
    </svg>
  );
}

export function PhosphorXBold({ size = 10 }: { size?: number }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} fill="currentColor" viewBox="0 0 256 256" style={baseIconStyle()}>
      <path d="M208.49,191.51a12,12,0,0,1-17,17L128,145,64.49,208.49a12,12,0,0,1-17-17L111,128,47.51,64.49a12,12,0,0,1,17-17L128,111l63.51-63.52a12,12,0,0,1,17,17L145,128Z" />
    </svg>
  );
}

export function AgentDot({ color, size = 8 }: { color: string; size?: number }) {
  return (
    <span
      style={{
        display: 'inline-block',
        width: size,
        height: size,
        borderRadius: '50%',
        background: color,
        flexShrink: 0,
      }}
    />
  );
}

export function CortexMarkIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" style={baseIconStyle()}>
      <path d="M17.7 6.6a7.1 7.1 0 1 0 0 10.8" stroke="#ec4899" strokeWidth="3" strokeLinecap="round" />
      <circle cx="16.8" cy="6.1" r="1.55" fill="#ec4899" />
      <circle cx="18.2" cy="12" r="1.35" fill="#ec4899" />
      <circle cx="16.8" cy="17.9" r="1.55" fill="#ec4899" />
      <circle cx="8.3" cy="6.9" r="1.15" fill="#f472b6" opacity="0.95" />
      <circle cx="6.6" cy="12" r="1.05" fill="#f472b6" opacity="0.85" />
      <circle cx="8.3" cy="17.1" r="1.15" fill="#f472b6" opacity="0.95" />
    </svg>
  );
}

export function ClaudeTabIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" style={baseIconStyle()}>
      <rect x="2.5" y="2.5" width="19" height="19" rx="5.25" fill="#e97a4d" stroke="rgba(255,255,255,0.22)" strokeWidth="1" />
      <path
        d="M12 5.8v12.4M6.75 7.8l10.5 8.4M17.25 7.8 6.75 16.2M8.5 5.95 15.5 18.05M15.5 5.95 8.5 18.05"
        stroke="#fff"
        strokeWidth="1.95"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="12" r="1.6" fill="#fff" />
    </svg>
  );
}

export function CodexTabIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" style={baseIconStyle()}>
      <path d="M12 4.9 16.9 7.7 16.9 13.25 12 16.05 7.1 13.25 7.1 7.7 12 4.9Z" stroke="#b7c3d4" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12 8.1 14.95 9.8 14.95 13.2 12 14.9 9.05 13.2 9.05 9.8 12 8.1Z" fill="#d8e1ec" opacity="0.96" />
      <path d="M7.1 7.7 12 10.45 16.9 7.7" stroke="#b7c3d4" strokeWidth="1.55" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12 10.45V16.05" stroke="#8ea3bd" strokeWidth="1.55" strokeLinecap="round" />
    </svg>
  );
}

export function SplitVerticalIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={baseIconStyle()}>
      <path d="M12 4v16" />
      <path d="M6 7v10" />
      <path d="M18 7v10" />
    </svg>
  );
}

export function SplitHorizontalIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={baseIconStyle()}>
      <path d="M4 12h16" />
      <path d="M7 6h10" />
      <path d="M7 18h10" />
    </svg>
  );
}
