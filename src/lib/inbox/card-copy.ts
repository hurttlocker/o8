import type { ApprovalRecord } from '@/lib/approvals/types';
import type { SupervisorInboxItem } from '@/lib/supervisor/inbox';

export interface InboxCardCopy {
  headline: string;
  subline: string;
}

function clean(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function basename(value: string | null | undefined): string | null {
  const raw = clean(value);
  if (!raw) return null;
  return raw.split('/').filter(Boolean).pop() ?? raw;
}

function uniq(values: Array<string | null | undefined>): string[] {
  return Array.from(new Set(values.map((value) => clean(value)).filter((value): value is string => Boolean(value))));
}

function joinMetadata(parts: Array<string | null | undefined>): string {
  const values = uniq(parts);
  return values.length > 0 ? values.join(' · ') : 'Details unavailable.';
}

function issueRefsFromText(...values: Array<string | null | undefined>): string[] {
  return uniq(values.flatMap((value) => clean(value)?.match(/#\d+/g) ?? []));
}

function itemPacketLabel(item: SupervisorInboxItem): string | null {
  if (item.packetReferenceLabel && item.packetTitle) {
    return `${item.packetReferenceLabel}: ${item.packetTitle}`;
  }
  return item.packetTitle ?? item.packetReferenceLabel;
}

function supervisorMetadata(item: SupervisorInboxItem, extras: Array<string | null | undefined> = []): string {
  return joinMetadata([
    itemPacketLabel(item),
    ...extras,
    basename(item.repoPath),
    item.worktreePath,
    ...issueRefsFromText(item.packetTitle, item.errorExcerpt),
  ]);
}

export function composeSupervisorInboxCardCopy(item: SupervisorInboxItem): InboxCardCopy {
  const verificationKind = clean(item.payload.verificationKind);
  const worktree = clean(item.worktreePath ?? item.repoPath);

  switch (item.kind) {
    case 'silent_exit_verification_failed':
      return {
        headline: 'The worker finished but o8 could not verify its work; review the diff and approve or retry.',
        subline: supervisorMetadata(item, [verificationKind, item.errorExcerpt, worktree]),
      };
    case 'silent_exit_no_work':
      return {
        headline: 'The worker stopped without producing changes; retry the packet or close it.',
        subline: supervisorMetadata(item, [worktree]),
      };
    case 'silent_exit_but_work_present':
      return {
        headline: 'The worker stopped early, but o8 found saved work ready for review.',
        subline: supervisorMetadata(item, [verificationKind, worktree]),
      };
    case 'verification_failed':
      return {
        headline: 'The worker made changes, but verification failed; review the error and decide whether to retry.',
        subline: supervisorMetadata(item, [verificationKind, item.errorExcerpt]),
      };
    case 'session_lost':
      return {
        headline: 'The worker session disconnected; resume it or archive the lane.',
        subline: supervisorMetadata(item, [worktree]),
      };
    case 'packet_missing':
      return {
        headline: 'o8 could not find the packet record; inspect the lane before merging or retrying.',
        subline: supervisorMetadata(item, [worktree]),
      };
    case 'bounded_retry_exhausted':
      return {
        headline: 'Automatic retry hit its limit; choose whether to retry manually or stop the packet.',
        subline: supervisorMetadata(item, [item.errorExcerpt]),
      };
    case 'merge_blocked':
      return {
        headline: 'The merge is blocked; review the conflict or failed check before approving.',
        subline: supervisorMetadata(item, [item.errorExcerpt]),
      };
    case 'fetch_unreachable':
      return {
        headline: 'o8 could not reach the remote repository; fix access or network state, then retry.',
        subline: supervisorMetadata(item, [item.errorExcerpt]),
      };
    case 'repo_misconfigured':
      return {
        headline: 'The repository setup is incomplete; fix the repo configuration before retrying.',
        subline: supervisorMetadata(item, [item.errorExcerpt]),
      };
    case 'launch_agent_crash_loop':
      return {
        headline: 'An o8 background service is restarting repeatedly; inspect its LaunchAgent logs before retrying it.',
        subline: supervisorMetadata(item, [item.errorExcerpt]),
      };
    case 'worker_quota_exhausted':
      return {
        headline: `The selected worker subscription is exhausted; rerun on ${clean(item.payload.suggestedRuntime) ?? 'the equal-tier runtime from the other house'}.`,
        subline: supervisorMetadata(item, [
          clean(item.payload.fromModel),
          clean(item.payload.suggestedModel),
          item.errorExcerpt,
        ]),
      };
    default:
      return {
        headline: itemPacketLabel(item) ?? item.errorExcerpt,
        subline: supervisorMetadata(item, [item.errorExcerpt]),
      };
  }
}

function approvalFiles(approval: ApprovalRecord): string[] {
  return uniq([
    approval.diff?.path,
    ...(approval.diff?.files ?? []).map((file) => file.path),
    ...(approval.conflictReport?.files ?? []),
    ...(approval.gateResult?.violations ?? []).map((violation) => violation.file),
    approval.metadata?.Path,
    approval.metadata?.File,
  ]);
}

function fileSizeViolation(approval: ApprovalRecord): { file: string; lines: string | null } | null {
  const violation = approval.gateResult?.violations.find((candidate) => (
    candidate.file
    && /file[-_ ]?size|large file|\blines?\b/i.test(`${candidate.label} ${candidate.detail}`)
  ));
  if (!violation?.file) return null;
  const lineMatch = `${violation.label} ${violation.detail}`.match(/([\d,]+)\s*lines?\b/i);
  return { file: violation.file, lines: lineMatch?.[1] ?? null };
}

function approvalMetadata(approval: ApprovalRecord, extras: Array<string | null | undefined> = []): string {
  const files = approvalFiles(approval);
  return joinMetadata([
    approval.metadata?.Packet ? `Packet ${approval.metadata.Packet}` : null,
    approval.metadata?.Lane ? `Lane ${approval.metadata.Lane}` : null,
    approval.metadata?.Branch,
    ...extras,
    ...files.slice(0, 3),
    files.length > 3 ? `+${files.length - 3} more files` : null,
    ...issueRefsFromText(approval.title, approval.description, approval.summary, approval.metadata?.Issue),
  ]);
}

export function composeApprovalCardCopy(approval: ApprovalRecord): InboxCardCopy {
  const fileSize = fileSizeViolation(approval);
  if (approval.policyRuleId === 'file_size_limit' || fileSize) {
    const filePart = fileSize
      ? `${fileSize.file}${fileSize.lines ? `, ${fileSize.lines} lines` : ''}`
      : approvalFiles(approval)[0] ?? 'a large file';
    return {
      headline: `This change touches a large file (${filePart}); o8 wants your OK before merging.`,
      subline: approvalMetadata(approval, [approval.title]),
    };
  }

  if (approval.conflictReport?.files.length) {
    return {
      headline: 'The merge has conflicts; choose a resolution strategy before o8 continues.',
      subline: approvalMetadata(approval, [approval.conflictReport.mergeError ?? approval.title]),
    };
  }

  if (approval.policyRuleId === 'merge-gate-violation' || approval.gateResult?.violations.length) {
    const blockerCount = approval.gateResult?.violations.filter((violation) => violation.severity === 'block').length ?? 0;
    return {
      headline: blockerCount > 0
        ? `The merge gate found ${blockerCount} blocker${blockerCount === 1 ? '' : 's'}; review the diff before approving.`
        : 'The merge gate found warnings; review the diff before approving.',
      subline: approvalMetadata(approval, [approval.title]),
    };
  }

  if (approval.continuation?.kind === 'lane') {
    if (approval.continuation.verb === 'merge') {
      return {
        headline: 'A worker is ready to merge; review the files and approve or reject.',
        subline: approvalMetadata(approval, [approval.title]),
      };
    }
    if (approval.continuation.verb === 'create_pr') {
      return {
        headline: 'A worker wants to open a pull request; review the changes and approve or reject.',
        subline: approvalMetadata(approval, [approval.title]),
      };
    }
    return {
      headline: 'A worker session needs permission to continue; resume it or reject the request.',
      subline: approvalMetadata(approval, [approval.title]),
    };
  }

  if (approval.continuation?.kind === 'plan') {
    return {
      headline: 'o8 is asking to dispatch planned work; review the issue and approve or reject.',
      subline: approvalMetadata(approval, [`#${approval.continuation.issueNumber}`, approval.continuation.issueTitle]),
    };
  }

  if (approval.continuation?.kind === 'spec-update') {
    return {
      headline: 'A worker proposed a spec update; review it before future dispatches use it.',
      subline: approvalMetadata(approval, [approval.continuation.packetId, approval.title]),
    };
  }

  if (approval.continuation?.kind === 'llm-chat') {
    return {
      headline: approval.command
        ? 'Chat wants to run a command; review it before allowing execution.'
        : 'Chat wants to change files; review the file details before allowing it.',
      subline: approvalMetadata(approval, [approval.toolName, approval.command]),
    };
  }

  if (approval.toolName === 'orchestrator_second_pass') {
    return {
      headline: 'A second reviewer did not agree with the merge; inspect the finding before continuing.',
      subline: approvalMetadata(approval, [approval.summary]),
    };
  }

  return {
    headline: approval.title,
    subline: approvalMetadata(approval, [approval.agent, approval.runtime, approval.sessionKey]),
  };
}
