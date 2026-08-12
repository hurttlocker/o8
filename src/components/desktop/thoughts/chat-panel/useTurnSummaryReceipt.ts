'use client';

import { useEffect, useRef, useState } from 'react';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import type { OrchestratorMissionState } from '@/lib/orchestrator/types';
import { isFileEditCall } from './file-edits';
import type { TurnSummary } from './TurnSummaryCard';

interface TurnStreamReceiptSource {
  status: 'connecting' | 'ready' | 'busy' | 'error' | 'dead';
  runningTotal: number;
  fetchTelemetrySnapshot: () => Promise<{
    totalTokens: number | null;
    estimatedCostUsd: number | null;
    model: string | null;
  }>;
}

interface MissionFunnelSnapshot {
  totalDurationMs?: number | null;
  terminalPacketCount?: number;
  attemptCount?: number;
  retryCount?: number;
  interventionCount?: number;
  recoveryEventCount?: number;
  strictAutonomousCloseCount?: number;
  governedAutonomousCloseCount?: number;
  packets?: unknown[];
}

export async function fetchMissionReceipt(missionId: string, includeTiming = false): Promise<{
  costUsd: number | null;
  funnel: TurnSummary['missionFunnel'];
}> {
  try {
    const response = await fetch(`/api/orchestrator/status?missionId=${encodeURIComponent(missionId)}&includeCost=true${includeTiming ? '&includeTiming=true' : ''}`, {
      cache: 'no-store',
    });
    if (!response.ok) return { costUsd: null, funnel: null };
    const envelope = await response.json() as {
      result?: { cost?: { totalCostUsd?: number | null } | null; funnel?: MissionFunnelSnapshot | null };
      cost?: { totalCostUsd?: number | null } | null;
      funnel?: MissionFunnelSnapshot | null;
    };
    const payload = envelope.result ?? envelope;
    const funnel = payload.funnel;
    return {
      costUsd: typeof payload.cost?.totalCostUsd === 'number'
      ? Math.max(0, payload.cost.totalCostUsd)
        : null,
      funnel: funnel ? {
        totalDurationMs: typeof funnel.totalDurationMs === 'number' ? funnel.totalDurationMs : null,
        terminalPacketCount: funnel.terminalPacketCount ?? 0,
        packetCount: funnel.packets?.length ?? 0,
        attemptCount: funnel.attemptCount ?? 0,
        retryCount: funnel.retryCount ?? 0,
        interventionCount: funnel.interventionCount ?? 0,
        recoveryEventCount: funnel.recoveryEventCount ?? 0,
        strictAutonomousCloseCount: funnel.strictAutonomousCloseCount ?? 0,
        governedAutonomousCloseCount: funnel.governedAutonomousCloseCount ?? 0,
      } : null,
    };
  } catch {
    return { costUsd: null, funnel: null };
  }
}

async function fetchMissionCostUsd(missionId: string): Promise<number | null> {
  return (await fetchMissionReceipt(missionId)).costUsd;
}

function turnCostTotal(orchestratorCostUsd: number | null, childCostUsd: number | null) {
  if (orchestratorCostUsd == null && childCostUsd == null) return null;
  return Number(((orchestratorCostUsd ?? 0) + (childCostUsd ?? 0)).toFixed(6));
}

export function useTurnSummaryReceipt(input: {
  displayMessages: MobileTranscriptEntry[];
  isChatMode: boolean;
  isOrchestratorMode: boolean;
  missionState: OrchestratorMissionState;
  repoPath: string | null;
  stream: TurnStreamReceiptSource;
  threadId: string | null;
}): TurnSummary | null {
  const [turnSummary, setTurnSummary] = useState<TurnSummary | null>(null);
  const fetchTelemetryRef = useRef(input.stream.fetchTelemetrySnapshot);
  fetchTelemetryRef.current = input.stream.fetchTelemetrySnapshot;
  const missionStateRef = useRef(input.missionState);
  missionStateRef.current = input.missionState;
  const turnStartRef = useRef<{
    startedAt: number;
    messageCountAtStart: number;
    runningTotalAtStart: number;
    missionIdAtStart: string | null;
    costAtStart: Promise<number | null>;
    childCostAtStart: Promise<number | null>;
  } | null>(null);
  const previousStatusRef = useRef(input.stream.status);

  useEffect(() => {
    if (!input.isOrchestratorMode || input.isChatMode) {
      previousStatusRef.current = input.stream.status;
      return;
    }
    const previousStatus = previousStatusRef.current;
    const nextStatus = input.stream.status;
    previousStatusRef.current = nextStatus;

    if (previousStatus !== 'busy' && nextStatus === 'busy') {
      setTurnSummary(null);
      const missionIdAtStart = missionStateRef.current.missionId?.trim() || null;
      turnStartRef.current = {
        startedAt: Date.now(),
        messageCountAtStart: input.displayMessages.length,
        runningTotalAtStart: input.stream.runningTotal,
        missionIdAtStart,
        costAtStart: fetchTelemetryRef.current()
          .then((snapshot) => snapshot.estimatedCostUsd)
          .catch(() => null),
        childCostAtStart: missionIdAtStart
          ? fetchMissionCostUsd(missionIdAtStart)
          : Promise.resolve(null),
      };
      return;
    }

    if (previousStatus !== 'busy' || nextStatus !== 'ready') return;
    const start = turnStartRef.current;
    if (!start) return;
    const newEntries = input.displayMessages.slice(start.messageCountAtStart);
    if (newEntries.length === 0) return;

    const toolNamesAll: string[] = [];
    let toolCount = 0;
    let firstAssistantId: string | null = null;
    let lastAssistantId: string | null = null;
    let turnHadEdits = false;
    for (const entry of newEntries) {
      if (entry.role === 'assistant') {
        firstAssistantId ??= entry.id;
        lastAssistantId = entry.id;
      }
      for (const call of entry.toolCalls ?? []) {
        toolCount += 1;
        const name = call.name?.trim();
        if (name) toolNamesAll.push(name);
        if (isFileEditCall(call)) turnHadEdits = true;
      }
    }
    if (!lastAssistantId) return;

    const distinctNames = [...new Set(toolNamesAll)];
    const currentMission = missionStateRef.current;
    const currentMissionId = currentMission.missionId?.trim() || null;
    const attributedMissionId = currentMissionId
      && currentMission.packets.some((packet) => (
        packet.orchestratorThreadId === input.threadId
        || packet.launchContext?.parentThreadId === input.threadId
      ))
      ? currentMissionId
      : null;
    const summary: TurnSummary = {
      assistantMessageId: lastAssistantId,
      firstAssistantMessageId: firstAssistantId,
      elapsedMs: Math.max(0, Date.now() - start.startedAt),
      toolCount,
      toolNames: distinctNames.slice(0, 3),
      toolNameTotal: distinctNames.length,
      filesEditedCount: 0,
      filePaths: [],
      tokensUsed: Math.max(0, input.stream.runningTotal - start.runningTotalAtStart),
      costUsd: null,
      orchestratorCostUsd: null,
      childCostUsd: null,
      childCostAtStartUsd: null,
      missionId: attributedMissionId,
      missionIdAtStart: start.missionIdAtStart,
      repoPath: input.repoPath,
    };
    setTurnSummary(summary);
    turnStartRef.current = null;

    void start.childCostAtStart.then((childCostAtStartUsd) => {
      setTurnSummary((current) => current?.assistantMessageId === lastAssistantId
        ? { ...current, childCostAtStartUsd }
        : current);
    });

    void Promise.all([
      start.costAtStart,
      fetchTelemetryRef.current().then((snapshot) => snapshot.estimatedCostUsd).catch(() => null),
    ]).then(([before, after]) => {
      const orchestratorCostUsd = before == null || after == null
        ? null
        : Math.max(0, Number((after - before).toFixed(6)));
      setTurnSummary((current) => current?.assistantMessageId === lastAssistantId
        ? {
            ...current,
            orchestratorCostUsd,
            costUsd: turnCostTotal(orchestratorCostUsd, current.childCostUsd ?? null),
          }
        : current);
    });

    if (input.repoPath && turnHadEdits) {
      const targetAssistantId = lastAssistantId;
      void fetch(`/api/review/workspace?workspace=${encodeURIComponent(input.repoPath)}&strictBranch=1`)
        .then(async (response) => response.ok
          ? await response.json() as { changedFiles?: Array<{ path?: string }> }
          : null)
        .then((snapshot) => {
          if (!snapshot) return;
          const filePaths = (snapshot.changedFiles ?? [])
            .map((file) => file.path)
            .filter((value): value is string => typeof value === 'string' && value.length > 0);
          setTurnSummary((current) => current?.assistantMessageId === targetAssistantId
            ? { ...current, filesEditedCount: filePaths.length, filePaths }
            : current);
        })
        .catch(() => {});
    }
  }, [
    input.displayMessages,
    input.isChatMode,
    input.isOrchestratorMode,
    input.repoPath,
    input.stream.runningTotal,
    input.stream.status,
    input.threadId,
  ]);

  useEffect(() => {
    if (!turnSummary || turnSummary.missionId) return;
    const currentMissionId = input.missionState.missionId?.trim() || null;
    if (
      !currentMissionId
      || currentMissionId === turnSummary.missionIdAtStart
      || !input.missionState.packets.some((packet) => (
        packet.orchestratorThreadId === input.threadId
        || packet.launchContext?.parentThreadId === input.threadId
      ))
    ) return;
    setTurnSummary((current) => current && !current.missionId
      ? { ...current, missionId: currentMissionId }
      : current);
  }, [input.missionState, input.threadId, turnSummary]);

  const missionId = turnSummary?.missionId ?? null;
  const assistantMessageId = turnSummary?.assistantMessageId ?? null;
  const childCostAtStartUsd = turnSummary?.childCostAtStartUsd ?? null;
  useEffect(() => {
    if (!missionId || !assistantMessageId) return;
    void fetchMissionReceipt(missionId, true).then(({ costUsd: childCostUsd, funnel }) => {
      setTurnSummary((current) => {
        if (current?.assistantMessageId !== assistantMessageId) return current;
        const baseline = missionId === current.missionIdAtStart
          ? current.childCostAtStartUsd
          : 0;
        const attributedChildCostUsd = childCostUsd == null || baseline == null
          ? current.childCostUsd ?? null
          : Math.max(0, Number((childCostUsd - baseline).toFixed(6)));
        return {
          ...current,
          childCostUsd: attributedChildCostUsd,
          costUsd: turnCostTotal(current.orchestratorCostUsd ?? null, attributedChildCostUsd),
          missionFunnel: funnel,
        };
      });
    });
  }, [assistantMessageId, childCostAtStartUsd, input.missionState.updatedAt, missionId]);

  useEffect(() => {
    setTurnSummary(null);
    turnStartRef.current = null;
  }, [input.isChatMode, input.isOrchestratorMode, input.repoPath, input.threadId]);

  return turnSummary;
}
