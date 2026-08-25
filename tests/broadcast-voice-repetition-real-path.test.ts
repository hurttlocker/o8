import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'o8-broadcast-repetition-'));
writeFileSync(path.join(dataDir, 'ws-token'), 'broadcast-repetition-operator-token-0123456789\n', 'utf8');
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;

const { getSqlite } = await import('@/lib/db');
const { BroadcastSpeaker } = await import('@/lib/broadcast/speaker');
const { runBroadcastDirectorOnce } = await import('@/lib/broadcast/director');
const { appendEvent, createLane, setLaneStatus } = await import('@/lib/lane/registry');
const { recordApprovalAudit, recordOrchestratorReview } = await import('@/lib/approvals/store');
const { BROADCAST_SPOKEN_MAX_LENGTH } = await import('@/lib/broadcast/narration');

const voiceOn = {
  broadcastVoice: 'on' as const,
  lullMinutes: 600,
  maxPerHour: 60,
};

const directorSettings = {
  broadcastCommentary: 'interval' as const,
  intervalMinutes: 0,
  minNewEvents: 1,
  maxPerHour: 60,
};

async function emptyCommentary() {
  return { commentary: [], cursor: null, hasMore: false };
}

function momentTexts(): string[] {
  return (getSqlite().prepare(`
    SELECT text FROM broadcast_events
    WHERE kind = 'commentary' AND json_extract(metadata_json, '$.voiceTrigger') = 'moment'
    ORDER BY sequence ASC
  `).all() as Array<{ text: string }>).map((row) => row.text);
}

function newLane(label: string, suffix: string) {
  const lane = createLane({
    label,
    repoPath: '/tmp/broadcast-voice-repetition',
    branch: `issue/broadcast-voice-${suffix}`,
    baseBranch: 'main',
    runtime: 'codex',
    packetId: `pkt-broadcast-voice-${suffix}`,
  });
  setLaneStatus(lane.id, 'running', 'system', 'running');
  return lane;
}

function approvalIdFor(packetId: string): string {
  const row = getSqlite().prepare(`
    SELECT id FROM approvals WHERE packet_id = ? ORDER BY created_at DESC LIMIT 1
  `).get(packetId) as { id: string } | undefined;
  if (!row) throw new Error(`No approval row for ${packetId}`);
  return row.id;
}

function findings(count: number, note: string) {
  return Array.from({ length: count }, (_unused, index) => ({
    file: `src/lib/broadcast/speaker.ts`,
    line: index + 1,
    severity: 'bug' as const,
    description: `${note} finding ${index + 1}: the spoken update repeats a verdict the listener already heard.`,
    resolution: 'deferred' as const,
  }));
}

describe('Broadcast voice repetition real path', () => {
  it('announces one review verdict once across ticks spanning the repetition window', async () => {
    const spoken: string[] = [];
    const speaker = new BroadcastSpeaker({
      sqlite: getSqlite(),
      speak: async (text) => { spoken.push(text); },
      loadCommentary: emptyCommentary,
    });
    const base = Date.now();
    await speaker.tick({ now: new Date(base), settings: voiceOn });

    const lane = newLane('Worker transcripts stop reaching the pane', `repeat-${base}`);
    recordOrchestratorReview(lane.packetId!, {
      approved: false,
      reviewer: 'codex',
      findings: findings(2, 'First pass'),
    });
    // submit_review also writes a summary-only audit row with no `approved`
    // boolean — the same verdict, arriving a second time from another table.
    recordApprovalAudit(
      approvalIdFor(lane.packetId!),
      'orchestrator_review',
      'system',
      'Changes requested. 2 findings: src/lib/broadcast/speaker.ts [bug/deferred] The spoken update repeats a verdict the listener already heard.',
    );

    await speaker.tick({ now: new Date(base + 1_500), settings: voiceOn });
    await speaker.flush();
    expect(momentTexts()).toHaveLength(1);
    // One verdict, one sentence: the lane-sourced and approval-sourced rows are the same fact.
    expect(momentTexts()[0].match(/Worker transcripts stop reaching the pane/g)).toHaveLength(1);

    // The packet is reviewed again minutes later with the same verdict — the listener already heard it.
    recordOrchestratorReview(lane.packetId!, {
      approved: false,
      reviewer: 'codex',
      findings: findings(5, 'Second pass'),
    });
    await speaker.tick({ now: new Date(base + 4 * 60_000), settings: voiceOn });
    await speaker.tick({ now: new Date(base + 4 * 60_000 + 1_500), settings: voiceOn });
    await speaker.tick({ now: new Date(base + 10 * 60_000), settings: voiceOn });
    await speaker.flush();

    expect(momentTexts()).toHaveLength(1);
    expect(spoken).toHaveLength(1);
  });

  it('does not re-narrate a fact the other narrator already narrated', async () => {
    const spoken: string[] = [];
    const speaker = new BroadcastSpeaker({
      sqlite: getSqlite(),
      speak: async (text) => { spoken.push(text); },
      loadCommentary: emptyCommentary,
    });
    const base = Date.now();
    await speaker.tick({ now: new Date(base), settings: voiceOn });
    const before = momentTexts().length;

    // Director narrates the verdict first.
    const directorLane = newLane('Broadcast director covers this verdict', `director-${base}`);
    recordOrchestratorReview(directorLane.packetId!, {
      approved: false,
      reviewer: 'codex',
      findings: findings(1, 'Director'),
    });
    await expect(runBroadcastDirectorOnce({
      sqlite: getSqlite(),
      now: new Date(base + 1_000),
      settings: directorSettings,
      runner: async () => 'The review asks for changes on the director packet.',
      model: 'gpt-test',
    })).resolves.toMatchObject({ status: 'posted' });

    await speaker.tick({ now: new Date(base + 2_000), settings: voiceOn });
    await speaker.tick({ now: new Date(base + 3_500), settings: voiceOn });
    await speaker.flush();
    expect(momentTexts()).toHaveLength(before);
    expect(spoken).toEqual([]);

    // Speaker narrates the next verdict first — the director must not restate it.
    const speakerLane = newLane('Speaker covers this verdict', `speaker-${base}`);
    recordOrchestratorReview(speakerLane.packetId!, {
      approved: false,
      reviewer: 'codex',
      findings: findings(1, 'Speaker'),
    });
    await speaker.tick({ now: new Date(base + 5_000), settings: voiceOn });
    await speaker.tick({ now: new Date(base + 6_500), settings: voiceOn });
    await speaker.flush();
    expect(momentTexts()).toHaveLength(before + 1);

    const secondRun = await runBroadcastDirectorOnce({
      sqlite: getSqlite(),
      now: new Date(base + 7_000),
      settings: { ...directorSettings, minNewEvents: 2 },
      runner: async () => 'The review asks for changes on the speaker packet.',
      model: 'gpt-test',
    });
    expect(secondRun.status).toBe('skipped');
    expect(['no_new_events', 'min_new_events']).toContain(secondRun.reason);
  });

  it('keeps every spoken line short and free of packet ids and commit shas', async () => {
    const spoken: string[] = [];
    const speaker = new BroadcastSpeaker({
      sqlite: getSqlite(),
      speak: async (text) => { spoken.push(text); },
      loadCommentary: emptyCommentary,
    });
    const base = Date.now();
    await speaker.tick({ now: new Date(base), settings: voiceOn });

    const lane = newLane('Broadcast voice stays concise', `concise-${base}`);
    appendEvent(lane.id, 'merge', 'system', {
      laneHeadSha: 'a17c0de55f11b3c9d4e2f6a7b8c9d0e1f2a3b4c5',
      commitSubject: 'fix: keep the spoken broadcast line short enough for a listener to absorb without a transcript',
      changedFileCount: 4,
    });
    recordOrchestratorReview(lane.packetId!, {
      approved: false,
      reviewer: 'codex',
      findings: findings(3, 'Concise'),
    });
    appendEvent(lane.id, 'status_change', 'system', {
      status: 'failed',
      eventLabel: 'agent_failed',
      reason: 'The post-rebase typecheck failed after the worker rewrote the speaker templates, and the merge gate refused the diff because the branch head no longer matches the reviewed head.',
    });

    await speaker.tick({ now: new Date(base + 1_500), settings: voiceOn });
    await speaker.tick({ now: new Date(base + 3_000), settings: voiceOn });
    await speaker.flush();

    expect(spoken.length).toBeGreaterThan(0);
    for (const line of spoken) {
      expect(line.length).toBeLessThanOrEqual(BROADCAST_SPOKEN_MAX_LENGTH);
      expect(line).not.toMatch(/\bpkt-[A-Za-z0-9-]+/);
      expect(line).not.toMatch(/\blane-[A-Za-z0-9-]+/);
      expect(line).not.toMatch(/\b(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{7,40}\b/);
    }
    expect(spoken.join(' ')).toContain('Broadcast voice stays concise');
  });

  it('phrases a second review turn as a return visit, not the first line again (#1842)', async () => {
    const spoken: string[] = [];
    const speaker = new BroadcastSpeaker({
      sqlite: getSqlite(),
      speak: async (text) => { spoken.push(text); },
      loadCommentary: emptyCommentary,
    });
    const base = Date.now();
    await speaker.tick({ now: new Date(base), settings: voiceOn });

    const lane = newLane('Show the model on every spawned agent', `revisit-${base}`);
    recordOrchestratorReview(lane.packetId!, { approved: true, reviewer: 'codex', findings: [] });
    await speaker.tick({ now: new Date(base + 1_500), settings: voiceOn });
    await speaker.flush();

    const first = momentTexts().at(-1) ?? '';
    expect(first).toContain('Review approved for Show the model on every spawned agent');
    expect(first).not.toContain('again');

    // The packet is steered, runs again, and passes a SECOND review turn 63
    // minutes later -- past the 30-minute suppression window, so this is real
    // news that must be spoken. It must not be spoken in the same words.
    const later = base + 63 * 60_000;
    recordOrchestratorReview(lane.packetId!, { approved: true, reviewer: 'codex', findings: [] });
    await speaker.tick({ now: new Date(later), settings: voiceOn });
    await speaker.tick({ now: new Date(later + 1_500), settings: voiceOn });
    await speaker.flush();

    const second = momentTexts().at(-1) ?? '';
    expect(second).toContain('Show the model on every spawned agent');
    expect(second).toContain('Review approved again for');
    expect(second).not.toBe(first);
    for (const line of spoken) expect(line.length).toBeLessThanOrEqual(BROADCAST_SPOKEN_MAX_LENGTH);
  });

  it('keeps return-visit wording when a repeated change request has no findings', async () => {
    const speaker = new BroadcastSpeaker({
      sqlite: getSqlite(),
      speak: async () => {},
      loadCommentary: emptyCommentary,
    });
    const base = Date.now();
    await speaker.tick({ now: new Date(base), settings: voiceOn });

    const lane = newLane('Re-review without structured findings', `revisit-empty-${base}`);
    recordOrchestratorReview(lane.packetId!, { approved: false, reviewer: 'codex', findings: [] });
    await speaker.tick({ now: new Date(base + 1_500), settings: voiceOn });
    await speaker.flush();

    const later = base + 63 * 60_000;
    recordOrchestratorReview(lane.packetId!, { approved: false, reviewer: 'codex', findings: [] });
    await speaker.tick({ now: new Date(later), settings: voiceOn });
    await speaker.tick({ now: new Date(later + 1_500), settings: voiceOn });
    await speaker.flush();

    expect(momentTexts().at(-1)).toContain('Review requests changes again on Re-review without structured findings.');
  });
});
