import type { Message, ProviderConfig } from '@/app/api/v2/proxy/llm/provider-config';
import { toolsForOpenAI } from '@/lib/llm/tools';
import { ChatGPTPlanError } from './types';
import { planError } from './service';

/** Text and locally executed function tools only; no hosted tools or stored history. */
export const chatGPTPlanProvider: ProviderConfig = {
  url: 'https://api.openai.com/v1/responses',
  envKey: '',
  buildHeaders: () => { throw new ChatGPTPlanError('plan_broker_required', 'ChatGPT plan calls must use the account credential broker.'); },
  buildBody: (model: string, messages: Message[]) => ({
    model, store: false, stream: true,
    input: messages.map((message) => ({ role: message.role === 'system' ? 'developer' : message.role, content: message.content })),
    tools: [{ type: 'namespace', name: 'o8', description: 'Tools executed locally by o8 under the active repository policy.', tools: toolsForOpenAI().map((tool) => ({ type: 'function', ...tool.function })) }],
  }),
  parseStream: (line) => {
    if (!line.startsWith('data: ') || line.slice(6).trim() === '[DONE]') return null;
    let event: Record<string, unknown>;
    try { event = JSON.parse(line.slice(6)) as Record<string, unknown>; }
    catch { throw new ChatGPTPlanError('stream_invalid', 'The ChatGPT response could not be read.', 502); }
    if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') return { type: 'content', text: event.delta };
    if (event.type === 'response.output_item.done') {
      const item = event.item as Record<string, unknown> | undefined;
      if (item?.type === 'function_call' && typeof item.name === 'string' && typeof item.call_id === 'string' && typeof item.arguments === 'string') {
        let args: unknown;
        try { args = JSON.parse(item.arguments); } catch { throw new ChatGPTPlanError('tool_arguments_invalid', 'ChatGPT returned invalid tool arguments.', 502); }
        if (!args || typeof args !== 'object' || Array.isArray(args)) throw new ChatGPTPlanError('tool_arguments_invalid', 'ChatGPT returned invalid tool arguments.', 502);
        return { type: 'tool_call', toolName: item.name, toolId: item.call_id, args: args as Record<string, unknown> };
      }
    }
    if (event.type === 'response.completed') {
      const response = event.response as Record<string, unknown> | undefined;
      if (response?.status !== 'completed') throw new ChatGPTPlanError('stream_incomplete', 'The ChatGPT response did not complete.', 502);
      const usage = response.usage as Record<string, unknown> | undefined;
      return { type: 'completed', inputTokens: typeof usage?.input_tokens === 'number' ? usage.input_tokens : 0, outputTokens: typeof usage?.output_tokens === 'number' ? usage.output_tokens : 0 };
    }
    if (event.type === 'response.failed' || event.type === 'error') {
      const response = event.response as Record<string, unknown> | undefined;
      const error = (response?.error ?? event.error ?? event) as Record<string, unknown>;
      throw planError(error.code);
    }
    if (event.type === 'response.incomplete') throw new ChatGPTPlanError('stream_incomplete', 'The ChatGPT response stopped before completion. No other billing route was used.', 502);
    return null;
  },
};
