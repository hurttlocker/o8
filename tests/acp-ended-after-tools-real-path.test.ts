import { describe, expect, it, vi } from 'vitest';
import type { OrchestratorEvent } from '@/lib/lane/orchestrator-stream-events';

const published = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('@/lib/realtime/publisher', () => ({ publishRealtimeMutation: published }));
vi.mock('@/lib/mcp/tool-spine/build', () => ({ buildToolRegistry: () => { throw new Error('fixture has no MCP'); } }));
const { makeAcpBackend } = await import('@/lib/lane/orchestrator-backends/acp');

const peer = String.raw`
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const update = value => send({jsonrpc:'2.0',method:'session/update',params:{sessionId:'fixture-session',update:value}});
process.stdin.on('end',()=>process.exit(0));
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const q=JSON.parse(line), reply=result=>send({jsonrpc:'2.0',id:q.id,result});
 if(q.method==='initialize') return reply({protocolVersion:1});
 if(q.method==='session/new') return reply({sessionId:'fixture-session'});
 if(q.method==='session/prompt') {
  const mode=q.params.prompt[0].text;
  if(mode!=='tool-only')update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'I will inspect the file.'}});
  update({sessionUpdate:'tool_call',toolCallId:'read-1',title:'read',rawInput:{path:'sample.txt'}});
  update({sessionUpdate:'tool_call_update',toolCallId:'read-1',title:'read',status:'completed',content:[{type:'text',text:'sample contents'}]});
  if(mode==='answered')update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'The file is ready.'}});
  if(mode==='whitespace')update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'  \n'}});
  if(mode==='thinking')update({sessionUpdate:'agent_thought_chunk',content:{type:'text',text:'considering the result'}});
  return reply({stopReason:mode==='cancelled'?'cancelled':'end_turn'});
 }
 if(q.id!==undefined)return send({jsonrpc:'2.0',id:q.id,error:{code:-32601,message:'unsupported fixture request'}});
});`;
const backend = makeAcpBackend({ id: 'acp', label: 'Fixture ACP', resolveLaunch: () => ({ command: process.execPath, args: ['-e', peer] }) });

async function turn(mode: string, threadId = `after-tools-${mode}`) {
  const events: OrchestratorEvent[] = [];
  await backend.sendTurn(process.cwd(), mode, event => events.push(event), { threadId });
  return events;
}

describe('ACP final reply after tool activity', () => {
  it.each(['preamble-only', 'tool-only', 'whitespace', 'thinking'])('marks %s without inventing a final answer or retrying', async mode => {
    const events = await turn(mode);
    expect(events.at(-1)).toMatchObject({ type: 'error', code: 'acp_ended_after_tools', error: expect.stringContaining('without a final reply') });
    expect(events.filter(event => event.type === 'tool_use')).toHaveLength(1);
    expect(events.filter(event => event.type === 'tool_result')).toHaveLength(1);
    expect(events.some(event => event.type === 'text' && event.text === 'The file is ready.')).toBe(false);
    expect(backend.peekSession(process.cwd(), undefined, `after-tools-${mode}`)).toMatchObject({ status: 'ready' });
    expect(published).toHaveBeenCalledWith(expect.objectContaining({ mutation: expect.objectContaining({
      action: 'orchestrator-error', status: 'failed', data: expect.objectContaining({ code: 'acp_ended_after_tools' }),
    }) }));
  });

  it('accepts a real answer after tools and keeps the same session usable after an incomplete turn', async () => {
    await turn('preamble-only', 'after-tools-recovery');
    const events = await turn('answered', 'after-tools-recovery');
    expect(events.filter(event => event.type === 'error')).toEqual([]);
    expect(events).toContainEqual({ type: 'text', text: 'The file is ready.' });
    expect(events.at(-1)).toMatchObject({ type: 'done', sessionId: 'fixture-session' });
  });

  it('keeps an explicit cancellation distinct from an incomplete answer', async () => {
    const events = await turn('cancelled');
    expect(events.filter(event => event.type === 'error')).toEqual([]);
    expect(events.at(-1)).toMatchObject({ type: 'done' });
  });
});
