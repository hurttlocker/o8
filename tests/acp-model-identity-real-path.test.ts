import { describe, expect, it, vi } from 'vitest';
import type { OrchestratorEvent } from '@/lib/lane/orchestrator-stream-events';
vi.mock('@/lib/realtime/publisher', () => ({ publishRealtimeMutation: async () => undefined }));
vi.mock('@/lib/mcp/tool-spine/build', () => ({ buildToolRegistry: () => { throw new Error('fixture'); } }));
import { makeAcpBackend } from '@/lib/lane/orchestrator-backends/acp';
const peer = String.raw`
let sid='fixture-'+process.pid,model='initial',held;
const send=value=>console.log(JSON.stringify(value));
const text=(sessionId,value)=>send({jsonrpc:'2.0',method:'session/update',params:{sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:value}}}});
process.stdin.on('end',()=>process.exit(0));
require('readline').createInterface({input:process.stdin}).on('line',line=>{
const q=JSON.parse(line),reply=result=>send({jsonrpc:'2.0',id:q.id,result});
if(q.method==='initialize')return reply({protocolVersion:1});
if(q.method==='session/new')return reply({sessionId:sid,configOptions:[{id:'custom-model',category:'model',type:'select',currentValue:model,options:[{value:'initial'},{value:'alternate'}]}]});
if(q.method==='session/set_config_option'||q.method==='session/set_model'){
 if(q.method==='session/set_config_option'&&q.params.configId!=='custom-model')return send({jsonrpc:'2.0',id:q.id,error:{code:-32602,message:'wrong model axis'}});
 const pick=q.params.value||q.params.modelId;
 if(pick==='method-refused'&&q.method==='session/set_config_option')return send({jsonrpc:'2.0',id:q.id,error:{code:-32000,message:'Method not found for this model'}});
 if(pick==='refused')return send({jsonrpc:'2.0',id:q.id,error:{code:-32000,message:'fixture model refusal'}});
 model=pick;if(pick==='delayed')text(sid,'model-selection-started');return setTimeout(()=>reply({}),pick==='unconfirmed'?900:pick==='delayed'?150:0);
}
if(q.method==='session/prompt'){
 const value=q.params.prompt[0].text;text('foreign-child','wrong session');text(sid,model+':'+value);
 if(value==='hold'){held=q;return;}
 return reply({stopReason:value==='unknown'?'failed':'end_turn'});
}
if(q.method==='session/cancel'&&held){send({jsonrpc:'2.0',id:held.id,result:{stopReason:'cancelled'}});held=null;}
});`;
const backend = makeAcpBackend({ id: 'acp', label: 'Fixture ACP', resolveLaunch: () => ({ command: process.execPath, args: ['-e', peer] }) });
const turn = async (thread: string, model?: string, text = 'hello') => { const events: OrchestratorEvent[] = []; await backend.sendTurn(process.cwd(), text, event => events.push(event), { threadId: thread, model }); return events; };
describe('ACP model and session identity', () => {
  it('does not prompt on a refused model and preserves the previous conversation model', async () => {
    await turn('model-refusal');
    const rejected = await turn('model-refusal', 'refused');
    expect(rejected.at(-1)?.type).toBe('error'); expect(rejected.some(event => event.type === 'text' || event.type === 'turn_receipt')).toBe(false);
    expect(backend.peekSession(process.cwd(), undefined, 'model-refusal')?.status).toBe('ready');
    const wordingRefusal = await turn('model-refusal', 'method-refused');
    expect(wordingRefusal.some(event => event.type === 'text' || event.type === 'turn_receipt')).toBe(false);
    const next = await turn('model-refusal');
    expect(next).toContainEqual({ type: 'text', text: 'initial:hello' });
    expect(next.some(event => event.type === 'text' && event.text === 'wrong session')).toBe(false);
    expect((await turn('model-refusal', undefined, 'unknown')).at(-1)?.type).toBe('error');
  });
  it('holds an unconfirmed model switch until an explicit selection is acknowledged', async () => {
    const slow = makeAcpBackend({ id: 'acp', label: 'Slow fixture', requestTimeoutMs: 500, resolveLaunch: () => ({ command: process.execPath, args: ['-e', peer] }) });
    const send = async (model?: string) => { const events: OrchestratorEvent[] = []; await slow.sendTurn(process.cwd(), 'hello', event => events.push(event), { threadId: 'unconfirmed-model', model }); return events; };
    await send();
    const unknown = await send('unconfirmed');
    expect(unknown.some(event => event.type === 'turn_receipt' || event.type === 'text')).toBe(false);
    expect(unknown.at(-1)).toMatchObject({ type: 'error', error: expect.stringContaining('could not confirm') });
    expect((await send()).some(event => event.type === 'turn_receipt' || event.type === 'text')).toBe(false);
    expect(slow.peekSession(process.cwd(), undefined, 'unconfirmed-model')?.status).toBe('ready');
    expect(await send('')).toContainEqual({ type: 'text', text: 'initial:hello' });
  });
  it('does not start a prompt when cancellation arrives during model selection', async () => {
    const signal = new AbortController();
    const events: OrchestratorEvent[] = [];
    await backend.sendTurn(process.cwd(), 'not sent', event => { events.push(event); if (event.type === 'text' && event.text === 'model-selection-started') signal.abort(); }, { threadId: 'cancel-during-model', model: 'delayed', signal: signal.signal });
    expect(events).toContainEqual({ type: 'text', text: 'model-selection-started' });
    expect(events.some(event => event.type === 'text' && event.text.endsWith(':not sent'))).toBe(false);
    expect(backend.peekSession(process.cwd(), undefined, 'cancel-during-model')?.status).toBe('ready');
  });
  it('isolates parent/child cancellation and refuses a competing turn in the same session', async () => {
    let parentReady!: () => void; let childReady!: () => void;
    const parentStarted = new Promise<void>(resolve => { parentReady = resolve; }); const childStarted = new Promise<void>(resolve => { childReady = resolve; });
    const parentSignal = new AbortController(); const childSignal = new AbortController(); let parentSettled = false;
    const parent = backend.sendTurn(process.cwd(), 'hold', event => { if (event.type === 'text') parentReady(); }, { threadId: 'parent', signal: parentSignal.signal }).then(() => { parentSettled = true; });
    await parentStarted;
    const competing = await turn('parent'); expect(competing.at(-1)?.type).toBe('error');
    const child = backend.sendTurn(process.cwd(), 'hold', event => { if (event.type === 'text') childReady(); }, { threadId: 'child', signal: childSignal.signal });
    await childStarted; childSignal.abort(); await child; expect(parentSettled).toBe(false);
    expect(backend.peekSession(process.cwd(), undefined, 'parent')?.status).toBe('busy');
    parentSignal.abort(); await parent;
  }, 10_000);
});
