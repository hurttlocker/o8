'use client';

import { useEffect, useState } from 'react';
import Image from 'next/image';
import { IPHONE_APP_INSTALL_URL } from '../canvas/mobile-app-link';
import { onboardingActionRowStyle, onboardingButtonStyle, onboardingCardStyle, onboardingQuietButtonStyle } from './onboarding-style';

export function OnboardingMobileStep({ openExternal, onContinue }: { openExternal: (url: string) => void; onContinue: () => void }) {
  const [qr, setQr] = useState('');
  const [copied, setCopied] = useState(false);
  const [copying, setCopying] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    // This QR contains only the public install link, never pairing credentials.
    void import('qrcode').then(({ toDataURL }) => toDataURL(IPHONE_APP_INSTALL_URL, { width: 216, margin: 3, errorCorrectionLevel: 'M' }))
      .then((url) => { if (active) setQr(url); }).catch(() => { if (active) setError('QR code could not load. Open or copy the beta link below.'); });
    return () => { active = false; };
  }, []);
  const copy = async () => {
    setCopying(true);
    try { await navigator.clipboard.writeText(IPHONE_APP_INSTALL_URL); setCopied(true); setError(''); }
    catch { setCopied(false); setError('Could not copy the link. Open the beta page or copy its address below.'); }
    finally { setCopying(false); }
  };
  return <section style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
    <div><h1 style={{ margin: 0, fontSize: 28, fontWeight: 300 }}>Take o8 with you.</h1>
      <p style={{ marginTop: 12, marginBottom: 0, fontSize: 13, lineHeight: 1.6, color: 'var(--t-text-secondary)' }}>Try the iPhone companion through TestFlight. Follow your work, review approvals, and talk with Symon from your phone.</p></div>
    <div style={{ ...onboardingCardStyle, display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 24 }}>
      <div style={{ flexShrink: 0, width: 184, height: 184, borderRadius: 12, background: '#fff', display: 'grid', placeItems: 'center' }}>
        {qr ? <Image unoptimized src={qr} alt="Scan to open the o8 TestFlight beta" width={184} height={184} /> : <span role="status" style={{ fontSize: 12, color: '#333' }}>{error ? 'Use the link below' : 'Preparing QR code…'}</span>}
      </div>
      <div style={{ flex: '1 1 260px', minWidth: 0 }}>
        <div style={{ fontSize: 13.5, fontWeight: 300 }}>Scan with your iPhone camera</div>
        <ol style={{ marginTop: 12, marginBottom: 0, paddingLeft: 18, fontSize: 12, lineHeight: 1.7, color: 'var(--t-text-secondary)' }}>
          <li>Install TestFlight from the App Store.</li><li>Join the o8 beta and install the app.</li><li>Try Explore a demo, or pair with your desktop.</li>
        </ol>
      </div>
    </div>
    <div style={{ ...onboardingCardStyle, background: 'transparent' }}>
      <div style={{ fontSize: 13.5, fontWeight: 300 }}>Pair when you’re ready</div>
      <p style={{ marginTop: 8, marginBottom: 0, fontSize: 12, lineHeight: 1.6, color: 'var(--t-text-secondary)' }}>Open Pair mobile device from the phone button at the bottom of the desktop sidebar, then scan its pairing code in the iPhone app. Keep both devices connected to a network they can reach.</p>
      <p style={{ marginTop: 8, marginBottom: 0, fontSize: 11, lineHeight: 1.5, color: 'var(--t-text-muted)' }}>This install code opens TestFlight. It does not pair a device or grant access to your workspace.</p>
    </div>
    <div style={{ fontSize: 11, lineHeight: 1.5, color: 'var(--t-text-muted)', overflowWrap: 'anywhere' }}>{IPHONE_APP_INSTALL_URL}</div>
    {error || copied ? <p role="status" style={{ margin: 0, fontSize: 12, color: 'var(--t-text-secondary)' }}>{error || 'Beta link copied.'}</p> : null}
    <div style={onboardingActionRowStyle}>
      <button type="button" onClick={onContinue} style={onboardingQuietButtonStyle}>Back to projects</button>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        <button type="button" disabled={copying} onClick={() => void copy()} style={{ ...onboardingButtonStyle, opacity: copying ? 0.5 : 1 }}>{copying ? 'Copying…' : copied ? 'Copied' : 'Copy beta link'}</button>
        <a href={IPHONE_APP_INSTALL_URL} rel="noreferrer" onClick={(event) => { event.preventDefault(); openExternal(IPHONE_APP_INSTALL_URL); }} style={{ ...onboardingButtonStyle, background: 'var(--t-text)', color: 'var(--t-onboarding-bg)', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 8 }}>Open TestFlight<svg aria-hidden="true" width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round"><path d="M14 3h7v7m0-7L10 14M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5" /></svg></a>
      </div>
    </div>
  </section>;
}
