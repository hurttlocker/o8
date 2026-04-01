/**
 * ChatGPT Export Types — matches the structure of conversations.json
 * from ChatGPT's data export (Settings → Data Controls → Export).
 */

// ── Raw export structures ──

export interface ChatGPTExportConversation {
  title: string;
  create_time: number;     // Unix timestamp
  update_time: number;     // Unix timestamp
  mapping: Record<string, ChatGPTMessageNode>;
  current_node?: string;
  conversation_id?: string;
}

export interface ChatGPTMessageNode {
  id: string;
  parent?: string | null;
  children: string[];
  message?: ChatGPTMessage | null;
}

export interface ChatGPTMessage {
  id: string;
  author: { role: 'user' | 'assistant' | 'system' | 'tool'; name?: string | null };
  content: {
    content_type: string;  // 'text', 'code', 'multimodal_text', etc.
    parts?: (string | Record<string, unknown>)[];
    text?: string;
  };
  create_time?: number | null;
  metadata?: Record<string, unknown>;
  status?: string;
}

// ── Parsed / flattened structures ──

export interface ParsedConversation {
  id: string;
  title: string;
  createdAt: Date;
  updatedAt: Date;
  messages: ParsedMessage[];
  /** Number of user messages (proxy for engagement depth) */
  userMessageCount: number;
  /** Number of assistant messages */
  assistantMessageCount: number;
}

export interface ParsedMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  text: string;
  timestamp: Date | null;
}

// ── Profile extraction results ──

export interface UserTopic {
  name: string;
  /** Weighted by frequency × recency (0-1) */
  weight: number;
  /** How many conversations mention this topic */
  frequency: number;
  /** Most recent mention */
  lastSeen: Date;
}

export interface UserSkillAssessment {
  domain: string;
  level: 'beginner' | 'intermediate' | 'advanced';
  /** Signals that led to this assessment */
  signals: string[];
}

export interface UserProject {
  name: string;
  description: string;
  lastMentioned: Date;
  status: 'active' | 'stalled';
  /** Keywords/technologies associated */
  technologies: string[];
}

export interface UnfinishedThread {
  title: string;
  description: string;
  originalDate: Date;
  /** Last user message — shows where they gave up */
  lastUserMessage: string;
  /** What o8 could suggest as a mission */
  suggestedMission: string;
  /** Technologies/tools involved */
  technologies: string[];
}

export interface UserCommunicationStyle {
  technicalLevel: 'casual' | 'technical' | 'expert';
  verbosity: 'concise' | 'balanced' | 'detailed';
  /** Average user message length in characters */
  avgMessageLength: number;
}

export interface ExtractedProfile {
  /** When the profile was extracted */
  extractedAt: Date;
  /** Source: 'chatgpt' | 'claude' | 'github' etc. */
  source: 'chatgpt';
  /** Total conversations analyzed */
  conversationCount: number;
  /** Total messages analyzed */
  messageCount: number;
  /** Date range of conversations */
  dateRange: { from: Date; to: Date };
  /** Top interests/topics weighted by frequency + recency */
  topics: UserTopic[];
  /** Skill level assessment per domain */
  skills: UserSkillAssessment[];
  /** Active and stalled projects */
  projects: UserProject[];
  /** Tools/languages/frameworks they use */
  tools: { name: string; frequency: number }[];
  /** How they communicate */
  communicationStyle: UserCommunicationStyle;
  /** Conversations that went nowhere — the killer feature */
  unfinishedThreads: UnfinishedThread[];
}

// ── Import status ──

export interface ImportProgress {
  stage: 'uploading' | 'extracting' | 'parsing' | 'analyzing' | 'storing' | 'done' | 'error';
  /** 0-100 */
  percent: number;
  /** Human-readable status */
  message: string;
  /** Stats discovered so far */
  stats?: {
    conversationsFound?: number;
    messagesFound?: number;
    topicsFound?: number;
    unfinishedThreads?: number;
  };
  /** Error message if stage === 'error' */
  error?: string;
}
