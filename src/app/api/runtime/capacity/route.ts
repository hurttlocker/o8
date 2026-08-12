import { NextRequest, NextResponse } from 'next/server';

import { resolveRequestPrincipal } from '@/lib/auth/principal';
import { requirePanelAuth } from '@/lib/panel/auth';
import {
  bindIdempotencyClientMutation,
  deriveIdempotencyKey,
  withIdempotency,
} from '@/lib/orchestrator/idempotency-store';
import {
  getRuntimeCapacityControlSnapshot,
  invalidateRuntimeCapacitySnapshot,
} from '@/lib/runtime/capacity-service';
import {
  reconcileRuntimeIdentityMutation,
  registerRuntimeIdentity,
  selectRuntimeIdentity,
} from '@/lib/runtime/identity-catalog';
import { getRuntime } from '@/lib/runtimes';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type IdentityMutation =
  | {
      action: 'register';
      clientMutationId: string;
      runtime: string;
      label: string;
      configHomeRef: string;
    }
  | {
      action: 'select';
      clientMutationId: string;
      runtime: string;
      identityId: string;
    };

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function parseMutation(value: unknown): IdentityMutation | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const action = text(record.action);
  const clientMutationId = text(record.clientMutationId);
  const runtimeId = text(record.runtime);
  if (!clientMutationId || !runtimeId) return null;
  if (action === 'register') {
    const label = text(record.label).replace(/\s+/g, ' ');
    const configHomeRef = text(record.configHomeRef);
    if (!label || label.length > 80 || !configHomeRef) return null;
    return { action, clientMutationId, runtime: runtimeId, label, configHomeRef };
  }
  if (action === 'select') {
    const identityId = text(record.identityId);
    return identityId ? { action, clientMutationId, runtime: runtimeId, identityId } : null;
  }
  return null;
}

function publicIdentity(identity: { id: string; runtime: string; label: string }) {
  return { id: identity.id, runtime: identity.runtime, label: identity.label };
}

export async function GET(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;
  const fresh = request.nextUrl.searchParams.get('fresh') === '1';
  try {
    return NextResponse.json(await getRuntimeCapacityControlSnapshot({ fresh }), {
      headers: { 'Cache-Control': 'no-store, max-age=0' },
    });
  } catch {
    return NextResponse.json({
      ok: false,
      error: 'Runtime capacity state is unavailable and was not changed.',
    }, { status: 503, headers: { 'Cache-Control': 'no-store, max-age=0' } });
  }
}

export async function POST(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;
  if (resolveRequestPrincipal(request) !== 'operator') {
    return NextResponse.json({ ok: false, error: 'Identity selection is operator-only.' }, { status: 403 });
  }

  const mutation = parseMutation(await request.json().catch(() => null));
  if (!mutation) {
    return NextResponse.json({ ok: false, error: 'A valid identity mutation is required.' }, { status: 400 });
  }
  const adapter = getRuntime(mutation.runtime);
  if (!adapter?.capabilities.capacity?.identitySelection || !adapter.validateIdentityConfigHome) {
    return NextResponse.json({
      ok: false,
      error: adapter?.capabilities.capacity?.identitySelectionReason
        ?? 'This runtime does not support isolated identity selection.',
    }, { status: 409 });
  }

  try {
    let canonicalMutation: IdentityMutation = mutation;
    if (mutation.action === 'register') {
      const validation = await adapter.validateIdentityConfigHome(mutation.configHomeRef);
      if (!validation.ok || !validation.configHomeRef) {
        return NextResponse.json({ ok: false, error: validation.reason ?? 'Invalid identity config home.' }, { status: 400 });
      }
      canonicalMutation = { ...mutation, configHomeRef: validation.configHomeRef };
    }
    const canonicalBody = JSON.stringify(canonicalMutation);
    const namespace = `runtime_identity_${mutation.action}`;
    const binding = bindIdempotencyClientMutation({
      namespace,
      clientKey: mutation.clientMutationId,
      body: canonicalBody,
    });
    if (binding.status === 'conflict') {
      return NextResponse.json({
        ok: false,
        error: 'clientMutationId was already used for a different identity mutation.',
      }, { status: 409 });
    }
    if (binding.status === 'unavailable') {
      return NextResponse.json({
        ok: false,
        error: 'The persisted idempotency store is unavailable; identity state was not changed.',
      }, { status: 503 });
    }

    const outcome = await withIdempotency({
      key: deriveIdempotencyKey({
        verb: namespace,
        scopeId: mutation.runtime,
        clientKey: mutation.clientMutationId,
        body: canonicalBody,
      }),
      verb: namespace,
      scopeId: mutation.runtime,
      reconcileUnresolved: async () => {
        const identity = await reconcileRuntimeIdentityMutation(canonicalMutation);
        return identity
          ? { ok: true as const, action: canonicalMutation.action, identity: publicIdentity(identity) }
          : null;
      },
    }, async () => {
      const identity = canonicalMutation.action === 'register'
        ? await registerRuntimeIdentity(canonicalMutation)
        : await selectRuntimeIdentity(canonicalMutation.runtime, canonicalMutation.identityId);
      invalidateRuntimeCapacitySnapshot();
      return { ok: true as const, action: canonicalMutation.action, identity: publicIdentity(identity) };
    });

    if (outcome.inProgress) {
      const outcomeUnknown = outcome.unresolved === true;
      return NextResponse.json({
        ok: !outcomeUnknown,
        action: mutation.action,
        clientMutationId: mutation.clientMutationId,
        inProgress: true,
        outcomeUnknown: outcomeUnknown || undefined,
        replayed: true,
        ...(outcomeUnknown ? { error: 'The prior identity mutation outcome cannot be reconstructed. Inspect registered identities before taking another action.' } : {}),
      }, { status: outcomeUnknown ? 409 : 202, headers: { 'Cache-Control': 'no-store, max-age=0' } });
    }
    return NextResponse.json({
      ...outcome.result,
      clientMutationId: mutation.clientMutationId,
      replayed: outcome.replayed || undefined,
      persistenceDegraded: outcome.persistenceDegraded || undefined,
    }, { headers: { 'Cache-Control': 'no-store, max-age=0' } });
  } catch (error) {
    const missing = error instanceof Error && error.message === 'identity_not_found';
    return NextResponse.json({
      ok: false,
      error: missing ? 'The selected identity was not found for this runtime.' : 'Identity state could not be updated.',
    }, { status: missing ? 404 : 500 });
  }
}
