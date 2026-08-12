import {
  type McpTool,
  type McpToolResult,
  apiFetchCorrelatedMutation,
  errorText,
  jsonResult,
  optionalString,
  requiredString,
  textResult,
} from './shared';
import { CLOSE_UNMERGED_DISPOSITIONS } from '@/lib/orchestrator/close-unmerged';

export const CLOSE_PACKET_TOOLS: McpTool[] = [
  {
    name: 'close_packet_unmerged',
    description:
      'USE THIS WHEN a packet will intentionally not merge: its work was adopted in another repo, superseded, the spec changed, or it will not be fixed. This archives the lane, preserves committed work when possible, records the operator disposition in the session-outcomes ledger, and removes it from pending review. Do not use reset_packet (which requeues work) or submit_review with approved:false (which requests rework). Example: close_packet_unmerged({packetId: "pkt-abc", disposition: "adopted_elsewhere", note: "Implemented in o8-mobile."})',
    inputSchema: {
      type: 'object',
      properties: {
        packetId: {
          type: 'string',
          description: 'Packet to close without merging.',
        },
        disposition: {
          type: 'string',
          enum: [...CLOSE_UNMERGED_DISPOSITIONS],
          description: 'Why this packet is ending without a merge.',
        },
        note: {
          type: 'string',
          description: 'Optional operator context, up to 1,000 characters.',
        },
      },
      required: ['packetId', 'disposition'],
    },
  },
];

export async function handleClosePacketUnmerged(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const disposition = requiredString(args, 'disposition');
    if (!(CLOSE_UNMERGED_DISPOSITIONS as readonly string[]).includes(disposition)) {
      throw new Error(`disposition must be one of: ${CLOSE_UNMERGED_DISPOSITIONS.join(', ')}.`);
    }
    const result = await apiFetchCorrelatedMutation(
      '/api/orchestrator/discard-packet',
      {
        packetId: requiredString(args, 'packetId'),
        disposition,
        note: optionalString(args, 'note') || undefined,
      },
      'clientMutationId',
    );
    return jsonResult(result);
  } catch (error) {
    console.error(`${'[mcp-operator]'} close_packet_unmerged failed: ${errorText(error)}`);
    return textResult(`Failed to close packet unmerged: ${errorText(error)}`, true);
  }
}
