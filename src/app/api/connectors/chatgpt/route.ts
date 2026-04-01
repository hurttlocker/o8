/**
 * POST /api/connectors/chatgpt — Import ChatGPT conversation history.
 *
 * Accepts:
 *   - multipart/form-data with a "file" field (ZIP from ChatGPT export)
 *   - application/json with a "conversations" field (raw conversations.json content)
 *
 * Returns: ExtractedProfile + ParseStats
 */

export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import {
  extractConversationsFromZip,
  parseConversationsJson,
  computeParseStats,
  extractProfileHeuristic,
} from '@/lib/connectors/chatgpt';

const MAX_FILE_SIZE = 200 * 1024 * 1024; // 200MB — ChatGPT exports can be large

export async function POST(req: NextRequest) {
  try {
    const contentType = req.headers.get('content-type') ?? '';
    let conversationsJson: string;

    if (contentType.includes('multipart/form-data')) {
      // ZIP upload
      const formData = await req.formData();
      const file = formData.get('file');

      if (!file || !(file instanceof Blob)) {
        return NextResponse.json(
          { error: 'No file provided. Upload a ChatGPT export ZIP.' },
          { status: 400 },
        );
      }

      if (file.size > MAX_FILE_SIZE) {
        return NextResponse.json(
          { error: `File too large (${Math.round(file.size / 1024 / 1024)}MB). Maximum is 200MB.` },
          { status: 413 },
        );
      }

      const buffer = Buffer.from(await file.arrayBuffer());

      // Check if it's a ZIP or raw JSON
      const isZip = buffer[0] === 0x50 && buffer[1] === 0x4b; // PK magic bytes

      if (isZip) {
        console.log(`[chatgpt-import] Extracting ZIP (${Math.round(buffer.length / 1024)}KB)`);
        conversationsJson = await extractConversationsFromZip(buffer);
      } else {
        // Assume raw JSON
        conversationsJson = buffer.toString('utf-8');
      }
    } else if (contentType.includes('application/json')) {
      // Raw JSON body
      const body = await req.json();

      if (typeof body.conversations === 'string') {
        conversationsJson = body.conversations;
      } else if (Array.isArray(body.conversations)) {
        conversationsJson = JSON.stringify(body.conversations);
      } else {
        return NextResponse.json(
          { error: 'Expected "conversations" field as string or array.' },
          { status: 400 },
        );
      }
    } else {
      return NextResponse.json(
        { error: 'Send multipart/form-data (ZIP) or application/json.' },
        { status: 400 },
      );
    }

    // Parse conversations
    console.log(`[chatgpt-import] Parsing conversations JSON (${Math.round(conversationsJson.length / 1024)}KB)`);
    const conversations = parseConversationsJson(conversationsJson);
    const stats = computeParseStats(conversations);

    console.log(`[chatgpt-import] Parsed ${stats.totalConversations} conversations, ${stats.totalMessages} messages`);

    // Extract profile (heuristic — fast, no LLM needed)
    const profile = extractProfileHeuristic(conversations);

    console.log(`[chatgpt-import] Profile extracted: ${profile.topics.length} topics, ${profile.skills.length} skills, ${profile.unfinishedThreads.length} unfinished threads`);

    return NextResponse.json({
      success: true,
      stats,
      profile,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error during import';
    console.error('[chatgpt-import] Error:', message);
    return NextResponse.json(
      { error: message },
      { status: 500 },
    );
  }
}
