/**
 * ChatGPT Profile Extractor — turns parsed conversations into a user profile.
 *
 * Two extraction modes:
 *   1. Heuristic (fast, free) — keyword/pattern analysis, no LLM needed
 *   2. LLM-enhanced (slower, richer) — sends batched summaries to an LLM for deeper insight
 *
 * The heuristic pass runs first and produces a usable profile immediately.
 * The LLM pass enriches it asynchronously if an LLM endpoint is available.
 */

import type {
  ParsedConversation,
  ExtractedProfile,
  UserTopic,
  UserSkillAssessment,
  UserProject,
  UnfinishedThread,
  UserCommunicationStyle,
} from './types';

// ── Heuristic Extraction (no LLM needed) ──

/**
 * Extract a full user profile from parsed conversations using heuristic analysis.
 * Fast (~50ms for 500 conversations), no API calls needed.
 */
export function extractProfileHeuristic(conversations: ParsedConversation[]): ExtractedProfile {
  console.log(`[chatgpt-import] Extracting profile from ${conversations.length} conversations`);

  const topics = extractTopics(conversations);
  const skills = assessSkills(conversations, topics);
  const tools = extractTools(conversations);
  const projects = extractProjects(conversations);
  const communicationStyle = analyzeCommunicationStyle(conversations);
  const unfinishedThreads = findUnfinishedThreads(conversations);

  const dates = conversations.map(c => c.createdAt.getTime());
  const from = new Date(Math.min(...dates));
  const to = new Date(Math.max(...dates));
  const totalMessages = conversations.reduce((sum, c) => sum + c.messages.length, 0);

  return {
    extractedAt: new Date(),
    source: 'chatgpt',
    conversationCount: conversations.length,
    messageCount: totalMessages,
    dateRange: { from, to },
    topics,
    skills,
    projects,
    tools,
    communicationStyle,
    unfinishedThreads,
  };
}

// ── Topic Extraction ──

/** Domain keyword patterns for topic detection */
const TOPIC_PATTERNS: Record<string, RegExp[]> = {
  'Web Development': [/\b(?:html|css|javascript|react|vue|angular|nextjs|next\.js|svelte|tailwind|webpack|vite|dom|browser|frontend|front-end)\b/i],
  'Backend Development': [/\b(?:node\.?js|express|fastify|django|flask|rails|spring|api|rest|graphql|server|backend|back-end|microservice)\b/i],
  'Python': [/\b(?:python|pip|conda|jupyter|pandas|numpy|matplotlib|pytorch|tensorflow|flask|django|fastapi)\b/i],
  'Mobile Development': [/\b(?:react.native|flutter|swift|kotlin|ios|android|mobile.app|xcode|gradle)\b/i],
  'Machine Learning': [/\b(?:machine.learning|deep.learning|neural.network|model.training|fine.?tun|llm|gpt|transformer|embedding|classification|regression|nlp)\b/i],
  'Data Science': [/\b(?:data.science|data.analysis|pandas|jupyter|visualization|statistics|dataset|dataframe|csv|sql)\b/i],
  'DevOps': [/\b(?:docker|kubernetes|k8s|ci.?cd|github.actions|terraform|ansible|aws|gcp|azure|deploy|infrastructure)\b/i],
  'Databases': [/\b(?:sql|postgres|mysql|mongodb|redis|sqlite|database|query|schema|migration|orm|drizzle|prisma)\b/i],
  'Design': [/\b(?:figma|sketch|ui.?design|ux|wireframe|prototype|layout|typography|color.scheme|accessibility)\b/i],
  'Business': [/\b(?:business.plan|startup|revenue|marketing|customer|pricing|saas|mvp|product.market|growth|monetiz)\b/i],
  'Writing': [/\b(?:write|essay|article|blog.post|copy|content.creation|storytelling|narrative|editing|proofread)\b/i],
  'Education': [/\b(?:learn|tutorial|course|explain|teach|understand|beginner|study|homework|assignment|exam)\b/i],
  'TypeScript': [/\b(?:typescript|ts|type.?script|interface|type.annotation|generics|enum)\b/i],
  'Rust': [/\b(?:rust|cargo|ownership|borrow.checker|tokio|actix|wasm)\b/i],
  'Go': [/\b(?:golang|go.mod|goroutine|channel|gin|fiber)\b/i],
  'Security': [/\b(?:security|authentication|authorization|oauth|jwt|encrypt|vulnerability|penetration|csrf|xss)\b/i],
  'Game Development': [/\b(?:game.dev|unity|unreal|godot|sprite|physics.engine|shader|3d.model)\b/i],
};

function extractTopics(conversations: ParsedConversation[]): UserTopic[] {
  const topicScores = new Map<string, { frequency: number; lastSeen: Date; totalWeight: number }>();
  const now = Date.now();

  for (const conv of conversations) {
    const userText = conv.messages
      .filter(m => m.role === 'user')
      .map(m => m.text)
      .join(' ');

    // Recency weight: conversations from the last 30 days get full weight,
    // older ones decay exponentially
    const ageMs = now - conv.updatedAt.getTime();
    const ageDays = ageMs / (1000 * 60 * 60 * 24);
    const recencyWeight = Math.exp(-ageDays / 90); // 90-day half-life

    for (const [topic, patterns] of Object.entries(TOPIC_PATTERNS)) {
      const matched = patterns.some(p => p.test(userText));
      if (matched) {
        const existing = topicScores.get(topic) ?? { frequency: 0, lastSeen: new Date(0), totalWeight: 0 };
        existing.frequency += 1;
        existing.totalWeight += recencyWeight;
        if (conv.updatedAt > existing.lastSeen) existing.lastSeen = conv.updatedAt;
        topicScores.set(topic, existing);
      }
    }
  }

  // Normalize weights to 0-1
  const maxWeight = Math.max(...Array.from(topicScores.values()).map(s => s.totalWeight), 1);

  return Array.from(topicScores.entries())
    .map(([name, score]) => ({
      name,
      weight: score.totalWeight / maxWeight,
      frequency: score.frequency,
      lastSeen: score.lastSeen,
    }))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 15); // Top 15 topics
}

// ── Skill Assessment ──

/** Signals for skill level detection */
const BEGINNER_SIGNALS = [
  /\bhow do I\b/i, /\bwhat is (?:a |the )?\b/i, /\bexplain\b/i,
  /\bbeginner\b/i, /\blearn(?:ing)?\b/i, /\btutorial\b/i,
  /\bI'?m new to\b/i, /\bbasic\b/i, /\bsimple example\b/i,
  /\bI don'?t understand\b/i, /\bstep by step\b/i,
];

const INTERMEDIATE_SIGNALS = [
  /\bbest practice\b/i, /\bdesign pattern\b/i, /\brefactor\b/i,
  /\boptimiz\b/i, /\barchitecture\b/i, /\btrade.?off\b/i,
  /\bcompar(?:e|ison)\b/i, /\bscal(?:e|able|ability)\b/i,
  /\bmigrat(?:e|ion)\b/i, /\btest(?:ing|s)\b/i,
];

const ADVANCED_SIGNALS = [
  /\bperformance\s+(?:bottleneck|profil|benchmark)\b/i,
  /\bconcurrency\b/i, /\block.?free\b/i, /\bmemory.?leak\b/i,
  /\bcompiler\b/i, /\btype.?system\b/i, /\bmonomorphi[sz]\b/i,
  /\bsystem.?design\b/i, /\bdistributed\b/i, /\bconsensus\b/i,
  /\bformal.?verification\b/i, /\bcategory.?theory\b/i,
];

function assessSkills(conversations: ParsedConversation[], topics: UserTopic[]): UserSkillAssessment[] {
  const allUserText = conversations
    .flatMap(c => c.messages.filter(m => m.role === 'user').map(m => m.text))
    .join(' ');

  const skills: UserSkillAssessment[] = [];

  for (const topic of topics.slice(0, 8)) { // Assess top 8 topics
    const signals: string[] = [];
    let score = 0; // -1 beginner, 0 intermediate, 1 advanced

    const beginnerHits = BEGINNER_SIGNALS.filter(p => p.test(allUserText)).length;
    const intermediateHits = INTERMEDIATE_SIGNALS.filter(p => p.test(allUserText)).length;
    const advancedHits = ADVANCED_SIGNALS.filter(p => p.test(allUserText)).length;

    if (beginnerHits > intermediateHits + advancedHits) {
      score = -1;
      signals.push(`${beginnerHits} beginner-level questions detected`);
    } else if (advancedHits > 2) {
      score = 1;
      signals.push(`${advancedHits} advanced concepts discussed`);
    } else {
      signals.push(`Mixed signal: ${beginnerHits} basic, ${intermediateHits} intermediate, ${advancedHits} advanced`);
    }

    // Conversation depth as a proxy — deep conversations suggest experience
    const topicConvs = conversations.filter(c =>
      c.messages.some(m => m.role === 'user' &&
        TOPIC_PATTERNS[topic.name]?.some(p => p.test(m.text)))
    );
    const avgDepth = topicConvs.length > 0
      ? topicConvs.reduce((s, c) => s + c.userMessageCount, 0) / topicConvs.length
      : 0;

    if (avgDepth > 8) {
      score = Math.min(score + 1, 1);
      signals.push(`Average conversation depth: ${Math.round(avgDepth)} messages`);
    }

    skills.push({
      domain: topic.name,
      level: score <= -1 ? 'beginner' : score >= 1 ? 'advanced' : 'intermediate',
      signals,
    });
  }

  return skills;
}

// ── Tool/Technology Extraction ──

const TOOL_PATTERNS: Record<string, RegExp> = {
  'React': /\breact\b/i,
  'Next.js': /\bnext\.?js\b/i,
  'Vue': /\bvue\.?js?\b/i,
  'Angular': /\bangular\b/i,
  'Svelte': /\bsvelte\b/i,
  'Node.js': /\bnode\.?js\b/i,
  'Python': /\bpython\b/i,
  'TypeScript': /\btypescript\b/i,
  'JavaScript': /\bjavascript\b/i,
  'Rust': /\b(?:rust|cargo)\b/i,
  'Go': /\bgolang\b/i,
  'Swift': /\bswift\b/i,
  'Kotlin': /\bkotlin\b/i,
  'Java': /\bjava(?!script)\b/i,
  'C++': /\bc\+\+\b/i,
  'C#': /\bc#\b/i,
  'Ruby': /\bruby\b/i,
  'PHP': /\bphp\b/i,
  'Docker': /\bdocker\b/i,
  'Kubernetes': /\bkubernetes|k8s\b/i,
  'AWS': /\baws\b/i,
  'PostgreSQL': /\bpostgres(?:ql)?\b/i,
  'MongoDB': /\bmongodb?\b/i,
  'Redis': /\bredis\b/i,
  'SQLite': /\bsqlite\b/i,
  'Git': /\bgit(?:hub|lab)?\b/i,
  'Tailwind': /\btailwind\b/i,
  'Figma': /\bfigma\b/i,
  'VS Code': /\bvs.?code|vscode\b/i,
  'Vercel': /\bvercel\b/i,
  'Firebase': /\bfirebase\b/i,
  'Supabase': /\bsupabase\b/i,
  'Prisma': /\bprisma\b/i,
  'Drizzle': /\bdrizzle\b/i,
};

function extractTools(conversations: ParsedConversation[]): { name: string; frequency: number }[] {
  const toolCounts = new Map<string, number>();

  for (const conv of conversations) {
    const userText = conv.messages
      .filter(m => m.role === 'user')
      .map(m => m.text)
      .join(' ');

    for (const [tool, pattern] of Object.entries(TOOL_PATTERNS)) {
      if (pattern.test(userText)) {
        toolCounts.set(tool, (toolCounts.get(tool) ?? 0) + 1);
      }
    }
  }

  return Array.from(toolCounts.entries())
    .map(([name, frequency]) => ({ name, frequency }))
    .sort((a, b) => b.frequency - a.frequency)
    .slice(0, 20);
}

// ── Project Detection ──

function extractProjects(conversations: ParsedConversation[]): UserProject[] {
  const projects: UserProject[] = [];
  const projectKeywords = /\b(?:build(?:ing)?|creat(?:e|ing)|develop(?:ing)?|mak(?:e|ing)|implement(?:ing)?|working on|my (?:app|project|site|website|tool|bot|game|platform|dashboard))\b/i;
  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;

  for (const conv of conversations) {
    const userMessages = conv.messages.filter(m => m.role === 'user');
    if (userMessages.length < 3) continue; // Need some depth

    const fullUserText = userMessages.map(m => m.text).join(' ');
    if (!projectKeywords.test(fullUserText)) continue;

    // Extract technologies mentioned
    const technologies: string[] = [];
    for (const [tool, pattern] of Object.entries(TOOL_PATTERNS)) {
      if (pattern.test(fullUserText)) technologies.push(tool);
    }

    if (technologies.length === 0) continue; // Not a technical project

    const isActive = conv.updatedAt.getTime() > thirtyDaysAgo;

    projects.push({
      name: conv.title,
      description: userMessages[0].text.slice(0, 200),
      lastMentioned: conv.updatedAt,
      status: isActive ? 'active' : 'stalled',
      technologies,
    });
  }

  return projects
    .sort((a, b) => b.lastMentioned.getTime() - a.lastMentioned.getTime())
    .slice(0, 10);
}

// ── Communication Style ──

function analyzeCommunicationStyle(conversations: ParsedConversation[]): UserCommunicationStyle {
  const userMessages = conversations.flatMap(c =>
    c.messages.filter(m => m.role === 'user')
  );

  if (userMessages.length === 0) {
    return { technicalLevel: 'casual', verbosity: 'balanced', avgMessageLength: 0 };
  }

  const lengths = userMessages.map(m => m.text.length);
  const avgLength = lengths.reduce((s, l) => s + l, 0) / lengths.length;

  // Technical level — check for code, technical jargon density
  const allText = userMessages.map(m => m.text).join(' ');
  const codeBlockCount = (allText.match(/```/g) ?? []).length / 2;
  const technicalTermCount = (allText.match(/\b(?:function|class|interface|import|export|const|let|var|async|await|return|throw|try|catch|api|endpoint|database|query|schema|deploy|server|client|component|render|state|prop)\b/gi) ?? []).length;
  const technicalDensity = technicalTermCount / (allText.split(/\s+/).length || 1);

  let technicalLevel: UserCommunicationStyle['technicalLevel'] = 'casual';
  if (technicalDensity > 0.05 || codeBlockCount > 10) {
    technicalLevel = 'expert';
  } else if (technicalDensity > 0.02 || codeBlockCount > 3) {
    technicalLevel = 'technical';
  }

  // Verbosity
  let verbosity: UserCommunicationStyle['verbosity'] = 'balanced';
  if (avgLength < 80) verbosity = 'concise';
  else if (avgLength > 300) verbosity = 'detailed';

  return {
    technicalLevel,
    verbosity,
    avgMessageLength: Math.round(avgLength),
  };
}

// ── Unfinished Threads (the killer feature) ──

/**
 * Find conversations where the user was trying to build something but
 * the conversation fizzled out. These become suggested first missions.
 */
function findUnfinishedThreads(conversations: ParsedConversation[]): UnfinishedThread[] {
  const threads: UnfinishedThread[] = [];
  const buildIntentPatterns = [
    /\b(?:how (?:do|can|would) I|help me|I want to|I need to|can you|I'?m trying to)\s+(?:build|create|make|develop|implement|set up|deploy|write|code)\b/i,
    /\b(?:build(?:ing)?|creat(?:e|ing)|implement(?:ing)?)\s+(?:a |an |the |my )/i,
  ];

  for (const conv of conversations) {
    const userMessages = conv.messages.filter(m => m.role === 'user');
    if (userMessages.length < 2) continue; // Too short to be a real attempt

    const firstUserText = userMessages[0].text;
    const hasBuildIntent = buildIntentPatterns.some(p => p.test(firstUserText));
    if (!hasBuildIntent) continue;

    // Check if the conversation ended abruptly — user stopped responding
    // Signal: last message is from assistant (user didn't follow up),
    // AND conversation has < 6 user messages (didn't finish)
    const lastMessage = conv.messages[conv.messages.length - 1];
    const isAbandonedByUser = lastMessage.role === 'assistant' && userMessages.length < 6;

    if (!isAbandonedByUser) continue;

    // Extract technologies
    const fullText = userMessages.map(m => m.text).join(' ');
    const technologies: string[] = [];
    for (const [tool, pattern] of Object.entries(TOOL_PATTERNS)) {
      if (pattern.test(fullText)) technologies.push(tool);
    }

    const lastUserMsg = userMessages[userMessages.length - 1].text;

    // Generate a mission suggestion based on the conversation
    const mission = generateMissionSuggestion(conv.title, firstUserText, technologies);

    threads.push({
      title: conv.title,
      description: firstUserText.slice(0, 300),
      originalDate: conv.createdAt,
      lastUserMessage: lastUserMsg.slice(0, 200),
      suggestedMission: mission,
      technologies,
    });
  }

  return threads
    .sort((a, b) => b.originalDate.getTime() - a.originalDate.getTime())
    .slice(0, 10); // Top 10 unfinished threads
}

function generateMissionSuggestion(title: string, firstMessage: string, technologies: string[]): string {
  const techStr = technologies.slice(0, 3).join(', ');
  const cleanTitle = title.replace(/^Untitled$/, '').trim();

  if (cleanTitle) {
    return techStr
      ? `Build "${cleanTitle}" using ${techStr}`
      : `Complete "${cleanTitle}" — pick up where you left off`;
  }

  // Extract the intent from the first message
  const intentMatch = firstMessage.match(
    /(?:build|create|make|develop|implement|set up|write|code)\s+(.{10,60}?)(?:\.|$|\n|,)/i
  );
  if (intentMatch) {
    return techStr
      ? `Build ${intentMatch[1].trim()} with ${techStr}`
      : `Build ${intentMatch[1].trim()}`;
  }

  return techStr
    ? `Project using ${techStr} — based on your earlier conversation`
    : 'Continue this project from where you left off';
}

// ── LLM-Enhanced Extraction (Phase 2) ──

/**
 * Build a summary prompt for LLM enrichment.
 * This batches conversations into a compact summary for a single LLM call.
 */
export function buildLLMEnrichmentPrompt(
  conversations: ParsedConversation[],
  heuristicProfile: ExtractedProfile,
): string {
  // Sample conversations — take the 30 most recent with substantive content
  const sampled = conversations
    .filter(c => c.userMessageCount >= 3)
    .slice(0, 30);

  const conversationSummaries = sampled.map(c => {
    const userTexts = c.messages
      .filter(m => m.role === 'user')
      .map(m => m.text.slice(0, 200))
      .slice(0, 5)
      .join(' | ');
    return `[${c.title}] (${c.createdAt.toISOString().slice(0, 10)}) — ${userTexts}`;
  }).join('\n');

  return `Analyze this user's ChatGPT conversation history to build a profile. Here's what our heuristic analysis found:

Topics: ${heuristicProfile.topics.map(t => `${t.name} (${Math.round(t.weight * 100)}%)`).join(', ')}
Skills: ${heuristicProfile.skills.map(s => `${s.domain}: ${s.level}`).join(', ')}
Tools: ${heuristicProfile.tools.map(t => t.name).join(', ')}
Style: ${heuristicProfile.communicationStyle.technicalLevel}, ${heuristicProfile.communicationStyle.verbosity}
Unfinished projects: ${heuristicProfile.unfinishedThreads.length}

Here are their 30 most recent substantive conversations:
${conversationSummaries}

Based on this, provide a JSON object with:
1. "refinedTopics" — any topics we missed or mis-weighted
2. "refinedSkills" — adjusted skill levels with reasoning
3. "projectInsights" — what they're really trying to build (the big picture)
4. "personalityNotes" — communication preferences, learning style
5. "suggestedFirstMission" — the single best thing o8 could build for them

Respond with valid JSON only.`;
}
