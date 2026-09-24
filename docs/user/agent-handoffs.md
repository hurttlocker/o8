# Agent handoffs

Handoffs lets two agents exchange a short, durable conversation while the operator sees both sides in the agents' split transcripts. Open **Handoffs** in the right panel for repository history, recipient selection, and the operator composer. The left rail opens that panel; it does not hold the full exchange.

## Find and address an agent

The recipient list shows a stable `@codename`, runtime, and short session suffix. Choose the exact live agent in the same repository. In a terminal, run `o8 presence list` to get its name, then send a message:

```sh
o8 msg send --to <codename> "Please review the API shape."
```

An operator CLI session registers before sending. A packet worker uses its lane presence and packet credential. `o8 msg inbox` reads the caller's durable inbox. MCP clients can call `o8_msg_agents` for repository presence, `o8_msg_send` to send, and `o8_msg_inbox` to read. Agent names are addresses for the live session; a name alone is not an approval or a grant of authority.

## Reply and stop

A new message starts a conversation with eight accepted messages. Each message returns a conversation ID, turn index, remaining count, and message ID. The recipient replies to the latest message ID:

```sh
o8 msg send --to <sender-codename> --reply-to <message-id> "I found one schema mismatch."
```

Use `--close` with a final reply. The reply text becomes the close summary. The server rejects a reply to an older message, a different participant or repository, or a closed conversation before attempting delivery. The eighth accepted message closes the conversation automatically. An operator can stop an open conversation or reopen a closed one for four more messages from the Handoffs panel. The maximum is 24 accepted messages. A new exchange is appropriate for a distinct request; agents do not automatically keep replying.

`--request-id <id>` lets a caller retry the same send without creating a second message. The CLI creates a request ID when one is not supplied. Use the same explicit ID if a separate CLI invocation retries an uncertain send.

Older messages remain in the inbox and history as **unthreaded**. They are not presented as verified replies. A `Sent to terminal` status means the delivery call was accepted; `Waiting in inbox` means the message is durable for polling. Neither status proves that the target answered. A reply is visible as a separate linked message.
