import { buildSlashCommandEntry, buildRecallPrelude, collectFocusedTranscript, excerptTranscriptEntries } from './shared';
import type { ParsedOrchestratorSlashCommand, SlashCommandContext, SlashCommandExecutionResult } from './types';

export async function handleFocusSlashCommand(
  command: ParsedOrchestratorSlashCommand,
  context: SlashCommandContext,
): Promise<SlashCommandExecutionResult> {
  const scope = command.args.trim();
  if (!scope) {
    context.appendEntries([
      buildSlashCommandEntry({
        name: 'focus',
        summary: 'Focus needs a packet label or packet id.',
        details: ['Example: /focus P1', 'Example: /focus pkt-abc123'],
        chips: [{ label: 'argument required', tone: 'amber' }],
      }),
    ]);
    return { handled: true };
  }

  const scopeKey = scope.toLowerCase();
  const packet = context.missionState.packets.find((candidate) => candidate.referenceLabel.toLowerCase() === scopeKey || candidate.id.toLowerCase() === scopeKey);
  if (!packet) {
    context.appendEntries([buildSlashCommandEntry({ name: 'focus', summary: `No packet matched "${scope}".`, chips: [{ label: 'unknown packet', tone: 'amber' }] })]);
    return { handled: true };
  }

  const focusQuery = [packet.referenceLabel, packet.id, packet.title, packet.summary, packet.workspaceTargetPath].filter(Boolean).join(' ');
  const liveMatches = collectFocusedTranscript(context.transcript, focusQuery);
  const archiveMatches = await context.searchArchive(focusQuery, 3);

  if (liveMatches.length === 0 && archiveMatches.length === 0) {
    context.appendEntries([
      buildSlashCommandEntry({
        name: 'focus',
        summary: `No live or archived context matched "${scope}".`,
        chips: [{ label: 'unchanged', tone: 'slate' }],
      }),
    ]);
    return { handled: true };
  }

  const nextTranscript = liveMatches.length > 0 ? liveMatches : context.transcript.slice(-4);
  const preludeSections = [
    `Focused scope: ${scope}`,
    excerptTranscriptEntries(nextTranscript, 8, 2600) || 'Live thread context unavailable.',
  ];
  if (archiveMatches.length > 0) {
    preludeSections.push(buildRecallPrelude(scope, archiveMatches.slice(0, 2)));
  }
  preludeSections.push('Ignore unrelated thread history unless the next operator message asks for it explicitly.');

  context.queuePrelude(preludeSections.join('\n\n'), 'replace');
  await context.resetRemoteSession();
  context.replaceTranscript([
    ...nextTranscript,
    buildSlashCommandEntry({
      name: 'focus',
      summary: `Focused the thread on "${scope}".`,
      details: [
        `${nextTranscript.length} live turn${nextTranscript.length === 1 ? '' : 's'} kept in the visible thread.`,
        archiveMatches.length > 0
          ? `${archiveMatches.length} archived match${archiveMatches.length === 1 ? '' : 'es'} queued for the next turn.`
          : 'No archived matches were needed.',
      ],
      chips: [
        { label: scope, tone: 'blue' },
        { label: `${nextTranscript.length} live`, tone: 'slate' },
        ...(archiveMatches.length > 0 ? [{ label: `${archiveMatches.length} recalled`, tone: 'emerald' as const }] : []),
      ],
    }),
  ]);
  return { handled: true };
}
