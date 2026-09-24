'use client';

import { memo } from 'react';
import { DesktopAgentMessage } from '@/components/desktop/DesktopAgentMessage';
import { PacketHeaderCard } from '@/components/desktop/workspace-terminal/PacketHeaderCard';
import { AgentPeerMessageCard } from '@/components/desktop/workspace-terminal/AgentPeerMessageCard';
import { WorkspaceTranscriptEventExtras } from '@/components/desktop/workspace-terminal/chat-renderers/WorkspaceTranscriptEventExtras';
import { looksLikePacketPrompt } from '@/components/desktop/workspace-terminal/workspace-chat-prompt';
import type { ClaudePermissionDecision } from '@/components/desktop/workspace-terminal/workspace-stream-events';
import type { ClaudeCodeStreamJsonChatEvent } from '@/lib/claude-code/stream-json-parser';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import type { AgentMessage } from '@/lib/agents/types';
import type { WorkerLaunchContext } from '@/lib/orchestrator/types';

type PermissionRequest = Extract<ClaudeCodeStreamJsonChatEvent, { type: 'permission_request' }>;

export interface WorkspaceTranscriptHeader {
  enabled: boolean;
  title: string;
  branch?: string | null;
  runtime?: string | null;
  status?: string | null;
  repo?: string | null;
  launchContext?: WorkerLaunchContext | null;
}

interface WorkspaceTranscriptProps {
  entries: MobileTranscriptEntry[];
  peerMessages?: AgentMessage[];
  peerName?: string;
  packetHeader?: WorkspaceTranscriptHeader;
  repoPath?: string | null;
  markLast?: boolean;
  isStreaming?: boolean;
  onRunInTerminal?: (command: string) => void;
  onPermissionDecision?: (request: PermissionRequest, decision: ClaudePermissionDecision) => Promise<void> | void;
}

export type WorkspaceTranscriptRenderItem =
  | {
      kind: 'packet-header';
      key: string;
      prompt: string;
    }
  | {
      kind: 'message';
      key: string;
      entry: MobileTranscriptEntry;
      isLast: boolean;
    }
  | {
      kind: 'peer-message';
      key: string;
      message: AgentMessage;
    }
  | { kind: 'earlier-peers'; key: string; count: number };

export function composeWorkspaceChatTranscript(
  entries: MobileTranscriptEntry[],
  packetHeader?: WorkspaceTranscriptHeader,
): WorkspaceTranscriptRenderItem[] {
  return entries.map((entry, index) => {
    const isFirstUser = index === 0 && entry.role === 'user';
    const usePacketHeader = isFirstUser
      && (packetHeader?.enabled === true || looksLikePacketPrompt(entry.text));
    if (usePacketHeader) {
      return {
        kind: 'packet-header',
        key: entry.id,
        prompt: entry.text,
      };
    }
    return {
      kind: 'message',
      key: entry.id,
      entry,
      isLast: index === entries.length - 1,
    };
  });
}

/** Keep the split transcript concise while preserving the full bus history in Handoffs. */
export function composeWorkspaceTranscriptWithPeers(
  entries: MobileTranscriptEntry[],
  peerMessages: AgentMessage[],
  packetHeader?: WorkspaceTranscriptHeader,
): WorkspaceTranscriptRenderItem[] {
  const transcript = composeWorkspaceChatTranscript(entries, packetHeader);
  if (peerMessages.length === 0) return transcript;
  const chronologicalPeers = [...peerMessages].sort((a, b) => a.sequence - b.sequence);
  const visiblePeers = chronologicalPeers.slice(-8);
  const combined = [
    ...transcript.map((item, index) => ({
      item,
      timestamp: entries[index]?.timestamp ?? Number.NEGATIVE_INFINITY,
      order: index,
    })),
    ...visiblePeers.map((message, index) => ({
      item: { kind: 'peer-message' as const, key: `peer:${message.id}`, message },
      timestamp: Date.parse(message.timestamp),
      order: entries.length + index,
    })),
  ].sort((a, b) => a.timestamp - b.timestamp || a.order - b.order).map(({ item }) => item);
  const hidden = chronologicalPeers.length - visiblePeers.length;
  return hidden > 0 ? [{ kind: 'earlier-peers', key: 'earlier-peers', count: hidden }, ...combined] : combined;
}

export const WorkspaceTranscript = memo(function WorkspaceTranscript({
  entries,
  peerMessages = [],
  peerName,
  packetHeader,
  repoPath,
  markLast = true,
  isStreaming = false,
  onRunInTerminal,
  onPermissionDecision,
}: WorkspaceTranscriptProps) {
  const renderItems = composeWorkspaceTranscriptWithPeers(entries, peerMessages, packetHeader);

  return renderItems.map((item) => {
    if (item.kind === 'earlier-peers') {
      return <div key={item.key} style={{ color: 'var(--t-text-faint)', fontSize: 10.5 }}>Showing the latest 8 agent messages · {item.count} earlier in Handoffs</div>;
    }
    if (item.kind === 'peer-message') {
      return <AgentPeerMessageCard key={item.key} message={item.message} selfName={peerName ?? ''} />;
    }
    if (item.kind === 'packet-header') {
      return (
        <PacketHeaderCard
          key={item.key}
          title={packetHeader?.title ?? 'Dispatched packet'}
          branch={packetHeader?.branch}
          runtime={packetHeader?.runtime}
          status={packetHeader?.status}
          repo={packetHeader?.repo}
          launchContext={packetHeader?.launchContext}
          prompt={item.prompt}
        />
      );
    }

    return (
      <div
        key={item.key}
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'stretch',
          width: '100%',
        }}
      >
        <DesktopAgentMessage
          entry={item.entry}
          isLast={item.isLast && markLast}
          isStreaming={item.isLast && isStreaming}
          repoPath={repoPath}
          onRunInTerminal={onRunInTerminal}
        />
        <WorkspaceTranscriptEventExtras
          entry={item.entry}
          onPermissionDecision={onPermissionDecision}
        />
      </div>
    );
  });
});
