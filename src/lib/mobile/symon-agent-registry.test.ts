/**
 * activeAgentSession registry (docs/symon-agent-mode.md §"Session registry" +
 * §"Mutual exclusion"). Covers last-start-wins, terminal-status clearing, the
 * 10-min stale sweep, and the cross-process disk mirror the Next GET reads.
 */
import { mkdtempSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'o8-symon-reg-'));
process.env.CORTEX_IDE_DATA_DIR = dataDir;

const {
  startAgentSession,
  updateAgentStatus,
  touchAgentSession,
  stopAgentSession,
  sweepStaleAgentSession,
  getAgentSession,
  isAgentSessionStale,
  persistAgentSession,
  loadPersistedAgentSession,
  persistSymonScopeGrant,
  loadSymonScopeGrant,
  clearSymonScopeGrant,
  scopeGrantMatchesClient,
  scopeSymonToolArgs,
  SYMON_SCOPE_VERSION,
  AGENT_SESSION_STALE_MS,
} = await import('./symon-agent-registry');

beforeEach(() => {
  stopAgentSession(); // reset the globalThis singleton between cases
});

describe('symon-agent-registry — last-start-wins', () => {
  it('first start has no preemption and sets connecting', () => {
    const { record, preempted } = startAgentSession('sym-a', 1_000);
    expect(preempted).toBeNull();
    expect(record).toMatchObject({ sessionId: 'sym-a', startedAt: 1_000, lastStatus: 'connecting', source: 'phone' });
    expect(getAgentSession()?.sessionId).toBe('sym-a');
  });

  it('a second, DIFFERENT start preempts the first and returns its id', () => {
    startAgentSession('sym-a', 1_000);
    const { preempted } = startAgentSession('sym-b', 2_000);
    expect(preempted).toBe('sym-a');
    expect(getAgentSession()?.sessionId).toBe('sym-b');
  });

  it('re-registering the SAME id is idempotent and keeps startedAt', () => {
    startAgentSession('sym-a', 1_000);
    const { preempted, record } = startAgentSession('sym-a', 5_000);
    expect(preempted).toBeNull();
    expect(record.startedAt).toBe(1_000); // original start preserved
  });
});

describe('symon-agent-registry — status transitions', () => {
  it('updates lastStatus + activity for the active session', () => {
    startAgentSession('sym-a', 1_000);
    const updated = updateAgentStatus('sym-a', 'live', 3_000);
    expect(updated).toMatchObject({ lastStatus: 'live', lastActivityAt: 3_000 });
  });

  it('a terminal status (idle/error) clears the registry', () => {
    startAgentSession('sym-a', 1_000);
    expect(updateAgentStatus('sym-a', 'idle', 2_000)).toBeNull();
    expect(getAgentSession()).toBeNull();
  });

  it('ignores a status for a non-active session id (preempted late chatter)', () => {
    startAgentSession('sym-b', 1_000);
    expect(updateAgentStatus('sym-a', 'live', 2_000)).toBeNull();
    expect(getAgentSession()?.sessionId).toBe('sym-b'); // untouched
  });

  it('touchAgentSession bumps activity only for the active id', () => {
    startAgentSession('sym-a', 1_000);
    touchAgentSession('sym-a', 9_000);
    expect(getAgentSession()?.lastActivityAt).toBe(9_000);
    expect(touchAgentSession('sym-x', 10_000)).toBeNull();
  });
});

describe('symon-agent-registry — stop + stale sweep', () => {
  it('stopAgentSession only clears a matching id (else no-op)', () => {
    startAgentSession('sym-a', 1_000);
    expect(stopAgentSession('sym-x')).toBeNull();
    expect(getAgentSession()?.sessionId).toBe('sym-a');
    expect(stopAgentSession('sym-a')?.sessionId).toBe('sym-a');
    expect(getAgentSession()).toBeNull();
  });

  it('sweeps a session gone quiet past the 10-min TTL', () => {
    startAgentSession('sym-a', 0);
    updateAgentStatus('sym-a', 'live', 0);
    // Not yet stale.
    expect(sweepStaleAgentSession(AGENT_SESSION_STALE_MS - 1)).toBeNull();
    expect(getAgentSession()?.sessionId).toBe('sym-a');
    // Past the TTL → dropped.
    const dropped = sweepStaleAgentSession(AGENT_SESSION_STALE_MS + 1);
    expect(dropped?.sessionId).toBe('sym-a');
    expect(getAgentSession()).toBeNull();
  });

  it('isAgentSessionStale respects the TTL boundary', () => {
    const rec = startAgentSession('sym-a', 0).record;
    expect(isAgentSessionStale(rec, AGENT_SESSION_STALE_MS)).toBe(false);
    expect(isAgentSessionStale(rec, AGENT_SESSION_STALE_MS + 1)).toBe(true);
  });
});

describe('symon-agent-registry — disk mirror (cross-process)', () => {
  it('persists + loads the current record, and applies the staleness guard on load', () => {
    startAgentSession('sym-a', 1_000);
    const live = updateAgentStatus('sym-a', 'live', 1_000)!;
    persistAgentSession(live);

    const loaded = loadPersistedAgentSession(2_000);
    expect(loaded).toMatchObject({ sessionId: 'sym-a', lastStatus: 'live', startedAt: 1_000 });

    // A crashed writer can't leave a phantom banner: a stale mirror loads as null.
    expect(loadPersistedAgentSession(1_000 + AGENT_SESSION_STALE_MS + 1)).toBeNull();
  });

  it('persisting null clears the mirror', () => {
    startAgentSession('sym-a', 1_000);
    persistAgentSession(getAgentSession());
    persistAgentSession(null);
    expect(loadPersistedAgentSession(1_500)).toBeNull();
  });
});

describe('symon-agent-registry — immutable scope grant', () => {
  const deviceGrant = {
    sessionId: 'sym-device',
    subject: 'device' as const,
    deviceId: 'device-7',
    workspaceMode: 'code' as const,
    repoId: 'repo-o8-mobile',
    repoPath: '/Users/operator/o8-mobile',
    allowedTools: ['o8_status', 'o8_dispatch', 'o8_delegate', 'o8_review_diff', 'git_status'],
    issuedAt: 10_000,
    scopeVersion: SYMON_SCOPE_VERSION,
  };

  it('atomically persists a mode-0600 grant and loads the exact value', () => {
    persistSymonScopeGrant(deviceGrant);

    expect(loadSymonScopeGrant()).toEqual(deviceGrant);
    expect(statSync(path.join(dataDir, 'symon-scope-grant.json')).mode & 0o777).toBe(0o600);
  });

  it('fails closed for malformed or unsupported grant files', () => {
    writeFileSync(path.join(dataDir, 'symon-scope-grant.json'), JSON.stringify({
      ...deviceGrant,
      scopeVersion: 2,
    }));
    expect(loadSymonScopeGrant()).toBeNull();

    writeFileSync(path.join(dataDir, 'symon-scope-grant.json'), '{');
    expect(loadSymonScopeGrant()).toBeNull();
  });

  it('revokes only the exact session grant and preserves a newer mint', () => {
    persistSymonScopeGrant(deviceGrant);
    expect(clearSymonScopeGrant('sym-other')).toBe(false);
    expect(loadSymonScopeGrant()).toEqual(deviceGrant);
    expect(clearSymonScopeGrant('sym-device')).toBe(true);
    expect(loadSymonScopeGrant()).toBeNull();
  });

  it('matches an enrolled device by exact session and device id', () => {
    expect(scopeGrantMatchesClient(deviceGrant, 'sym-device', { subject: 'device', deviceId: 'device-7' })).toBe(true);
    expect(scopeGrantMatchesClient(deviceGrant, 'sym-device', { subject: 'device', deviceId: 'device-8' })).toBe(false);
    expect(scopeGrantMatchesClient(deviceGrant, 'sym-other', { subject: 'device', deviceId: 'device-7' })).toBe(false);
    expect(scopeGrantMatchesClient(deviceGrant, 'sym-device', { subject: 'operator', deviceId: null })).toBe(false);
  });

  it('keeps the shared operator principal explicit instead of token-derived', () => {
    const operatorGrant = { ...deviceGrant, subject: 'operator' as const, deviceId: null };
    expect(scopeGrantMatchesClient(operatorGrant, 'sym-device', { subject: 'operator', deviceId: null })).toBe(true);
    expect(scopeGrantMatchesClient(operatorGrant, 'sym-device', { subject: 'device', deviceId: 'device-7' })).toBe(false);
  });

  it('allowlists tools and overwrites repo arguments for repo-aware Code tools', () => {
    expect(scopeSymonToolArgs(deviceGrant, 'o8_dispatch', {
      repo: '/Users/operator/other',
      task: 'Fix the bug',
    })).toEqual({
      ok: true,
      args: {
        repo: '/Users/operator/o8-mobile',
        repoId: 'repo-o8-mobile',
        repoPath: '/Users/operator/o8-mobile',
        task: 'Fix the bug',
      },
    });
    expect(scopeSymonToolArgs(deviceGrant, 'git_status', {})).toEqual({
      ok: true,
      args: {
        repo: '/Users/operator/o8-mobile',
        repoId: 'repo-o8-mobile',
        repoPath: '/Users/operator/o8-mobile',
      },
    });
    expect(scopeSymonToolArgs(deviceGrant, 'o8_delegate', { task: 'Investigate the failure' })).toEqual({
      ok: true,
      args: {
        repo: '/Users/operator/o8-mobile',
        repoId: 'repo-o8-mobile',
        repoPath: '/Users/operator/o8-mobile',
        task: 'Investigate the failure',
      },
    });
    expect(scopeSymonToolArgs(deviceGrant, 'send_email', {})).toMatchObject({
      ok: false,
      error: 'tool_not_allowed',
    });
  });

  it('scopes and allowlists every concrete action nested in a governed plan', () => {
    const planGrant = {
      ...deviceGrant,
      allowedTools: [...deviceGrant.allowedTools, 'symon_execute_plan'],
    };
    expect(scopeSymonToolArgs(planGrant, 'symon_execute_plan', {
      steps: [
        { tool: 'git_status', args: { repo: '/Users/operator/other' } },
        { tool: 'o8_dispatch', args: { repoPath: '/Users/operator/other', task: 'Fix it' } },
      ],
    })).toEqual({
      ok: true,
      args: {
        steps: [
          {
            tool: 'git_status',
            args: {
              repo: '/Users/operator/o8-mobile',
              repoId: 'repo-o8-mobile',
              repoPath: '/Users/operator/o8-mobile',
            },
          },
          {
            tool: 'o8_dispatch',
            args: {
              repo: '/Users/operator/o8-mobile',
              repoId: 'repo-o8-mobile',
              repoPath: '/Users/operator/o8-mobile',
              task: 'Fix it',
            },
          },
        ],
      },
    });

    expect(scopeSymonToolArgs(planGrant, 'symon_execute_plan', {
      steps: [{ tool: 'symon_execute_plan', args: { steps: [] } }],
    })).toMatchObject({ ok: false, error: 'tool_not_allowed' });
    expect(scopeSymonToolArgs(planGrant, 'symon_execute_plan', {
      steps: [{ tool: 'mac_mail_send_draft', args: {} }],
    })).toMatchObject({ ok: false, error: 'tool_not_allowed' });
  });

  it('rejects an explicit repo mismatch on stable-target Code tools', () => {
    expect(scopeSymonToolArgs(deviceGrant, 'o8_review_diff', {
      packetId: 'pkt-auth',
      repoPath: '/Users/operator/other',
    })).toMatchObject({ ok: false, error: 'repo_scope_mismatch' });

    expect(scopeSymonToolArgs(deviceGrant, 'o8_review_diff', {
      packetId: 'pkt-auth',
      repoPath: '/Users/operator/o8-mobile',
    })).toEqual({
      ok: true,
      args: {
        packetId: 'pkt-auth',
        repoId: 'repo-o8-mobile',
        repoPath: '/Users/operator/o8-mobile',
      },
    });

    expect(scopeSymonToolArgs(deviceGrant, 'o8_review_diff', {
      packetId: 'pkt-auth',
      repoId: 'repo-other',
    })).toMatchObject({ ok: false, error: 'repo_scope_mismatch' });
  });
});
