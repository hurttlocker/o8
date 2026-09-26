import { randomUUID } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';
import type { AgentSetupRequest, SetupRequestStatus } from './agent-request';

const file = () => join(getDataDir(), 'agent-setup-request.json');
export function readAgentSetupRequest(): AgentSetupRequest | null {
  try {
    const request = JSON.parse(readFileSync(file(), 'utf8')) as AgentSetupRequest;
    return request.status === 'applying' && (!request.leaseExpiresAt || Date.parse(request.leaseExpiresAt) <= Date.now())
      ? { ...request, status: 'interrupted', error: 'The app stopped confirming this request. Inspect the workspace before retrying.' } : request;
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
function save(request: AgentSetupRequest): AgentSetupRequest {
  const target = file();
  const temp = `${target}.${randomUUID()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(request)}\n`, { mode: 0o600 });
  renameSync(temp, target);
  return readAgentSetupRequest()!;
}
export function queueAgentSetupRequest(project: AgentSetupRequest['project']): AgentSetupRequest {
  const current = readAgentSetupRequest();
  if (current && ['pending', 'applying'].includes(current.status)) {
    if (current.project.id === project.id) return current;
    throw new Error('Another project opening is pending. Read its status or cancel it first.');
  }
  return save({ id: randomUUID(), project, status: 'pending', updatedAt: new Date().toISOString() });
}
export function updateAgentSetupRequest(id: string, status: SetupRequestStatus, error?: string, claimId?: string): AgentSetupRequest {
  const current = readAgentSetupRequest();
  if (!current || current.id !== id) throw new Error('Setup request no longer matches. Read status again.');
  if (['opened', 'needs_tools', 'needs_privacy', 'error'].includes(status) && (!claimId || current.claimId !== claimId)) throw new Error('The app claim no longer matches.');
  if (current.status === status && status !== 'applying') return current;
  if (status === 'applying' && !['pending', 'needs_tools', 'needs_privacy', 'error', 'interrupted'].includes(current.status)) throw new Error('Setup request is no longer pending.');
  if (status === 'cancelled' && current.status === 'applying') throw new Error('The app is already opening this project. Read status before retrying.');
  if (['opened', 'needs_tools', 'needs_privacy', 'error'].includes(status)
    && !['applying', 'needs_tools', 'needs_privacy', 'error'].includes(current.status)) {
    throw new Error('Setup request cannot accept this result.');
  }
  if (status === 'cancelled' && current.status === 'opened') throw new Error('This project is already open.');
  const { error: _previousError, leaseExpiresAt: _lease, ...base } = current;
  return save({ ...base, status, updatedAt: new Date().toISOString(), ...(error ? { error } : {}), ...(status === 'applying' ? { claimId: randomUUID(), leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() } : {}) });
}

export function renewAgentSetupClaim(id: string, claimId: string): AgentSetupRequest {
  const current = readAgentSetupRequest();
  if (!current || current.id !== id || current.claimId !== claimId || current.status !== 'applying') throw new Error('The app claim is no longer active.');
  return save({ ...current, leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() });
}
