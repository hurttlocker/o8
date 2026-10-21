'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useO8Auth } from '@/components/auth/O8AuthProvider';
import { planConnectionRequest } from '@/lib/chatgpt-plan/client';
import { openExternalUrl } from '@/lib/desktop/open-external';
import { PLAN_USAGE_URL, type PlanStatus } from '@/lib/chatgpt-plan/types';
import { SettingsGroup, SettingsRow } from './grouped';

const buttonStyle = { border: '1px solid var(--t-panel-border)', borderRadius: 8, background: 'var(--t-bg-card)', color: 'var(--t-text)', fontSize: 12, paddingTop: 7, paddingBottom: 7, paddingLeft: 10, paddingRight: 10, cursor: 'pointer' };
interface ConnectionView {
  generation: number;
  status: PlanStatus | null;
  busy: string | null;
  notice: string | null;
  confirmDisconnect: boolean;
}
const emptyView = (generation: number): ConnectionView => ({ generation, status: null, busy: null, notice: null, confirmDisconnect: false });

export function ChatGPTPlanConnection() {
  const auth = useO8Auth();
  const owner = auth.isLoaded && auth.signedIn ? auth.user?.id ?? null : null;
  const identity = useRef({ owner, generation: 0 });
  if (identity.current.owner !== owner) {
    identity.current = { owner, generation: identity.current.generation + 1 };
  }
  const renderEpoch = identity.current.generation;
  const [storedView, setView] = useState(() => emptyView(renderEpoch));
  const { status, busy, notice, confirmDisconnect } = storedView.generation === renderEpoch ? storedView : emptyView(renderEpoch);
  const timeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const busyEpoch = useRef<number | null>(null);
  const current = useCallback((epoch: number) => epoch === identity.current.generation && Boolean(identity.current.owner), []);
  const writeView = useCallback((patch: Partial<ConnectionView>, epoch: number) => {
    if (epoch !== identity.current.generation) return;
    setView((previous) => epoch === identity.current.generation
      ? { ...(previous.generation === epoch ? previous : emptyView(epoch)), ...patch, generation: epoch }
      : previous);
  }, []);

  const load = useCallback(async (epoch: number) => {
    if (!current(epoch)) return;
    const data = await planConnectionRequest();
    if (current(epoch)) writeView({ status: data as unknown as PlanStatus, notice: typeof data.modelLoadError === 'string' ? data.modelLoadError : null }, epoch);
  }, [current, writeView]);

  useEffect(() => {
    const epoch = identity.current.generation;
    writeView(emptyView(epoch), epoch); busyEpoch.current = null;
    if (owner) void load(epoch).catch((error: Error) => { if (current(epoch)) writeView({ notice: error.message }, epoch); });
    return () => {
      if (epoch === identity.current.generation) identity.current.generation += 1;
      if (timeout.current) clearTimeout(timeout.current);
    };
  }, [owner, load, current, writeView]);

  const update = useCallback(async (epoch: number, action: string, extra: Record<string, string> = {}) => {
    if (!current(epoch) || busyEpoch.current === epoch) return;
    busyEpoch.current = epoch;
    writeView({ busy: action === 'start' ? 'Opening ChatGPT…' : 'Updating connection…', notice: null }, epoch);
    const post = (value: Record<string, unknown>) => planConnectionRequest('', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
    try {
      const data = await post({ action, ...extra });
      if (!current(epoch)) return;
      if (action === 'start') {
        if (typeof data.authorizationUrl !== 'string' || typeof data.attemptId !== 'string') throw new Error('ChatGPT sign-in could not start.');
        const authorization = new URL(data.authorizationUrl);
        if (authorization.origin !== 'https://auth.openai.com' || authorization.pathname !== '/api/accounts/authorize') throw new Error('ChatGPT returned an unexpected sign-in destination.');
        openExternalUrl(data.authorizationUrl); writeView({ busy: 'Waiting for ChatGPT sign-in…' }, epoch);
        const until = Date.now() + 5 * 60_000;
        const poll = async () => {
          if (!current(epoch)) return;
          try {
            const progress = await planConnectionRequest(`?attemptId=${encodeURIComponent(data.attemptId as string)}`);
            if (!current(epoch)) return;
            if (progress.state === 'ready') {
              await post({ action: 'finish', attemptId: data.attemptId });
              if (!current(epoch)) return;
              await load(epoch);
              if (!current(epoch)) return;
              window.dispatchEvent(new Event('o8:chatgpt-plan-changed'));
              writeView({ busy: null }, epoch); busyEpoch.current = null; return;
            }
            if (Date.now() >= until) throw new Error('ChatGPT sign-in expired. Try again.');
            timeout.current = setTimeout(() => void poll(), 1_500);
          } catch (error) {
            if (!current(epoch)) return;
            await load(epoch).catch(() => {});
            if (!current(epoch)) return;
            writeView({ notice: error instanceof Error ? error.message : 'Sign-in stopped.', busy: null }, epoch);
            busyEpoch.current = null;
          }
        };
        timeout.current = setTimeout(() => void poll(), 1_000);
        return;
      }
      await load(epoch);
      if (current(epoch)) window.dispatchEvent(new Event('o8:chatgpt-plan-changed'));
    } catch (error) { if (current(epoch)) writeView({ notice: error instanceof Error ? error.message : 'The connection could not be updated.' }, epoch); }
    if (current(epoch)) { writeView({ busy: null }, epoch); busyEpoch.current = null; }
  }, [load, current, writeView]);

  const disconnect = async (epoch: number) => {
    if (!current(epoch) || busyEpoch.current === epoch) return;
    busyEpoch.current = epoch;
    writeView({ busy: 'Disconnecting…', notice: null, confirmDisconnect: false }, epoch);
    try {
      const data = await planConnectionRequest('', { method: 'DELETE' });
      if (!current(epoch)) return;
      await load(epoch);
      if (!current(epoch)) return;
      window.dispatchEvent(new Event('o8:chatgpt-plan-changed'));
      if (data.revocationConfirmed !== true) writeView({ notice: 'Disconnected locally. Open ChatGPT settings to confirm removal there.' }, epoch);
    } catch (error) { if (current(epoch)) writeView({ notice: error instanceof Error ? error.message : 'Disconnect failed.' }, epoch); }
    if (current(epoch)) { writeView({ busy: null }, epoch); busyEpoch.current = null; }
  };

  return <div style={{ marginTop: 20, marginBottom: 20 }}>
    <SettingsGroup header="ChatGPT plan" footnote="Use your ChatGPT plan for o8 text requests without an API key or CLI. Plan limits still apply. This does not open your ChatGPT chats or memories, and o8 pricing is separate.">
      <SettingsRow label={status?.planEnabled ? 'Using ChatGPT plan' : 'Connect ChatGPT'} subtitle={busy ?? (status?.planEnabled ? 'Choose an available model in the chat composer.' : 'Connection failures stop this route.')} accessory={<>
        {!owner ? <button type="button" style={buttonStyle} onClick={auth.signIn}>Sign in to o8</button> : <button type="button" disabled={Boolean(busy)} style={buttonStyle} onClick={() => { const accountId = status?.activeId ?? status?.accounts.at(-1)?.id; void update(renderEpoch, 'start', accountId ? { accountId } : {}); }}>Continue with ChatGPT</button>}
      </>} />
      {status?.accounts.length ? <SettingsRow label="ChatGPT account" accessory={<><select aria-label="Active ChatGPT account" disabled={Boolean(busy)} value={status.activeId ?? ''} onChange={(event) => void update(renderEpoch, status.accounts.find((account) => account.id === event.target.value)?.connected ? 'select' : 'start', { accountId: event.target.value })} style={buttonStyle}>
        <option value="" disabled>Select an account</option>{status.accounts.map((account) => <option key={account.id} value={account.id}>{account.label}{account.connected ? '' : ' · reconnect'}</option>)}
      </select><button type="button" disabled={Boolean(busy)} style={buttonStyle} onClick={() => void update(renderEpoch, 'start')}>Add account</button></>} /> : null}
      {status?.connected ? <SettingsRow label="Plan access" accessory={<><button type="button" style={buttonStyle} onClick={() => openExternalUrl(PLAN_USAGE_URL)}>Manage usage</button><button type="button" disabled={Boolean(busy)} style={buttonStyle} onClick={() => writeView({ confirmDisconnect: true }, renderEpoch)}>Disconnect</button></>} /> : null}
      {confirmDisconnect ? <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingTop: 12, paddingBottom: 12, paddingLeft: 14, paddingRight: 14, color: 'var(--t-danger-text, #b91c1c)' }}>Stop this ChatGPT connection?<button type="button" style={{ ...buttonStyle, color: 'var(--t-danger-text, #b91c1c)' }} onClick={() => void disconnect(renderEpoch)}>Disconnect</button><button type="button" style={buttonStyle} onClick={() => writeView({ confirmDisconnect: false }, renderEpoch)}>Cancel</button></div> : null}
      {status?.planEnabled && !status.welcomed ? <div style={{ paddingTop: 12, paddingBottom: 12, paddingLeft: 14, paddingRight: 14, fontSize: 12, color: 'var(--t-text)' }}>You’re using your ChatGPT plan. Requests count toward its applicable limits.<button type="button" disabled={Boolean(busy)} style={{ ...buttonStyle, marginLeft: 8 }} onClick={() => void update(renderEpoch, 'welcome')}>Got it</button></div> : null}
    </SettingsGroup>
    {notice ? <p role="status" style={{ fontSize: 12, color: 'var(--t-text-secondary)', marginTop: 8, marginBottom: 0 }}>{notice}</p> : null}
  </div>;
}
