'use client';

import { memo } from 'react';
import { DesktopAgentMessage } from '@/components/desktop/DesktopAgentMessage';
import { PacketHeaderCard } from '@/components/desktop/workspace-terminal/PacketHeaderCard';
import { WorkspaceTranscriptEventExtras } from '@/components/desktop/workspace-terminal/chat-renderers/WorkspaceTranscriptEventExtras';
import { looksLikePacketPrompt } from '@/components/desktop/workspace-terminal/workspace-chat-prompt';
import type { ClaudePermissionDecision } from '@/components/desktop/workspace-terminal/workspace-stream-events';
import type { ClaudeCodeStreamJsonChatEvent } from '@/lib/claude-code/stream-json-parser';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';
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
    };

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

export const WorkspaceTranscript = memo(function WorkspaceTranscript({
  entries,
  packetHeader,
  repoPath,
  markLast = true,
  isStreaming = false,
  onRunInTerminal,
  onPermissionDecision,
}: WorkspaceTranscriptProps) {
  const renderItems = composeWorkspaceChatTranscript(entries, packetHeader);

  return renderItems.map((item) => {
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
