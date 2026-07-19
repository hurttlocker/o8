import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { fetchGitHubUser, fetchGitHubEmail } from '@/lib/auth/github';
import { findOrCreateByGithub } from '@/lib/db/users';
import { signToken } from '@/lib/auth/jwt';
import { createSession } from '@/lib/db/sessions';
import { resolveRequestPrincipal } from '@/lib/auth/principal';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type DeviceAction = 'start' | 'poll' | 'cancel' | 'login_token' | 'logout';

type DeviceFlowRecord = {
  flowId: string;
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  intervalMs: number;
  expiresAt: number;
  nextPollAt: number;
  /** CSRF: random token bound to the client that started the flow */
  csrfToken: string;
};

type DeviceStartPayload = {
  device_code?: string;
  user_code?: string;
  verification_uri?: string;
  verification_uri_complete?: string;
  expires_in?: number;
  interval?: number;
  error?: string;
  error_description?: string;
};

type DevicePollPayload = {
  access_token?: string;
  error?: string;
  error_description?: string;
};

const globalStore = globalThis as typeof globalThis & {
  __cortexGithubDeviceFlows?: Map<string, DeviceFlowRecord>;
};

const flows = globalStore.__cortexGithubDeviceFlows ?? new Map<string, DeviceFlowRecord>();
globalStore.__cortexGithubDeviceFlows = flows;

const DEFAULT_HOSTNAME = 'github.com';
const DEFAULT_SCOPES = 'repo read:org gist workflow';
const DEFAULT_INTERVAL_MS = 5000;

function githubClientId() {
  return process.env.GITHUB_OAUTH_CLIENT_ID?.trim();
}

function githubScopes() {
  return process.env.GITHUB_OAUTH_SCOPES?.trim() || DEFAULT_SCOPES;
}

async function postGithubForm<T>(url: string, params: URLSearchParams) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
    cache: 'no-store',
  });

  const payload = (await response.json().catch(() => null)) as T | null;
  return { response, payload };
}

function execGhWithToken(token: string) {
  execFileSync(
    'gh',
    ['auth', 'login', '--hostname', DEFAULT_HOSTNAME, '--git-protocol', 'https', '--with-token'],
    {
      encoding: 'utf-8',
      timeout: 15000,
      input: `${token}\n`,
      env: { ...process.env, PATH: `${process.env.PATH}:/usr/local/bin:/opt/homebrew/bin` },
    },
  );
}

function execGhLogout(user: string) {
  execFileSync(
    'gh',
    ['auth', 'logout', '--hostname', DEFAULT_HOSTNAME, '--user', user],
    {
      encoding: 'utf-8',
      timeout: 15000,
      env: { ...process.env, PATH: `${process.env.PATH}:/usr/local/bin:/opt/homebrew/bin` },
    },
  );
}

async function completeGitHubConnection(accessToken: string) {
  execGhWithToken(accessToken);

  const ghUser = await fetchGitHubUser(accessToken);
  if (!ghUser) {
    throw new Error('GitHub connected to gh, but its user profile could not be loaded.');
  }

  let email = ghUser.email;
  if (!email) email = await fetchGitHubEmail(accessToken);

  const user = findOrCreateByGithub(ghUser.id, {
    email: email ?? undefined,
    name: ghUser.name ?? ghUser.login,
    avatarUrl: ghUser.avatar_url,
  });
  const jwt = await signToken({
    uid: user.id,
    ghUser: ghUser.login,
    plan: user.plan,
  });

  createSession({
    userId: user.id,
    token: jwt,
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
  });

  return {
    jwt,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      avatarUrl: user.avatarUrl,
      plan: user.plan,
      githubUsername: ghUser.login,
    },
  };
}

function connectedResponse(result: Awaited<ReturnType<typeof completeGitHubConnection>>, note: string) {
  const response = NextResponse.json({
    ok: true,
    status: 'complete',
    note,
    user: result.user,
  });
  response.cookies.set('o8-token', result.jwt, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 30 * 24 * 60 * 60,
    path: '/',
  });
  return response;
}

function routeError(error: unknown) {
  if (typeof error === 'object' && error && 'stderr' in error) {
    const stderr = error.stderr;
    if (typeof stderr === 'string' && stderr.trim()) return stderr.trim();
    if (stderr instanceof Buffer && stderr.length > 0) return stderr.toString('utf-8').trim();
  }
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  return 'GitHub device flow failed.';
}

function pendingResponse(flow: DeviceFlowRecord, note: string) {
  return NextResponse.json({
    ok: true,
    status: 'pending',
    flowId: flow.flowId,
    userCode: flow.userCode,
    verificationUri: flow.verificationUri,
    verificationUriComplete: flow.verificationUriComplete,
    expiresAt: flow.expiresAt,
    expiresInMinutes: Math.max(1, Math.ceil((flow.expiresAt - Date.now()) / 60000)),
    nextPollInMs: Math.max(1000, flow.nextPollAt - Date.now()),
    note,
  });
}

export async function POST(request: Request) {
  if (resolveRequestPrincipal(request) !== 'operator') {
    return NextResponse.json({ error: 'GitHub connection changes are operator-only.' }, { status: 403 });
  }
  try {
    const payload = await request.json().catch(() => null) as {
      action?: DeviceAction;
      flowId?: string;
      csrfToken?: string;
      token?: string;
      user?: string;
    } | null;

    const action = payload?.action;
    if (!action || !['start', 'poll', 'cancel', 'login_token', 'logout'].includes(action)) {
      return NextResponse.json({ error: 'Unsupported GitHub connection action.' }, { status: 400 });
    }

    if (action === 'login_token') {
      const token = payload?.token?.trim();
      if (!token) {
        return NextResponse.json({ error: 'token is required.' }, { status: 400 });
      }
      const result = await completeGitHubConnection(token);
      return connectedResponse(result, 'GitHub connected with an access token.');
    }

    if (action === 'logout') {
      const user = payload?.user?.trim();
      if (!user) {
        return NextResponse.json({ error: 'user is required.' }, { status: 400 });
      }
      execGhLogout(user);
      return NextResponse.json({
        ok: true,
        status: 'disconnected',
        note: `Disconnected GitHub account ${user} from this machine's gh CLI config.`,
      });
    }

    const clientId = githubClientId();
    if (!clientId) {
      return NextResponse.json(
        { error: 'GITHUB_OAUTH_CLIENT_ID is not configured for GitHub device login.' },
        { status: 400 },
      );
    }

    if (action === 'start') {
      const params = new URLSearchParams({
        client_id: clientId,
        scope: githubScopes(),
      });
      const { response, payload: startPayload } = await postGithubForm<DeviceStartPayload>(
        'https://github.com/login/device/code',
        params,
      );

      if (!response.ok || !startPayload?.device_code || !startPayload.user_code || !startPayload.verification_uri || !startPayload.expires_in) {
        return NextResponse.json(
          { error: startPayload?.error_description || startPayload?.error || 'GitHub did not return a device code.' },
          { status: 500 },
        );
      }

      const intervalMs = Math.max(DEFAULT_INTERVAL_MS, (startPayload.interval ?? 5) * 1000);
      const flowId = randomUUID();
      const csrfToken = randomUUID();
      const flow: DeviceFlowRecord = {
        flowId,
        deviceCode: startPayload.device_code,
        userCode: startPayload.user_code,
        verificationUri: startPayload.verification_uri,
        verificationUriComplete: startPayload.verification_uri_complete,
        intervalMs,
        expiresAt: Date.now() + startPayload.expires_in * 1000,
        nextPollAt: Date.now() + intervalMs,
        csrfToken,
      };
      flows.set(flowId, flow);

      return NextResponse.json({
        ok: true,
        status: 'pending',
        flowId,
        csrfToken,
        userCode: flow.userCode,
        verificationUri: flow.verificationUri,
        verificationUriComplete: flow.verificationUriComplete,
        expiresAt: flow.expiresAt,
        expiresInMinutes: Math.max(1, Math.ceil((flow.expiresAt - Date.now()) / 60000)),
        nextPollInMs: intervalMs,
        note: 'Open GitHub, enter the code, and this panel will finish the local gh login automatically.',
      });
    }

    const flowId = payload?.flowId?.trim();
    if (!flowId) {
      return NextResponse.json({ error: 'flowId is required.' }, { status: 400 });
    }

    const flow = flows.get(flowId);
    if (action === 'cancel') {
      if (flow) flows.delete(flowId);
      return NextResponse.json({
        ok: true,
        status: 'cancelled',
        note: 'GitHub device login cancelled.',
      });
    }

    if (!flow) {
      return NextResponse.json({ error: 'GitHub device flow not found. Start a new device login.' }, { status: 404 });
    }

    // CSRF check — client must send back the token it received on start
    if (flow.csrfToken && flow.csrfToken !== payload?.csrfToken) {
      return NextResponse.json({ error: 'Invalid CSRF token. Start a new device login.' }, { status: 403 });
    }

    if (Date.now() >= flow.expiresAt) {
      flows.delete(flowId);
      return NextResponse.json({ ok: false, status: 'expired', note: 'The GitHub device code expired. Start a new login.' });
    }

    if (Date.now() < flow.nextPollAt) {
      return pendingResponse(flow, 'Waiting for GitHub authorization…');
    }

    const params = new URLSearchParams({
      client_id: clientId,
      device_code: flow.deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    });
    const { payload: pollPayload } = await postGithubForm<DevicePollPayload>(
      'https://github.com/login/oauth/access_token',
      params,
    );

    if (pollPayload?.access_token) {
      const result = await completeGitHubConnection(pollPayload.access_token);
      flows.delete(flowId);
      return connectedResponse(result, 'GitHub connected through device flow.');
    }

    switch (pollPayload?.error) {
      case 'authorization_pending': {
        flow.nextPollAt = Date.now() + flow.intervalMs;
        flows.set(flowId, flow);
        return pendingResponse(flow, 'Waiting for approval in GitHub…');
      }
      case 'slow_down': {
        flow.intervalMs += 5000;
        flow.nextPollAt = Date.now() + flow.intervalMs;
        flows.set(flowId, flow);
        return pendingResponse(flow, 'GitHub requested slower polling. Still waiting for approval…');
      }
      case 'access_denied': {
        flows.delete(flowId);
        return NextResponse.json({ ok: false, status: 'denied', note: 'GitHub authorization was cancelled.' });
      }
      case 'expired_token': {
        flows.delete(flowId);
        return NextResponse.json({ ok: false, status: 'expired', note: 'The GitHub device code expired. Start a new login.' });
      }
      case 'device_flow_disabled': {
        flows.delete(flowId);
        return NextResponse.json({
          ok: false,
          status: 'error',
          note: 'Device flow is not enabled for this GitHub OAuth app yet.',
        });
      }
      default: {
        flows.delete(flowId);
        return NextResponse.json({
          ok: false,
          status: 'error',
          note: pollPayload?.error_description || pollPayload?.error || 'GitHub device login failed.',
        });
      }
    }
  } catch (error) {
    return NextResponse.json({ error: routeError(error) }, { status: 500 });
  }
}
