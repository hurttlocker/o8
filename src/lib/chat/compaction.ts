import { Message, generateText } from 'ai';

export interface CompactionResult {
  newMessages: Message[];
  summary: string;
  compactedCount: number;
}

/**
 * Takes a long array of messages, compresses the older ones into a single dense context block,
 * and retains the most recent messages for immediate conversational flow.
 */
export async function runCompaction(
  messages: Message[],
  model: any, // Pass your AI SDK model instance here (e.g., google('gemini-2.5-flash'))
  keepCount: number = 5
): Promise<CompactionResult> {
  if (messages.length <= keepCount) {
    return { newMessages: messages, summary: '', compactedCount: 0 };
  }

  // Slice the array: older messages get compressed, newest are kept raw
  const messagesToCompact = messages.slice(0, messages.length - keepCount);
  const recentMessages = messages.slice(messages.length - keepCount);

  // Format the old conversation into a raw transcript for the cheap model to read
  const transcript = messagesToCompact
    .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
    .join('\n\n');

  const systemPrompt = `
You are compressing a developer's chat history to save context window space.
You must drop pleasantries, conversational filler, and redundant back-and-forth.

YOU MUST STRICTLY PRESERVE:
1. Exact file paths (e.g., src/lib/chat.ts).
2. Specific code decisions, variable names, or architecture choices.
3. Unresolved tasks or bugs.
4. User preferences explicitly stated.

Output a dense, bulleted list of facts, decisions, and context. 
Do not write an intro or outro. Just the facts.
`;

  // Use a fast, cheap model (Flash/Haiku) to generate the summary
  const { text: summary } = await generateText({
    model,
    system: systemPrompt,
    prompt: `Compress this conversation:\n\n${transcript}`,
  });

  // Create the new "Compaction Node" message
  const compactionMessage: Message = {
    id: `compaction-${Date.now()}`,
    role: 'system',
    content: `<compacted_context>\n${summary}\n</compacted_context>`,
    // Optional: Add custom metadata here so the UI knows to render the CompactionNode component
    data: {
      type: 'compaction_event',
      compactedCount: messagesToCompact.length,
    },
  };

  return {
    newMessages: [compactionMessage, ...recentMessages],
    summary,
    compactedCount: messagesToCompact.length,
  };
}
