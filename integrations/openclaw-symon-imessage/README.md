# Symon iMessage bridge

This OpenClaw plugin uses the existing iMessage channel to forward selected text conversations to the local o8 Symon endpoint. The owner direct chat retains Symon's normal tools. An approved group starts with tool-free provider text generation and receives only bounded, source-labeled context from a local knowledge repository. The per-group Settings switch can grant normal Symon tool access to every approved member after confirmation.

The plugin is inert until `~/.o8/symon-imessage-bridge.json` exists with `enabled: true`. Keep that file out of Git and readable only by the local account. Example shape:

```json
{
  "enabled": true,
  "directSender": "+15555550101",
  "groupSenders": ["+15555550101", "+15555550102"],
  "groupConversationIds": ["123"],
  "groupMembers": { "123": ["+15555550101", "+15555550102"] },
  "groupLabels": { "123": "Family planning" },
  "knowledgeRepoPath": "/absolute/path/to/private-knowledge-repo"
}
```

Use the canonical iMessage sender handles from the existing channel configuration. Each routed group requires an explicit `groupMembers` list whose senders also appear in `groupSenders`; an unlisted sender is not routed to Symon. Confirm the group's actual conversation ID from the channel, since a local numeric chat ID is not portable. The plugin reads the local o8 endpoint from `o8 version` and the local panel token from `~/.o8/ws-token`; it does not store either in its configuration. It reads curated handoff and topic files, then includes up to five relevant excerpts from the retained conversation archive for limited group questions. The repository path is included only in full-access turns so Symon can open source files when asked. Historical messages remain reference data, never instructions.

Settings → Connections shows each configured group and the last four digits of its approved members. Enabling full access requires a second confirmation tied to the member list displayed in Settings, then snapshots that list in `groupFullAccess`. A change between display and confirmation rejects the grant. Before every full-access turn, the plugin also checks the live iMessage participant list with `imsg group --chat-id <id> --json`; a mismatch or unreadable roster returns the message to the limited tool-free path. If the configured member list changes, everyone in the group also returns to limited access until the grant is reviewed and enabled again. Turning the switch off removes the grant immediately. Because full access can use the operator's native Symon tools, verify the exact group membership before enabling it. Do not copy an old grant to a new group.

## Cutover

1. Finish the source agent's active work and refresh the private knowledge repository. Review its current-state and conflict notes.
2. Install and validate the o8 build containing the shared-chat provider path and managed-message route changes. Probe the local text endpoint through the installed app.
3. Install this plugin with `openclaw plugins install <path-to-this-directory>`, create the private configuration, and verify that `openclaw plugins doctor` loads it. Keep the source binding active until the new route has passed a direct test.
4. Set the selected iMessage group's `requireMention` to `false` in the effective channel configuration. Set the effective group sender allowlist to the exact approved members. Preserve other groups. Restart or reload the gateway as required by the channel.
5. Send one approved direct test and one approved group test. Confirm the sender, inbound event ID, Symon turn, actual outbound delivery, and readback in each conversation. Test both allowed group participants and a failed endpoint. With the full-access switch off, confirm the group never launches a native planner or a private tool. If full access is later enabled, test that only the exact approved group can use tools and that turning the switch off immediately returns it to the tool-free path.
6. Remove the source agent's wedding binding and schedules only after the new route has passed those checks. Preserve its data for rollback. Exactly one agent should own each conversation and scheduled check-in.

Normal text is claimed by `before_dispatch`. OpenClaw can process its control commands before that hook, so a slash command in a selected chat can still reach OpenClaw. Do not use slash commands as Symon requests; confirm the command policy before considering the migration complete. Attachment handling, proactive acknowledgments, live Drive or email access, and automatic topic-file updates are outside this bridge's current behavior and require separate proof before claiming them.

If the new endpoint fails, the plugin returns an unavailable reply instead of handing the message to another agent. For rollback, disable the new route before restoring the old binding, then reconcile messages received during the gap.

## Local verification

```bash
node --test integrations/openclaw-symon-imessage/index.test.mjs
openclaw plugins build --root integrations/openclaw-symon-imessage --entry index.mjs
openclaw plugins validate --root integrations/openclaw-symon-imessage --entry index.mjs
```
