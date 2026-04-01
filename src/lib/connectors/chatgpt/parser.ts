/**
 * ChatGPT Export Parser — extracts conversations from ZIP or raw JSON.
 *
 * Handles:
 *   - ZIP file from ChatGPT export (contains conversations.json)
 *   - Raw conversations.json (for browser extension / paste flows)
 *   - Large files via streaming parse
 *
 * Output: ParsedConversation[] ready for profile extraction.
 */

import type {
  ChatGPTExportConversation,
  ChatGPTMessage,
  ChatGPTMessageNode,
  ParsedConversation,
  ParsedMessage,
} from './types';

// ── ZIP Extraction ──

/**
 * Extract conversations.json from a ChatGPT export ZIP buffer.
 * Uses the built-in DecompressionStream API (Node 18+ / modern browsers).
 */
export async function extractConversationsFromZip(zipBuffer: Buffer): Promise<string> {
  // ChatGPT export ZIP structure:
  //   conversations.json    ← we want this
  //   user.json
  //   message_feedback.json
  //   model_comparisons.json (optional)

  // Use AdmZip for server-side extraction (lightweight, zero-native-dep)
  const { default: AdmZip } = await import('adm-zip');
  const zip = new AdmZip(zipBuffer);
  const entry = zip.getEntry('conversations.json');

  if (!entry) {
    // Try to find it in a subdirectory
    const allEntries = zip.getEntries();
    const convEntry = allEntries.find(e => e.entryName.endsWith('conversations.json'));
    if (!convEntry) {
      throw new Error('conversations.json not found in ZIP. Is this a ChatGPT export?');
    }
    const data = convEntry.getData();
    return data.toString('utf-8');
  }

  return entry.getData().toString('utf-8');
}

// ── JSON Parsing ──

/**
 * Parse raw conversations.json content into structured conversations.
 * Handles large files by processing in chunks.
 */
export function parseConversationsJson(jsonString: string): ParsedConversation[] {
  let raw: ChatGPTExportConversation[];

  try {
    raw = JSON.parse(jsonString);
  } catch {
    throw new Error('Invalid JSON in conversations data. The file may be corrupted.');
  }

  if (!Array.isArray(raw)) {
    throw new Error('Expected an array of conversations. The format may have changed.');
  }

  console.log(`[chatgpt-import] Parsing ${raw.length} conversations`);

  return raw
    .map(parseOneConversation)
    .filter((c): c is ParsedConversation => c !== null)
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime()); // Most recent first
}

/**
 * Parse a single ChatGPT conversation from the export format.
 * The export uses a tree structure (mapping) — we flatten to a linear message list
 * by walking the tree from root to current_node.
 */
function parseOneConversation(conv: ChatGPTExportConversation): ParsedConversation | null {
  if (!conv.mapping || typeof conv.mapping !== 'object') return null;

  const messages = flattenMessageTree(conv.mapping, conv.current_node);

  // Skip empty or system-only conversations
  const hasUserContent = messages.some(m => m.role === 'user' && m.text.trim().length > 0);
  if (!hasUserContent) return null;

  const userMessages = messages.filter(m => m.role === 'user');
  const assistantMessages = messages.filter(m => m.role === 'assistant');

  return {
    id: conv.conversation_id ?? conv.title ?? `conv-${conv.create_time}`,
    title: conv.title || 'Untitled',
    createdAt: new Date(conv.create_time * 1000),
    updatedAt: new Date(conv.update_time * 1000),
    messages,
    userMessageCount: userMessages.length,
    assistantMessageCount: assistantMessages.length,
  };
}

/**
 * Flatten the ChatGPT message tree into a linear list.
 * The export format stores messages as a tree (mapping) where each node has
 * parent/children references. We walk from root to the current branch.
 */
function flattenMessageTree(
  mapping: Record<string, ChatGPTMessageNode>,
  currentNode?: string,
): ParsedMessage[] {
  // Find the path from root to current_node by backtracking
  const path: string[] = [];
  let nodeId = currentNode;

  // If no current_node, find a leaf node
  if (!nodeId) {
    const childrenSet = new Set<string>();
    for (const node of Object.values(mapping)) {
      for (const childId of node.children) {
        childrenSet.add(childId);
      }
    }
    // A leaf is a node that is not a child of any other node's children...
    // Actually, a leaf is a node with no children
    const leaves = Object.entries(mapping).filter(([, node]) => node.children.length === 0);
    if (leaves.length > 0) {
      nodeId = leaves[leaves.length - 1][0]; // Pick last leaf
    }
  }

  // Walk backwards from current node to root
  while (nodeId && mapping[nodeId]) {
    path.unshift(nodeId);
    nodeId = mapping[nodeId].parent ?? undefined;
  }

  // Extract messages along the path
  const messages: ParsedMessage[] = [];
  for (const id of path) {
    const node = mapping[id];
    if (!node?.message) continue;
    const msg = node.message;
    const role = msg.author?.role;
    if (!role || role === 'system') continue; // Skip system prompts

    const text = extractMessageText(msg);
    if (!text.trim()) continue;

    messages.push({
      role: role as ParsedMessage['role'],
      text,
      timestamp: msg.create_time ? new Date(msg.create_time * 1000) : null,
    });
  }

  return messages;
}

/**
 * Extract plain text from a ChatGPT message content object.
 * Handles various content types: text, code, multimodal_text, etc.
 */
function extractMessageText(msg: ChatGPTMessage): string {
  const content = msg.content;
  if (!content) return '';

  // Direct text field
  if (content.text) return content.text;

  // Parts array — most common format
  if (content.parts && Array.isArray(content.parts)) {
    return content.parts
      .map((part: string | Record<string, unknown>) => {
        if (typeof part === 'string') return part;
        // Multimodal parts (images, etc.) — extract text if present
        if (part && typeof part === 'object') {
          if ('text' in part && typeof part.text === 'string') return part.text as string;
          // Skip image/audio parts
          return '';
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }

  return '';
}

// ── Statistics ──

export interface ParseStats {
  totalConversations: number;
  totalMessages: number;
  userMessages: number;
  assistantMessages: number;
  dateRange: { from: Date; to: Date } | null;
  avgMessagesPerConversation: number;
  /** Conversations with only 1-2 exchanges */
  shortConversations: number;
  /** Conversations with 10+ exchanges */
  deepConversations: number;
}

export function computeParseStats(conversations: ParsedConversation[]): ParseStats {
  if (conversations.length === 0) {
    return {
      totalConversations: 0,
      totalMessages: 0,
      userMessages: 0,
      assistantMessages: 0,
      dateRange: null,
      avgMessagesPerConversation: 0,
      shortConversations: 0,
      deepConversations: 0,
    };
  }

  const totalMessages = conversations.reduce((sum, c) => sum + c.messages.length, 0);
  const userMessages = conversations.reduce((sum, c) => sum + c.userMessageCount, 0);
  const assistantMessages = conversations.reduce((sum, c) => sum + c.assistantMessageCount, 0);

  const dates = conversations.map(c => c.createdAt.getTime());
  const from = new Date(Math.min(...dates));
  const to = new Date(Math.max(...dates));

  const shortConversations = conversations.filter(c => c.userMessageCount <= 2).length;
  const deepConversations = conversations.filter(c => c.userMessageCount >= 10).length;

  return {
    totalConversations: conversations.length,
    totalMessages,
    userMessages,
    assistantMessages,
    dateRange: { from, to },
    avgMessagesPerConversation: Math.round(totalMessages / conversations.length),
    shortConversations,
    deepConversations,
  };
}
