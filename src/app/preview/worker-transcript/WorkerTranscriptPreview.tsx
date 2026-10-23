'use client';

import { phasedRecordedWorkerActivity, recordedWorkerActivity } from '@/components/desktop/workspace-terminal/fixtures/recorded-worker-activity';
import type { MobileTranscriptEntry, MobileTranscriptToolCall } from '@/lib/mobile/types';
import { ThemeProvider } from '@/lib/theme/context';
import { WorkspaceTranscript } from '@/components/desktop/workspace-terminal/WorkspaceTranscript';
import type { WorkerHandbackData } from '@/components/desktop/workspace-terminal/chat-renderers/WorkerHandback';

const at = Date.now() - 134_000;
const prose = (id: string, text: string, role: 'assistant' | 'user' = 'assistant'): MobileTranscriptEntry => ({ id, role, text });
function activity(id: string, command: string, status: MobileTranscriptToolCall['status'] = 'done', result?: string): MobileTranscriptEntry {
  return { id, role: 'tool', text: '', toolCalls: [{ id, name: 'exec_command', args: { command }, status, result,
    startedAt: at, finishedAt: status === 'running' ? undefined : at + 120_000 }] };
}
const work = [
  activity('read', "cat src/router.ts src/routes.ts src/worker.ts src/session.ts src/events.ts src/types.ts"),
  activity('search', 'rg -n "transcript" src/worker.ts'),
  activity('diff', 'git diff --stat'),
  activity('test', 'npx vitest run tests/router.test.ts'),
  { id: 'edit', role: 'tool' as const, text: '', toolCalls: [{ id: 'edit', name: 'Edit', args: { file_path: 'src/router.ts' }, status: 'done' as const, startedAt: at, finishedAt: at + 120_000 }] },
];
const recordedEntries: MobileTranscriptEntry[] = recordedWorkerActivity.map((sample, index) => ({
  id: `recorded-${index}`, role: 'tool', text: '', toolCalls: [{ ...sample.tool, id: `recorded-${index}`,
    status: sample.exitCode === 130 ? 'stopped' : sample.exitCode ? 'error' : 'done',
    result: sample.exitCode ? `Recorded exit code ${sample.exitCode}.` : undefined }],
}));
const phasedEntries = phasedRecordedWorkerActivity.map(sample => recordedEntries[recordedWorkerActivity.indexOf(sample)]);
const fixtures: Array<{ id: string; title: string; entries: MobileTranscriptEntry[]; busy?: boolean; narrow?: boolean; handback?: WorkerHandbackData }> = [
  { id: 'grouped-real-data', title: 'Recorded catalog arranged in work phases', entries: [...phasedEntries, prose('phased-result', 'All 30 recorded commands and the native edit receipt are preserved. This catalog spans multiple runs; the preview arranges its samples into work phases. Actual transcript order is unchanged.')] },
  { id: 'real-data', title: 'Recorded activity: 30 commands and a native edit receipt', entries: [...recordedEntries, prose('recorded-result', 'Sanitized worker history. Command structure and exit status are preserved. The native file-change receipt supplies the patch tool’s file path.')] },
  { id: 'in-flight', title: 'In-flight trace', busy: true, entries: [prose('ask', 'Check how routing reaches the worker.', 'user'), prose('intro', 'I found the routing boundary. I’m checking the tests before changing it.'), ...work.slice(0, 3), activity('live', "/bin/zsh -lc 'npm test'", 'running')] },
  { id: 'collapsed', title: 'Finished and collapsed', entries: [prose('ask', 'Make the routing update.', 'user'), ...work, prose('final', 'The worker now receives the correct route. All focused tests pass.\n\nThe change is limited to `src/router.ts`.')] },
  { id: 'failed', title: 'Failed command', entries: [activity('test-failed', 'npm test', 'error', 'Permission denied: the fixture directory is read-only.'), activity('check', 'git status --short'), prose('final', 'The test could not create its fixture. I preserved the changes and stopped at that boundary.')] },
  { id: 'markdown', title: 'Long prose with markdown', entries: [prose('ask', 'Explain the change and the remaining checks.', 'user'), ...work.slice(0, 2), prose('final', '# Routing is consistent\n\nThe worker now receives **one route** for each request. The update preserves the original ordering, even when two requests finish at the same time.\n\n## What changed\n\n- Merged the activity records by item ID.\n- Kept operator messages separate from worker prose.\n- Preserved [router.ts](src/router.ts) and the related test file references.\n\n## Verification\n\n1. Reproduced the duplicate activity before the fix.\n2. Ran the focused tests after the update.\n\n```ts\nconst route = resolveRoute(request);\nreturn worker.send(route);\n```\n\n> One remaining check requires the installed runtime.\n\nThe local result is ready for review. No release has been made.')] },
  { id: 'handback', title: 'Handback with diff', entries: [...work, prose('final', 'The routing update is ready. The focused tests and type check passed.')], handback: { files: 4, additions: 128, deletions: 36, prNumber: 42 } },
  { id: 'narrow', title: '320 px pane', narrow: true, entries: [prose('ask', 'Keep the pane readable at this width.', 'user'), ...work, prose('final', 'The trace folds above the result. File names and commands stay within the pane.\n\n- Related steps grouped together\n- Plain worker prose\n- A compact handback')], handback: { files: 4, additions: 128, deletions: 36, diff: 'diff --git a/src/router.ts b/src/router.ts\n--- a/src/router.ts\n+++ b/src/router.ts\n@@ -1 +1 @@\n-oldRoute\n+resolveRoute(request)' } },
];

export function WorkerTranscriptPreview({ selected }: { selected?: string }) {
  return <ThemeProvider>
    <main style={{ boxSizing: 'border-box', minHeight: '100vh', paddingTop: 24, paddingRight: 0, paddingBottom: 24, paddingLeft: 0,
      background: 'var(--t-canvas-bg)', color: 'var(--t-text)', fontFamily: 'var(--font-sans-system)' }}>
      {(selected ? fixtures.filter(fixture => fixture.id === selected) : fixtures).map(fixture => <section key={fixture.id} data-fixture={fixture.id}
        style={{ boxSizing: 'border-box', width: fixture.narrow ? 320 : '100%', maxWidth: '100%', marginLeft: 'auto', marginRight: 'auto', marginBottom: 24 }}>
        <div style={{ marginLeft: 12, marginRight: 12, marginBottom: 8, color: 'var(--t-text-muted)', fontSize: 12, fontWeight: 300 }}>{fixture.title}</div>
        <div style={{ boxSizing: 'border-box', width: '100%', maxWidth: fixture.narrow ? 320 : 720, marginLeft: 'auto', marginRight: 'auto', paddingTop: 16, paddingRight: 12, paddingBottom: 16, paddingLeft: 12,
          borderRadius: 8, background: 'var(--t-chat-surface-bg)', border: '1px solid var(--t-divider-subtle)' }}>
          <WorkspaceTranscript entries={fixture.entries} markLast={!fixture.busy} isStreaming={fixture.busy} handback={fixture.handback} />
        </div>
      </section>)}
    </main>
  </ThemeProvider>;
}
