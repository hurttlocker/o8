import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * CLI ↔ MCP control-plane parity.
 *
 * Every control-plane verb is reachable from BOTH the `o8` CLI and the MCP
 * operator server, and BOTH surfaces hit the SAME gated route — that shared
 * route is the contract that keeps the two in sync. This suite asserts each
 * backing route exists on disk: if a route is renamed or removed, parity breaks
 * here loudly instead of one surface silently diverging. (The CLI commands +
 * MCP tools themselves are exercised by their own smokes; this guards the seam
 * they share.)
 */
const ROOT = join(__dirname, '..');

const CONTROL_PLANE_VERBS: Array<{ verb: string; cli: string; mcp: string; route: string }> = [
  { verb: 'create mission', cli: 'o8 mission create', mcp: 'create_mission', route: 'src/app/api/orchestrator/create-mission/route.ts' },
  { verb: 'dispatch mission', cli: 'o8 mission dispatch', mcp: 'dispatch_mission', route: 'src/app/api/orchestrator/dispatch/route.ts' },
  { verb: 'mission status', cli: 'o8 mission status', mcp: 'get_mission_status', route: 'src/app/api/orchestrator/status/route.ts' },
  { verb: 'submit review', cli: 'o8 packet review', mcp: 'submit_review', route: 'src/app/api/orchestrator/review/route.ts' },
  { verb: 'approve and merge', cli: 'o8 packet approve-merge', mcp: 'approve_and_merge', route: 'src/app/api/orchestrator/merge/route.ts' },
  { verb: 'merge preview', cli: 'o8 packet merge-preview', mcp: 'o8_merge_preview', route: 'src/app/api/orchestrator/merge-preview/route.ts' },
  { verb: 'reset / retry packet', cli: 'o8 packet reset | retry', mcp: 'reset_packet / retry_packet', route: 'src/app/api/orchestrator/reset-packet/route.ts' },
  { verb: 'rerun with feedback', cli: 'o8 packet rerun', mcp: 'rerun_with_feedback', route: 'src/app/api/orchestrator/rerun-with-feedback/route.ts' },
  { verb: 'steer packet', cli: 'o8 packet steer', mcp: 'steer_packet', route: 'src/app/api/orchestrator/steer-packet/route.ts' },
  { verb: 'close packet unmerged', cli: 'o8 packet close', mcp: 'close_packet_unmerged', route: 'src/app/api/orchestrator/discard-packet/route.ts' },
  { verb: 'inbox approve / reject', cli: 'o8 inbox approve | reject', mcp: 'o8_approve / o8_reject', route: 'src/app/api/panel/approvals/route.ts' },
  { verb: 'inbox list', cli: 'o8 inbox list', mcp: 'o8_status', route: 'src/app/api/operator/status/route.ts' },
];

describe('CLI ↔ MCP control-plane parity (#2)', () => {
  for (const v of CONTROL_PLANE_VERBS) {
    it(`${v.verb}: CLI \`${v.cli}\` + MCP \`${v.mcp}\` share ${v.route}`, () => {
      expect(
        existsSync(join(ROOT, v.route)),
        `${v.route} missing — control-plane parity broken for "${v.verb}"`,
      ).toBe(true);
    });
  }
});
