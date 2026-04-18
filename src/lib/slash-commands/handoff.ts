import { formatModelLabel } from '@/lib/format';
import { buildSlashCommandEntry, excerptTranscriptEntries } from './shared';
import type { ParsedOrchestratorSlashCommand, SlashCommandContext, SlashCommandExecutionResult } from './types';

export async function handleHandoffSlashCommand(
  command: ParsedOrchestratorSlashCommand,
  context: SlashCommandContext,
): Promise<SlashCommandExecutionResult> {
  const nextModel = command.args.trim() || 'fresh session';
  if (!nextModel) {
    context.appendEntries([
      buildSlashCommandEntry({
        name: 'handoff',
        summary: 'Handoff needs a model id.',
        details: ['Example: /handoff claude-sonnet-4-6', 'Example: /handoff claude-opus-4-7'],
        chips: [{ label: 'argument required', tone: 'amber' }],
      }),
    ]);
    return { handled: true };
  }

  const compacted = await context.compactNow({ keepTailCount: 8, source: 'handoff' });
  const resumePrelude = compacted?.resumePrelude?.trim()
    ? compacted.resumePrelude.trim()
    : [
      'Fresh-session handoff',
      excerptTranscriptEntries(context.transcript.slice(-8), 8, 2600) || 'No existing transcript context is available.',
      'Continue from that context using the next operator message as the active instruction.',
    ].join('\n\n');

  context.queuePrelude(resumePrelude, 'replace');
  await context.resetRemoteSession();
  if (compacted?.applied) {
    context.replaceTranscript([
      ...compacted.transcript,
      buildSlashCommandEntry({
        name: 'handoff',
        summary: 'Prepared a compacted handoff for a fresh orchestrator session.',
        details: ['The remote session was reset and will resume from the queued handoff prelude on the next turn.'],
        chips: [
          { label: formatModelLabel(nextModel), tone: 'blue' },
          { label: 'rehydrated', tone: 'emerald' },
        ],
      }),
    ]);
    return { handled: true };
  }

  context.appendEntries([
    buildSlashCommandEntry({
      name: 'handoff',
      summary: 'Prepared a fresh-session handoff from the current transcript.',
      details: ['The remote session was reset. The next turn will replay the queued handoff prelude before the operator message.'],
      chips: [
        { label: formatModelLabel(nextModel), tone: 'blue' },
        { label: 'rehydrated', tone: 'emerald' },
      ],
    }),
  ]);
  return { handled: true };
}
