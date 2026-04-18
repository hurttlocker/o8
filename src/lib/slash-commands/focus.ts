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
        summary: 'Focus needs a file path or issue reference.',
        details: ['Example: /focus src/lib/orchestrator/store.ts', 'Example: /focus #583'],
        chips: [{ label: 'argument required', tone: 'amber' }],
      }),
    ]);
    return { handled: true };
  }

  const liveMatches = collectFocusedTranscript(context.transcript, scope);
  const archiveMatches = await context.searchArchive(scope, 3);

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
