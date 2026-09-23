# Symon iMessage bridge

This OpenClaw plugin uses the existing iMessage channel for selected Symon conversations. By default it forwards text to the local o8 CLI-backed Symon endpoint. An approved group starts with tool-free provider text generation and receives only bounded, source-labeled context from a local knowledge repository. The per-group Settings switch can grant normal Symon tool access to every approved member after confirmation.

An optional OpenClaw agent backend keeps full-access conversations inside a dedicated Symon agent workspace. In Settings, **Use OpenClaw for iMessage** becomes available only when that agent is configured and owns the iMessage binding. This prevents those turns from opening Codex app-server chats. The default remains the o8 CLI-backed path. Limited-access group replies continue through the tool-free o8 route, even when OpenClaw is selected. The iMessage transport in this integration still requires OpenClaw; a separate transport is needed for installations without it.

The plugin is inert until `~/.o8/symon-imessage-bridge.json` exists with `enabled: true`. Keep that file out of Git and readable only by the local account. Example shape:

```json
{
  "enabled": true,
  "directSender": "+15555550101",
  "groupSenders": ["+15555550101", "+15555550102"],
  "groupConversationIds": ["123"],
  "groupMembers": { "123": ["+15555550101", "+15555550102"] },
  "groupLabels": { "123": "Family planning" },
  "executionBackend": "cli",
  "knowledgeRepoPath": "/absolute/path/to/private-knowledge-repo"
}
```

Use the canonical iMessage sender handles from the existing channel configuration. Each routed group requires an explicit `groupMembers` list whose senders also appear in `groupSenders`; an unlisted sender is not routed to Symon. Confirm the group's actual conversation ID from the channel, since a local numeric chat ID is not portable. The plugin reads the local o8 endpoint from `o8 version` and the local panel token from `~/.o8/ws-token`; it does not store either in its configuration. It reads curated handoff and topic files, then includes up to five relevant excerpts from the retained conversation archive for limited group questions. The repository path is included only in full-access turns so Symon can open source files when asked. Historical messages remain reference data, never instructions.

Settings → Connections shows each configured group and the last four digits of its approved members. Enabling full access requires a second confirmation tied to the member list displayed in Settings, then snapshots that list in `groupFullAccess`. A change between display and confirmation rejects the grant. Before every full-access turn, the plugin also checks the live iMessage participant list with `imsg group --chat-id <id> --json`; a mismatch or unreadable roster returns the message to the limited tool-free path. If the configured member list changes, everyone in the group also returns to limited access until the grant is reviewed and enabled again. Turning the switch off removes the grant immediately. Because full access can use the operator's native Symon tools, verify the exact group membership before enabling it. Do not copy an old grant to a new group.

To select the native backend, create a dedicated OpenClaw agent with ID `symon`, put its private instructions and project access in its workspace, and bind `imessage:*` to it. Then select **Use OpenClaw for iMessage** in Settings. The setting persists `executionBackend: "openclaw"` and `openclawAgentId: "symon"` in the private bridge file. For full-access direct and group messages, the plugin checks the active agent session key before yielding to OpenClaw. A binding mismatch returns an unavailable reply instead of running the wrong agent. Do not reuse the previous planner's identity or its workspace instructions as Symon's global identity.

## Cutover

1. Finish the source agent's active work and refresh the private knowledge repository. Review its current-state and conflict notes.
2. Install and validate the o8 build containing the shared-chat provider path and managed-message route changes. Probe the local text endpoint through the installed app.
3. Install this plugin with `openclaw plugins install <path-to-this-directory>`, create the private configuration, and verify that `openclaw plugins doctor` loads it. Keep the source binding active until the new route has passed a direct test.
4. Set the selected iMessage group's `requireMention` to `false` in the effective channel configuration. Set the effective group sender allowlist to the exact approved members. Preserve other groups. Restart or reload the gateway as required by the channel.
5. Send one approved direct test and one approved group test. Confirm the sender, inbound event ID, Symon turn, actual outbound delivery, and readback in each conversation. Test both allowed group participants and a failed endpoint. With the full-access switch off, confirm the group never launches a native planner or a private tool. If full access is later enabled, test that only the exact approved group can use tools and that turning the switch off immediately returns it to the tool-free path.
6. If using the native backend, bind the dedicated Symon agent, enable its Settings switch, and repeat the direct and group tests through the actual iMessage channel. Verify the reply used the Symon agent's workspace and that no Codex Remote chat was created.
7. Transfer the source agent's schedules only after the new route has passed those checks. Preserve its data for rollback. Exactly one agent should own each conversation and scheduled check-in.

In CLI-backed mode, normal text is claimed by `before_dispatch`. In native mode, full-access messages pass to the bound Symon agent, including supported attachments. OpenClaw can process its control commands before that hook, so a slash command in a selected chat can still reach OpenClaw. Do not use slash commands as Symon requests; confirm the command policy before considering the migration complete. Proactive acknowledgments, attachment handling, live Drive or email access, and automatic topic-file updates require live proof before claiming them.

If the new endpoint fails, the plugin returns an unavailable reply instead of handing the message to another agent. For rollback, disable the new route before restoring the old binding, then reconcile messages received during the gap.

## Local verification

```bash
node --test integrations/openclaw-symon-imessage/index.test.mjs
openclaw plugins build --root integrations/openclaw-symon-imessage --entry index.mjs
openclaw plugins validate --root integrations/openclaw-symon-imessage --entry index.mjs
```
