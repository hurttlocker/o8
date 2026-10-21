import { describe, expect, it, vi } from 'vitest';
import { LiveConversationBridge, LiveFollowupQueue, voiceFollowupIntent } from './conversation-bridge';
describe('talker attachment and deliberate follow-ups', () => {
  it('routes completion only to the current talker and fences old cleanup', async () => {
    const bus = new LiveConversationBridge(); const first = vi.fn(async () => {}); const next = vi.fn(async () => {});
    const detach = bus.subscribe(first); await bus.publish('working', false); detach();
    await bus.publish('while paused'); expect(first).toHaveBeenCalledTimes(1);
    bus.subscribe(next); detach(); await bus.publish('confirmed result');
    expect(next).toHaveBeenCalledWith('confirmed result', true); expect(first).toHaveBeenCalledTimes(1);
  });
  it('requires explicit queue intent; corrections are not silently scheduled', () => {
    expect(voiceFollowupIntent('Actually use the other file')).toEqual({kind:'ordinary'});
    expect(voiceFollowupIntent('queue a follow-up: check tests')).toEqual({kind:'queue',text:'check tests'});
    expect(voiceFollowupIntent('after this task check tests')).toEqual({kind:'queue',text:'check tests'});
    expect(voiceFollowupIntent('cancel queued')).toEqual({kind:'cancel'});
  });
  it('deduplicates and holds until the exact task has a confirmed terminal', () => {
    const queue = new LiveFollowupQueue();
    expect(queue.enqueue('voice-1','test','task-1')).toBe(true);
    expect(queue.enqueue('voice-1','test','task-1')).toBe(true);
    expect(queue.enqueue('voice-2','replace','task-1')).toBe(false);
    expect(queue.take('task-2',true)).toBeNull(); expect(queue.take('task-1',false)).toBeNull();
    expect(queue.take('task-1',true)).toEqual({id:'voice-1',text:'test',afterTaskId:'task-1'});
    expect(queue.take('task-1',true)).toBeNull();
    queue.enqueue('voice-3','later','task-2'); expect(queue.cancel()).toBe(true); expect(queue.take('task-2',true)).toBeNull();
  });
});

it('does not treat quoted examples or same-utterance withdrawal as queue consent', () => {
  expect(voiceFollowupIntent('queue check tests, actually do not queue that')).toEqual({kind:'clarify'});
  expect(voiceFollowupIntent('queue a follow-up is an example, not a request')).toEqual({kind:'clarify'});
});
