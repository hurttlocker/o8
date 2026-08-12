import 'server-only';

import { randomUUID } from 'node:crypto';

import { listApprovalsForContext, supersedeOrchestratorReviewApprovals } from '@/lib/approvals/store';
import { resolveApproval } from '@/lib/approvals/resolution';
import { recordLaneEvent } from '@/lib/lane/events';
import { findLaneBySession, setLaneStatus } from '@/lib/lane/registry';
import { readHeadSha } from '@/lib/lane/head-sha-lock';
import {
  publicSessionTransformCatalog,
  readSessionTransformIntents,
  readSessionTransformCatalog,
  sessionIsCataloged,
  withSessionTransformCatalogLock,
  writeSessionTransformCatalog,
  writeSessionTransformIntents,
  type SessionCatalogEntry,
  type SessionTransformIntent,
  type SessionTransformIntentSession,
  type SessionTransformCatalog,
  type SessionTransformReceipt,
} from '@/lib/runtime/session-transform-catalog';
import { getRuntime } from '@/lib/runtimes';
import type {
  RuntimeId,
  RuntimeSession,
  RuntimeSessionTransformAction,
  RuntimeSessionTransformCapabilityDetails,
} from '@/lib/runtimes/types';

export type SessionTransformFailureReason =
  | 'invalid_request'
  | 'runtime_not_found'
  | 'unsupported'
  | 'session_not_found'
  | 'not_imported'
  | 'already_imported'
  | 'checkpoint_not_found'
  | 'stale_checkpoint'
  | 'stale_catalog'
  | 'provider_error'
  | 'catalog_unavailable';

export class SessionTransformError extends Error {
  constructor(
    readonly reason: SessionTransformFailureReason,
    message: string,
    readonly status: number,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'SessionTransformError';
  }
}

export interface SessionTransformRequest {
  action: RuntimeSessionTransformAction;
  runtimeId: RuntimeId;
  sessionKey: string;
  checkpointId?: string;
  expectedCatalogVersion: number;
  clientMutationId?: string;
}

export interface SessionTransformResult {
  ok: true;
  action: RuntimeSessionTransformAction;
  note: string;
  runtimeId: RuntimeId;
  originalSessionKey: string;
  resultingSessionKey: string;
  checkpointId: string | null;
  catalogVersion: number;
  providerSessionCreated: boolean;
  beforeHeadSha: string | null;
  afterHeadSha: string | null;
  staleGovernanceInvalidated: boolean;
  recovered?: boolean;
}

const UNSUPPORTED_CAPABILITIES: RuntimeSessionTransformCapabilityDetails = {
  import: { supported: false, reason: 'This runtime does not expose provider-native session import.' },
  checkpoint: { supported: false, reason: 'This runtime does not expose provider-native checkpoints.' },
  fork: { supported: false, reason: 'This runtime does not expose provider-native forks.' },
  rewind: { supported: false, reason: 'This runtime does not expose immutable rewind continuations.' },
};

function runtimeCapabilityDetails(runtimeId: RuntimeId): RuntimeSessionTransformCapabilityDetails {
  const runtime = getRuntime(runtimeId);
  const support = runtime?.capabilities.sessionTransforms;
  if (!runtime || !support || !runtime.transformSession) return UNSUPPORTED_CAPABILITIES;
  return {
    import: support.import ? { supported: true } : UNSUPPORTED_CAPABILITIES.import,
    checkpoint: support.checkpoint ? { supported: true } : UNSUPPORTED_CAPABILITIES.checkpoint,
    fork: support.fork ? { supported: true } : UNSUPPORTED_CAPABILITIES.fork,
    rewind: support.rewind ? { supported: true } : UNSUPPORTED_CAPABILITIES.rewind,
  };
}

async function capabilityDetails(runtimeId: RuntimeId, sessionKey?: string) {
  const runtime = getRuntime(runtimeId);
  const broad = runtimeCapabilityDetails(runtimeId);
  if (!runtime || !sessionKey || !runtime.getSessionTransformCapabilities) return broad;
  const narrowed = await runtime.getSessionTransformCapabilities(sessionKey);
  return {
    import: broad.import.supported ? narrowed.import : broad.import,
    checkpoint: broad.checkpoint.supported ? narrowed.checkpoint : broad.checkpoint,
    fork: broad.fork.supported ? narrowed.fork : broad.fork,
    rewind: broad.rewind.supported ? narrowed.rewind : broad.rewind,
  } satisfies RuntimeSessionTransformCapabilityDetails;
}

export async function getSessionTransformState(runtimeId: RuntimeId, sessionKey?: string) {
  if (sessionKey) await reconcileSessionTransformIntent(runtimeId, sessionKey);
  const [capabilities, catalog, intents] = await Promise.all([
    capabilityDetails(runtimeId, sessionKey),
    readSessionTransformCatalog(),
    readSessionTransformIntents(),
  ]);
  const visible = publicSessionTransformCatalog(catalog);
  const pending = sessionKey
    ? intents.find((intent) => intent.runtimeId === runtimeId && intent.originalSessionKey === sessionKey)
    : undefined;
  return {
    runtimeId,
    sessionKey: sessionKey ?? null,
    capabilities,
    catalogVersion: visible.version,
    pendingTransform: pending ? {
      id: pending.id,
      action: pending.action,
      phase: pending.phase,
      startedAt: pending.startedAt,
      manualResolutionRequired: pending.phase === 'provider_started' && !pending.result,
    } : null,
    catalogSession: sessionKey
      ? visible.sessions.find((session) => session.runtimeId === runtimeId && session.sessionKey === sessionKey) ?? null
      : null,
    checkpoints: sessionKey
      ? visible.checkpoints.filter((checkpoint) => checkpoint.runtimeId === runtimeId && checkpoint.sessionKey === sessionKey)
      : [],
    receipts: sessionKey
      ? visible.receipts.filter((receipt) => (
        receipt.runtimeId === runtimeId
        && (receipt.originalSessionKey === sessionKey || receipt.resultingSessionKey === sessionKey)
      ))
      : [],
  };
}

async function safelyReadHead(cwd: string | null | undefined) {
  if (!cwd) return null;
  return readHeadSha(cwd).catch(() => null);
}

function intentSession(session: RuntimeSession): SessionTransformIntentSession {
  return {
    runtimeId: session.runtimeId,
    sessionKey: session.sessionKey,
    identityId: session.identityId ?? null,
    displayName: session.displayName,
    ownership: session.ownership,
    cwd: session.cwd,
    branch: session.branch ?? null,
  };
}

async function replaceIntent(intent: SessionTransformIntent | null, removeId?: string) {
  const intents = await readSessionTransformIntents();
  const without = intents.filter((candidate) => candidate.id !== (removeId ?? intent?.id));
  await writeSessionTransformIntents(intent ? [...without, intent] : without);
}

function catalogSessionFromRuntime(
  session: RuntimeSession,
  provenance: SessionCatalogEntry['provenance'],
  lineage: SessionCatalogEntry['lineage'],
): SessionCatalogEntry {
  return {
    runtimeId: session.runtimeId,
    sessionKey: session.sessionKey,
    identityId: session.identityId ?? null,
    displayName: session.displayName,
    ownership: session.ownership,
    cwd: session.cwd,
    repoPath: session.cwd || null,
    branch: session.branch ?? null,
    importedAt: new Date().toISOString(),
    provenance,
    lineage,
  };
}

function assertCatalogVersion(catalog: SessionTransformCatalog, expected: number) {
  if (catalog.version !== expected) {
    throw new SessionTransformError(
      'stale_catalog',
      `Session catalog changed from version ${expected} to ${catalog.version}; refresh before retrying.`,
      409,
    );
  }
}

function invalidateGovernance(
  lane: NonNullable<ReturnType<typeof findLaneBySession>>,
  beforeHeadSha: string,
  afterHeadSha: string,
) {
  const note = `Session transform changed worktree HEAD from ${beforeHeadSha} to ${afterHeadSha}; review and merge approval must be repeated.`;
  setLaneStatus(lane.id, 'reviewing', 'system', 'review_invalidated');
  recordLaneEvent(lane.id, 'review_invalidated', 'system', {
    packetId: lane.packetId,
    sessionKey: lane.sessionKey,
    beforeHeadSha,
    afterHeadSha,
    source: 'session_transform',
  });
  if (lane.packetId) supersedeOrchestratorReviewApprovals(lane.packetId, note);
  for (const approval of listApprovalsForContext({
    packetId: lane.packetId ?? undefined,
    laneId: lane.id,
    sessionKey: lane.sessionKey ?? undefined,
    projectId: null,
  })) {
    const staleReview = approval.toolName === 'orchestrator_review';
    const staleLaneAction = approval.continuation?.kind === 'lane'
      && (approval.continuation.verb === 'merge' || approval.continuation.verb === 'create_pr');
    if (approval.status === 'pending' && (staleReview || staleLaneAction)) {
      resolveApproval(approval.id, 'reject', 'system', note);
    }
  }
}

function sourceSessionForCatalog(
  discovered: RuntimeSession | undefined,
  providerSession: RuntimeSession,
) {
  if (!discovered) return providerSession;
  return {
    ...providerSession,
    sessionKey: discovered.sessionKey,
    runtimeId: discovered.runtimeId,
    displayName: discovered.displayName,
    ownership: discovered.ownership,
    cwd: discovered.cwd || providerSession.cwd,
    branch: discovered.branch ?? providerSession.branch,
    headSha: discovered.headSha ?? providerSession.headSha,
    repoSlug: discovered.repoSlug ?? providerSession.repoSlug,
    identityId: discovered.identityId ?? providerSession.identityId,
  };
}

async function reconcileSessionTransformIntentLocked(runtimeId: RuntimeId, sessionKey: string) {
  const intents = await readSessionTransformIntents();
  const intent = intents.find((candidate) => (
    candidate.runtimeId === runtimeId && candidate.originalSessionKey === sessionKey
  ));
  if (!intent) return false;
  const runtime = getRuntime(runtimeId);
  if (!runtime) return false;
  const catalog = await readSessionTransformCatalog();
  const existingReceipt = catalog.receipts.find((receipt) => receipt.id === intent.id);
  const lane = (() => {
    try {
      return findLaneBySession(sessionKey);
    } catch {
      return null;
    }
  })();
  if (existingReceipt) {
    if (
      existingReceipt.staleGovernanceInvalidated
      && lane
      && existingReceipt.beforeHeadSha
      && existingReceipt.afterHeadSha
    ) {
      invalidateGovernance(lane, existingReceipt.beforeHeadSha, existingReceipt.afterHeadSha);
    }
    await replaceIntent(null, intent.id);
    return true;
  }

  // The provider call is sequenced strictly after the atomic phase transition.
  // Seeing `prepared` after a crash proves no provider request was attempted.
  if (intent.phase === 'prepared') {
    await replaceIntent(null, intent.id);
    return true;
  }

  let durableIntent = intent;
  if (durableIntent.phase === 'provider_started' && !durableIntent.result) {
    const recovered = await runtime.recoverSessionTransform?.({
      action: intent.action,
      sessionKey,
      identityId: intent.identityId ?? undefined,
      providerCheckpointRef: intent.providerCheckpointRef,
      operationId: intent.id,
      startedAt: intent.startedAt,
    });
    if (!recovered?.ok || !recovered.resultingSession) return false;
    durableIntent = {
      ...intent,
      phase: 'provider_succeeded',
      result: {
        note: recovered.note,
        resultingSession: intentSession(recovered.resultingSession),
        providerSessionCreated: recovered.providerSessionCreated === true,
        afterHeadSha: await safelyReadHead(intent.codeCwd),
      },
    };
    await replaceIntent(durableIntent);
  }

  const result = durableIntent.result;
  if (!result) return false;
  if (catalog.sessions.some((session) => (
    session.runtimeId === runtimeId && session.sessionKey === result.resultingSession.sessionKey
  ))) {
    return false;
  }
  const headChanged = Boolean(
    lane
    && durableIntent.beforeHeadSha
    && result.afterHeadSha
    && durableIntent.beforeHeadSha !== result.afterHeadSha
  );
  const createdAt = new Date().toISOString();
  const next: SessionTransformCatalog = {
    ...catalog,
    version: catalog.version + 1,
    sessions: [...catalog.sessions, {
      ...result.resultingSession,
      repoPath: result.resultingSession.cwd || null,
      importedAt: createdAt,
      provenance: durableIntent.action,
      lineage: {
        action: durableIntent.action,
        parentSessionKey: sessionKey,
        checkpointId: durableIntent.checkpointId,
      },
    }],
    checkpoints: catalog.checkpoints,
    receipts: [...catalog.receipts, {
      id: durableIntent.id,
      clientMutationId: durableIntent.clientMutationId ?? null,
      action: durableIntent.action,
      runtimeId,
      originalSessionKey: sessionKey,
      resultingSessionKey: result.resultingSession.sessionKey,
      checkpointId: durableIntent.checkpointId,
      beforeHeadSha: durableIntent.beforeHeadSha,
      afterHeadSha: result.afterHeadSha,
      providerSessionCreated: result.providerSessionCreated,
      packetId: durableIntent.packetId,
      laneId: durableIntent.laneId,
      staleGovernanceInvalidated: headChanged,
      createdAt,
    }],
  };
  await writeSessionTransformCatalog(next);
  if (headChanged && lane && durableIntent.beforeHeadSha && result.afterHeadSha) {
    invalidateGovernance(lane, durableIntent.beforeHeadSha, result.afterHeadSha);
  }
  await replaceIntent(null, durableIntent.id);
  return true;
}

async function reconcileSessionTransformIntent(runtimeId: RuntimeId, sessionKey: string) {
  const pending = (await readSessionTransformIntents()).some((intent) => (
    intent.runtimeId === runtimeId && intent.originalSessionKey === sessionKey
  ));
  if (!pending) return false;
  return withSessionTransformCatalogLock(runtimeId, sessionKey, () => (
    reconcileSessionTransformIntentLocked(runtimeId, sessionKey)
  ));
}

export async function dismissUnresolvedSessionTransform(input: {
  runtimeId: RuntimeId;
  sessionKey: string;
  intentId: string;
  expectedCatalogVersion: number;
  providerOutcome: 'no_continuation';
}) {
  return withSessionTransformCatalogLock(input.runtimeId, input.sessionKey, async () => {
    const catalog = await readSessionTransformCatalog();
    assertCatalogVersion(catalog, input.expectedCatalogVersion);
    const intents = await readSessionTransformIntents();
    const intent = intents.find((candidate) => (
      candidate.id === input.intentId
      && candidate.runtimeId === input.runtimeId
      && candidate.originalSessionKey === input.sessionKey
    ));
    if (!intent) {
      throw new SessionTransformError('session_not_found', 'No matching pending transform exists.', 404);
    }
    if (intent.phase !== 'provider_started' || intent.result) {
      throw new SessionTransformError(
        'stale_catalog',
        'This transform has recoverable provider evidence and cannot be dismissed.',
        409,
      );
    }
    await replaceIntent(null, intent.id);
    return {
      ok: true as const,
      action: 'dismiss_pending' as const,
      runtimeId: input.runtimeId,
      sessionKey: input.sessionKey,
      catalogVersion: catalog.version,
      note: 'Cleared the unresolved attempt after the operator confirmed no provider continuation exists.',
    };
  });
}

export async function performSessionTransform(
  request: SessionTransformRequest,
): Promise<SessionTransformResult> {
  const sessionKey = request.sessionKey.trim();
  if (!sessionKey || !Number.isInteger(request.expectedCatalogVersion) || request.expectedCatalogVersion < 0) {
    throw new SessionTransformError(
      'invalid_request',
      'sessionKey and a non-negative expectedCatalogVersion are required.',
      400,
    );
  }
  const runtime = getRuntime(request.runtimeId);
  if (!runtime) {
    throw new SessionTransformError('runtime_not_found', `Runtime ${request.runtimeId} is not registered.`, 404);
  }
  const transformSession = runtime.transformSession;
  if (!transformSession) {
    throw new SessionTransformError('unsupported', `Runtime ${request.runtimeId} has no session transform adapter.`, 400);
  }

  return withSessionTransformCatalogLock(request.runtimeId, sessionKey, async () => {
    await reconcileSessionTransformIntentLocked(request.runtimeId, sessionKey);
    const unresolvedIntent = (await readSessionTransformIntents()).find((intent) => (
      intent.runtimeId === request.runtimeId && intent.originalSessionKey === sessionKey
    ));
    if (unresolvedIntent) {
      throw new SessionTransformError(
        'catalog_unavailable',
        'A prior provider continuation is awaiting durable lineage reconciliation.',
        503,
        true,
      );
    }
    const catalog = await readSessionTransformCatalog().catch((error) => {
      throw new SessionTransformError(
        'catalog_unavailable',
        error instanceof Error ? error.message : 'Session catalog is unavailable.',
        503,
        true,
      );
    });
    const recoveredReceipt = request.clientMutationId
      ? catalog.receipts.find((receipt) => (
        receipt.clientMutationId === request.clientMutationId
        && receipt.runtimeId === request.runtimeId
        && receipt.originalSessionKey === sessionKey
        && receipt.action === request.action
      ))
      : undefined;
    if (recoveredReceipt) {
      return {
        ok: true,
        action: recoveredReceipt.action,
        note: 'Recovered the completed provider transform after an interrupted response.',
        runtimeId: request.runtimeId,
        originalSessionKey: recoveredReceipt.originalSessionKey,
        resultingSessionKey: recoveredReceipt.resultingSessionKey,
        checkpointId: recoveredReceipt.checkpointId,
        catalogVersion: catalog.version,
        providerSessionCreated: recoveredReceipt.providerSessionCreated,
        beforeHeadSha: recoveredReceipt.beforeHeadSha,
        afterHeadSha: recoveredReceipt.afterHeadSha,
        staleGovernanceInvalidated: recoveredReceipt.staleGovernanceInvalidated,
        recovered: true,
      };
    }
    assertCatalogVersion(catalog, request.expectedCatalogVersion);
    const capabilities = await capabilityDetails(request.runtimeId, sessionKey);
    const capability = capabilities[request.action];
    if (!capability.supported) {
      throw new SessionTransformError('unsupported', capability.reason ?? 'This transform is unsupported.', 400);
    }

    const imported = catalog.sessions.find((session) => (
      session.runtimeId === request.runtimeId && session.sessionKey === sessionKey
    ));
    if (request.action === 'import' && imported) {
      throw new SessionTransformError('already_imported', 'This provider session is already in the o8 catalog.', 409);
    }
    if (request.action !== 'import' && !imported) {
      throw new SessionTransformError('not_imported', 'Import this provider session before transforming it.', 409);
    }

    const checkpoint = request.action === 'fork' || request.action === 'rewind'
      ? catalog.checkpoints.find((candidate) => (
        candidate.id === request.checkpointId
        && candidate.runtimeId === request.runtimeId
        && candidate.sessionKey === sessionKey
      ))
      : null;
    if ((request.action === 'fork' || request.action === 'rewind') && !checkpoint) {
      throw new SessionTransformError('checkpoint_not_found', 'The selected checkpoint does not belong to this session.', 404);
    }

    const discovered = (await runtime.discoverSessions().catch(() => []))
      .find((session) => session.sessionKey === sessionKey);
    if (request.action === 'import' && !discovered) {
      throw new SessionTransformError('session_not_found', 'The provider session is not currently discoverable.', 404);
    }
    const lane = (() => {
      try {
        return findLaneBySession(sessionKey);
      } catch {
        return null;
      }
    })();
    const codeCwd = lane?.worktreePath || lane?.repoPath || imported?.cwd || discovered?.cwd;
    const identityId = imported?.identityId ?? discovered?.identityId ?? undefined;
    const beforeHeadSha = await safelyReadHead(codeCwd);
    let intent: SessionTransformIntent | null = null;
    if ((request.action === 'fork' || request.action === 'rewind') && checkpoint) {
      intent = {
        id: `transform-${randomUUID()}`,
        clientMutationId: request.clientMutationId ?? null,
        action: request.action,
        runtimeId: request.runtimeId,
        originalSessionKey: sessionKey,
        identityId: identityId ?? null,
        checkpointId: checkpoint.id,
        providerCheckpointRef: checkpoint.providerRef,
        expectedCatalogVersion: catalog.version,
        phase: 'prepared',
        startedAt: new Date().toISOString(),
        beforeHeadSha,
        codeCwd: codeCwd || null,
        laneId: lane?.id ?? null,
        packetId: lane?.packetId ?? null,
        result: null,
      };
      await replaceIntent(intent).catch((error) => {
        throw new SessionTransformError(
          'catalog_unavailable',
          error instanceof Error ? error.message : 'Unable to persist transform intent.',
          503,
          true,
        );
      });
      intent = { ...intent, phase: 'provider_started' };
      await replaceIntent(intent).catch((error) => {
        throw new SessionTransformError(
          'catalog_unavailable',
          error instanceof Error ? error.message : 'Unable to mark provider transform start.',
          503,
          true,
        );
      });
    }
    let providerResult;
    try {
      providerResult = await transformSession({
        action: request.action,
        sessionKey,
        identityId,
        providerCheckpointRef: checkpoint?.providerRef,
        operationId: intent?.id,
      });
    } catch (error) {
      throw new SessionTransformError(
        'provider_error',
        error instanceof Error ? error.message : 'Provider connection failed during the transform.',
        502,
        Boolean(intent),
      );
    }
    if (!providerResult.ok) {
      const providerConfirmedNoSideEffect = providerResult.sideEffect === 'none'
        && providerResult.retryable !== true;
      if (intent && providerConfirmedNoSideEffect) {
        await replaceIntent(null, intent.id).catch((error) => {
          throw new SessionTransformError(
            'catalog_unavailable',
            error instanceof Error ? error.message : 'Unable to clear failed transform intent.',
            503,
            true,
          );
        });
      }
      const reason = providerResult.reason === 'stale_checkpoint'
        ? 'stale_checkpoint'
        : providerResult.reason === 'session_not_found'
          ? 'session_not_found'
          : providerResult.reason === 'unsupported'
            ? 'unsupported'
            : 'provider_error';
      throw new SessionTransformError(
        reason,
        providerResult.note,
        reason === 'stale_checkpoint' ? 409 : reason === 'session_not_found' ? 404 : reason === 'unsupported' ? 400 : 502,
        providerResult.retryable,
      );
    }
    const providerSession = providerResult.resultingSession ?? providerResult.originalSession;
    if (identityId && providerSession.identityId && providerSession.identityId !== identityId) {
      throw new SessionTransformError(
        'provider_error',
        'Provider returned a session attributed to a different runtime identity.',
        502,
      );
    }
    const resultingSession = identityId
      ? { ...providerSession, identityId }
      : providerSession;
    if (!resultingSession.sessionKey.trim() || resultingSession.runtimeId !== request.runtimeId) {
      throw new SessionTransformError(
        'provider_error',
        'Provider returned an invalid or cross-runtime session identity.',
        502,
      );
    }
    if (request.action === 'checkpoint' && !providerResult.providerCheckpointRef?.trim()) {
      throw new SessionTransformError(
        'provider_error',
        'Provider returned no durable checkpoint reference.',
        502,
      );
    }
    const afterHeadSha = await safelyReadHead(codeCwd);
    if (intent) {
      intent = {
        ...intent,
        phase: 'provider_succeeded',
        result: {
          note: providerResult.note,
          resultingSession: intentSession(resultingSession),
          providerSessionCreated: providerResult.providerSessionCreated === true,
          afterHeadSha,
        },
      };
      await replaceIntent(intent).catch((error) => {
        throw new SessionTransformError(
          'catalog_unavailable',
          error instanceof Error ? error.message : 'Unable to persist provider continuation identity.',
          503,
          true,
        );
      });
    }
    const headChanged = Boolean(
      lane
      && (request.action === 'fork' || request.action === 'rewind')
      && beforeHeadSha
      && afterHeadSha
      && beforeHeadSha !== afterHeadSha,
    );
    const now = new Date().toISOString();
    const checkpointId = request.action === 'checkpoint' ? `checkpoint-${randomUUID()}` : checkpoint?.id ?? null;
    const next: SessionTransformCatalog = {
      ...catalog,
      version: catalog.version + 1,
      sessions: request.action === 'import'
        ? [...catalog.sessions, catalogSessionFromRuntime(
          sourceSessionForCatalog(discovered, providerResult.originalSession),
          'import',
          null,
        )]
        : request.action === 'fork' || request.action === 'rewind'
          ? [...catalog.sessions, catalogSessionFromRuntime(
            resultingSession,
            request.action,
            {
              action: request.action,
              parentSessionKey: sessionKey,
              checkpointId: checkpoint!.id,
            },
          )]
          : catalog.sessions,
      checkpoints: request.action === 'checkpoint'
        ? [...catalog.checkpoints, {
          id: checkpointId!,
          runtimeId: request.runtimeId,
          sessionKey,
          createdAt: now,
          headSha: afterHeadSha,
          providerRef: providerResult.providerCheckpointRef!,
        }]
        : catalog.checkpoints,
      receipts: catalog.receipts,
    };
    if (sessionIsCataloged(next, request.runtimeId, resultingSession.sessionKey)
      && resultingSession.sessionKey !== sessionKey
      && catalog.sessions.some((session) => session.sessionKey === resultingSession.sessionKey)) {
      throw new SessionTransformError('provider_error', 'Provider returned a session identity already present in the catalog.', 502);
    }
    const receipt: SessionTransformReceipt = {
      id: intent?.id ?? `transform-${randomUUID()}`,
      clientMutationId: request.clientMutationId ?? null,
      action: request.action,
      runtimeId: request.runtimeId,
      originalSessionKey: sessionKey,
      resultingSessionKey: resultingSession.sessionKey,
      checkpointId,
      beforeHeadSha,
      afterHeadSha,
      providerSessionCreated: providerResult.providerSessionCreated === true,
      packetId: lane?.packetId ?? null,
      laneId: lane?.id ?? null,
      staleGovernanceInvalidated: headChanged,
      createdAt: now,
    };
    next.receipts = [...catalog.receipts, receipt];
    await writeSessionTransformCatalog(next).catch((error) => {
      throw new SessionTransformError(
        'catalog_unavailable',
        error instanceof Error ? error.message : 'Unable to persist session lineage.',
        503,
        true,
      );
    });
    if (headChanged && lane && beforeHeadSha && afterHeadSha) {
      invalidateGovernance(lane, beforeHeadSha, afterHeadSha);
    }
    if (intent) await replaceIntent(null, intent.id).catch(() => undefined);
    return {
      ok: true,
      action: request.action,
      note: providerResult.note,
      runtimeId: request.runtimeId,
      originalSessionKey: sessionKey,
      resultingSessionKey: resultingSession.sessionKey,
      checkpointId,
      catalogVersion: next.version,
      providerSessionCreated: providerResult.providerSessionCreated === true,
      beforeHeadSha,
      afterHeadSha,
      staleGovernanceInvalidated: headChanged,
    };
  });
}
