import type { Dispatch, SetStateAction } from 'react';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import {
  formatTimestampLabel,
  type OrchestratorStreamStatus,
} from './shared';

interface RefLike<T> {
  current: T;
}

export interface CurrentAssistantStreamState {
  id: string;
  chunks: string[];
  thinkingChunks: string[];
  epoch: number;
}

interface CreateOrchestratorMessageHandlerOptions {
  captureFirstTurnPlanRef: RefLike<boolean>;
  currentWs: WebSocket;
  currentAssistantRef: RefLike<CurrentAssistantStreamState | null>;
  eventCountRef: RefLike<number>;
  finalizeFirstTurnPlanCapture: () => void;
  firstTurnPlanChunksRef: RefLike<string[]>;
  firstTurnPlanStartedRef: RefLike<boolean>;
  flushCurrentAssistant: () => void;
  lastEventAtRef: RefLike<number>;
  messagesRef: RefLike<MobileTranscriptEntry[]>;
  resetEpochRef: RefLike<number>;
  setMessages: Dispatch<SetStateAction<MobileTranscriptEntry[]>>;
  setStatus: Dispatch<SetStateAction<OrchestratorStreamStatus>>;
  statusRef: RefLike<OrchestratorStreamStatus>;
  wsRef: RefLike<WebSocket | null>;
}

function createAssistantState(resetEpochRef: RefLike<number>): CurrentAssistantStreamState {
  return {
    id: `orch-assistant-${Date.now()}`,
    chunks: [],
    thinkingChunks: [],
    epoch: resetEpochRef.current,
  };
}

export function createOrchestratorMessageHandler(
  options: CreateOrchestratorMessageHandlerOptions,
) {
  return (event: MessageEvent) => {
    if (options.currentWs !== options.wsRef.current) return;

    let msg: { channel?: string; event?: string; data?: Record<string, unknown> };
    try {
      msg = JSON.parse(typeof event.data === 'string' ? event.data : '');
    } catch {
      return;
    }

    if (msg.channel !== 'orchestrator') return;

    options.eventCountRef.current += 1;
    options.lastEventAtRef.current = Date.now();

    switch (msg.event) {
      case 'output': {
        const text = typeof msg.data?.text === 'string' ? msg.data.text : '';
        if (!text) break;
        const isThinking = msg.data?.thinking === true;

        if (!isThinking && options.captureFirstTurnPlanRef.current) {
          if (options.firstTurnPlanStartedRef.current || text.trim()) {
            options.firstTurnPlanStartedRef.current = true;
            options.firstTurnPlanChunksRef.current.push(text);
          }
        }

        if (!options.currentAssistantRef.current) {
          if (options.statusRef.current !== 'busy') break;
          options.currentAssistantRef.current = createAssistantState(options.resetEpochRef);
        } else if (options.currentAssistantRef.current.epoch !== options.resetEpochRef.current) {
          options.currentAssistantRef.current = null;
          break;
        }

        if (isThinking) {
          options.currentAssistantRef.current.thinkingChunks.push(text);
        } else {
          options.currentAssistantRef.current.chunks.push(text);
        }
        options.flushCurrentAssistant();

        if (options.statusRef.current !== 'busy') options.setStatus('busy');
        break;
      }

      case 'status': {
        const newStatus = msg.data?.status as string | undefined;
        if (newStatus === 'ready' || newStatus === 'busy' || newStatus === 'dead') {
          if (
            newStatus === 'busy'
            && options.statusRef.current !== 'busy'
            && options.currentAssistantRef.current === null
            && options.messagesRef.current.length === 0
          ) {
            break;
          }
          options.statusRef.current = newStatus;
          options.setStatus(newStatus);

          if (newStatus === 'ready' && options.currentAssistantRef.current) {
            options.finalizeFirstTurnPlanCapture();
            options.flushCurrentAssistant();
            const finalId = options.currentAssistantRef.current.id;
            options.setMessages((prev) => prev.map((message) =>
              message.id === finalId && message.toolCalls?.some((tool) => tool.status === 'running')
                ? { ...message, toolCalls: message.toolCalls!.map((tool) => (tool.status === 'running' ? { ...tool, status: 'done' } : tool)) }
                : message,
            ));
            options.currentAssistantRef.current = null;
          }
          if (newStatus === 'dead') {
            options.finalizeFirstTurnPlanCapture();
          }
        } else if (newStatus === 'starting') {
          options.statusRef.current = 'connecting';
          options.setStatus('connecting');
        }
        break;
      }

      case 'agent-update': {
        const update = msg.data as {
          surfaceId?: string;
          name?: string;
          status?: string;
          detail?: string;
          duration?: number;
          repoPath?: string;
          prompt?: string;
        } | undefined;
        if (!update?.surfaceId) break;
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('cortex:agent-supervisor-update', { detail: update }));
        }
        break;
      }

      case 'tool-use': {
        const toolName = typeof msg.data?.name === 'string' ? msg.data.name : 'unknown';
        options.finalizeFirstTurnPlanCapture();

        if (!options.currentAssistantRef.current) {
          if (options.statusRef.current !== 'busy') break;
          options.currentAssistantRef.current = createAssistantState(options.resetEpochRef);
        }

        const current = options.currentAssistantRef.current;
        const toolCall = { name: toolName, status: 'running' as const };
        options.setMessages((prev) => {
          const idx = prev.findIndex((message) => message.id === current.id);
          if (idx >= 0) {
            const next = [...prev];
            const existing = next[idx];
            const existingTools = existing.toolCalls ?? [];
            const updatedTools = existingTools.map((tool) =>
              tool.status === 'running' ? { ...tool, status: 'done' as const } : tool,
            );
            next[idx] = { ...existing, toolCalls: [...updatedTools, toolCall] };
            return next;
          }
          return [...prev, {
            id: current.id,
            role: 'assistant' as const,
            text: '',
            toolCalls: [toolCall],
            timestamp: Date.now(),
            timestampLabel: formatTimestampLabel(Date.now()),
          }];
        });

        if (options.statusRef.current !== 'busy') options.setStatus('busy');
        break;
      }

      case 'error': {
        if (options.statusRef.current !== 'busy' && options.messagesRef.current.length === 0) break;
        const error = typeof msg.data?.error === 'string' ? msg.data.error : 'Unknown error';
        console.error('[orchestrator-stream] Error:', error);
        options.finalizeFirstTurnPlanCapture();
        options.setStatus('error');
        options.setMessages((prev) => [...prev, {
          id: `orch-error-${Date.now()}`,
          role: 'system',
          text: `Orchestrator error: ${error}`,
          timestamp: Date.now(),
          timestampLabel: formatTimestampLabel(Date.now()),
        }]);
        break;
      }
    }
  };
}
