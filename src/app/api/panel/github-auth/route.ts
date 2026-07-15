import { execFileSync } from 'node:child_process';
import { NextResponse } from 'next/server';
import { resolveRequestPrincipal } from '@/lib/auth/principal';

type GitHubAuthAction = 'switch' | 'logout' | 'login_token';

const DEFAULT_HOSTNAME = 'github.com';

function execGh(args: string[], input?: string) {
  return execFileSync('gh', args, {
    encoding: 'utf-8',
    timeout: 15000,
    input,
    env: { ...process.env, PATH: `${process.env.PATH}:/usr/local/bin:/opt/homebrew/bin` },
  }).trim();
}

function errorMessage(error: unknown) {
  if (typeof error === 'object' && error && 'stderr' in error) {
    const stderr = error.stderr;
    if (typeof stderr === 'string' && stderr.trim()) return stderr.trim();
    if (stderr instanceof Buffer && stderr.length > 0) return stderr.toString('utf-8').trim();
  }
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  return 'GitHub auth action failed.';
}

export async function POST(request: Request) {
  if (resolveRequestPrincipal(request) !== 'operator') {
    return NextResponse.json({ error: 'GitHub credential changes are operator-only.' }, { status: 403 });
  }
  try {
    const payload = await request.json().catch(() => null) as {
      action?: GitHubAuthAction;
      hostname?: string;
      user?: string;
      token?: string;
    } | null;

    const action = payload?.action;
    const hostname = payload?.hostname?.trim() || DEFAULT_HOSTNAME;
    const user = payload?.user?.trim();
    const token = payload?.token?.trim();

    if (!action || (action !== 'switch' && action !== 'logout' && action !== 'login_token')) {
      return NextResponse.json({ error: 'Unsupported GitHub auth action.' }, { status: 400 });
    }

    if (action === 'login_token') {
      if (!token) {
        return NextResponse.json({ error: 'token is required.' }, { status: 400 });
      }

      execGh(
        ['auth', 'login', '--hostname', hostname, '--git-protocol', 'https', '--with-token'],
        `${token}\n`,
      );
      return NextResponse.json({
        ok: true,
        action,
        note: 'GitHub PAT accepted by gh CLI. Refreshing local account state now.',
      });
    }

    if (!user) {
      return NextResponse.json({ error: 'user is required.' }, { status: 400 });
    }

    if (action === 'switch') {
      execGh(['auth', 'switch', '--hostname', hostname, '--user', user]);
      return NextResponse.json({
        ok: true,
        action,
        note: `Switched active GitHub account to ${user}.`,
      });
    }

    execGh(['auth', 'logout', '--hostname', hostname, '--user', user]);
    return NextResponse.json({
      ok: true,
      action,
      note: `Disconnected GitHub account ${user} from this machine's gh CLI config.`,
    });
  } catch (error) {
    return NextResponse.json({ error: errorMessage(error) }, { status: 500 });
  }
}
