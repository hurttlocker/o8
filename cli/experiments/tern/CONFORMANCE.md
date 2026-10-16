# Tern lab: conformance, threat model and ownership contract (#3365)

Measured on macOS with Tern 0.6.2, the public SDK `@stencil-hq/tern` 0.1.0
(source read at upstream commit `13d3cca`), and the published coding agent
used as the reference TSP client, version 18.11.1 (source read at `a536558`).
Every row below was recorded from raw bytes, not from documentation; the
scrubbed receipts are in `receipts/`.

## 1. Ground truth: the handshake on the wire

Captured with `script -r` around the reference client running inside a Tern
pane. Program to terminal, in one burst at t=1.680 s:

```
ESC _ tsp;q;{"q":"hello","v":[1],"app":"<client>","features":["edit","undo","send"]} ESC \
ESC [ c                     (DA1, sent after hello)
ESC [ ? 2026 $ p  ...       (DECRQM probes)
ESC _ tsp;o;{"id":"s:1","mode":"inline","title":"<client>","role":"<client>.session"} ESC \
```

Terminal to program, on the program's stdin, 8 ms later:

```
ESC _ tsp;r;{"r":"hello","v":1,"term":"tern","ver":"0.6.2","kinds":[...45 kinds...],
  "features":["blobs","settle","adopt","dock","program-palette","reduce-motion","aside",
  "scroll","styles","flow"],"apc":65536,"credits":2,"cols":160,"cell":{"w":8,"h":16},
  "dark":false,"reduceMotion":false,"hour12":false} ESC \
ESC [ ? 62 ; 52 ; c         (DA1 reply, always after the hello reply)
ESC _ tsp;e;{"ev":"resize","sf":"s:1","cols":160,...} ESC \
ESC _ tsp;e;{"ev":"ack","sf":"s:1","s":1} ESC \
```

The client then sends `t` (theme) and `f` (frame ops) messages per surface, and
Tern acknowledges each frame sequence number with an `ack` event. The hello
reply arriving before the DA1 reply is how a client tells Tern from any other
terminal: every terminal answers DA1.

## 2. Conformance matrix

The same probe (hello plus DA1, then the SDK's `connect()`) in each environment.

| Environment | Hello reply | DA1 reply | SDK session | Visible residue |
| --- | --- | --- | --- | --- |
| Tern 0.6.2 pane | yes, 4 ms | `?62;52;` | yes, 5 ms | none |
| Tern pane, then SSH to Linux | yes, 60 ms | `?62;52;` | yes, 12 ms | none |
| tmux 3.6a inside a Tern pane | no (tmux drops the APC) | `?1;2;4` from tmux | no, 0 ms | none |
| tmux 3.6a, no Tern | no | `?1;2;4` | no, 0 ms | none |
| Terminal.app 2.15 (470.2) | no | `?1;2` | no, 54 ms | **yes: prints `tsp;q;{"q":"hello",...}` as text** |
| pty with no terminal answering | no | none | no, waits the full timeout | n/a |
| Pipe or CI without a tty | not sent | not sent | no, 0 ms | none |
| Ghostty, iTerm2 | **not measured** (not installed on the test machine) | | | |

Consequences, enforced by `renderer.mjs` and `golden.test.mjs`:

- The lab sends the hello only when `TERM_PROGRAM=tern` or `TERN_TSP=1`.
  Terminal.app would otherwise show a line of protocol text above the output.
- SSH does not forward `TERM_PROGRAM`. Over SSH from Tern, TSP works but is
  opt-in with `TERN_TSP=1`.
- A pty that never answers DA1 costs the full SDK timeout (1 s in the lab).
- The gate reads an inherited environment variable. A terminal nested inside
  a Tern pane that does not reset `TERM_PROGRAM` (an editor's terminal, or o8's
  own PTY panel when the o8 server was started from Tern) still gets the probe.
  tmux, screen and zellij are excluded explicitly; other nested terminals are
  residual.

## 3. Byte-identical fallback

`golden/packet-info.plain.txt` and `golden/packet-info.tty.txt` are today's
`o8 packet info` human output for the fixture, written by running the real
command with only its config, target lookup and API calls stubbed
(`cli/src/presentation/text.golden.test.ts` pins them; changing a field
mapping in `info.ts` fails it). The TTY variant carries
the CLI's bold headings; before this change the lab's fallback dropped them.

`golden.test.mjs` runs the lab in seven terminal profiles without Tern and
checks, for each: the bytes equal the golden exactly, the SDK is never loaded,
the input never enters raw mode, and an `@xterm/headless` rendering of the
output matches the rendering of the golden, cell for cell, including bold. A
control case forces the probe in the measured Terminal.app behaviour and
confirms the screen check fails, so the check can detect the leak it guards.

The claim covers standard output. A runtime drift warning goes to standard
error in both modes, worded `WARNING:` by the human command and `warning:` by
the JSON command the lab runs, so that line differs; the fixture has no drift.

## 4. Threat model: input from the terminal

TSP events carry no nonce, token or origin. Any bytes on the program's stdin
that parse as `ESC _ tsp;e;{...} ESC \` (or the OSC 877 form) are delivered as
events, and outside a bracketed paste the SDK cannot tell them from Tern's own.

Measured against Tern 0.6.2 with a listening SDK session:

| Vector | Result |
| --- | --- |
| Raw ESC bytes typed into the pane | forged `send` event delivered |
| `tern send BLOCK text ...` from another local process | forged `send` event delivered |
| `tern send BLOCK paste ...`, program has bracketed paste off | forged `send` event delivered |
| `tern send BLOCK paste ...`, program has bracketed paste on | delivered as an inert paste key |

Rules that follow:

1. No TSP event carries authority. Approve, reject, merge, steer, interrupt,
   retry and dispatch stay on o8's authenticated paths; a TSP event may at
   most ask o8 to open its own governed flow, which then authenticates again.
2. Any future listening surface enables bracketed paste.
3. The lab consumes no events at all. `forge.test.mjs` waits for the lab's
   first frame, then aims actions, sends, edits, changes, selections, toggles,
   focus, undo, split frames, a bracketed paste and `y`/Ctrl-C keys at every
   node id that frame drew, through the real SDK. The SDK's own recording
   must show every forged event parsed, and the lab must run only its
   packet-info read, draw no further frame, and return the tty unchanged.
   Giving any lab node an `onActivate` handler makes the test fail. A source
   check rejects listening surfaces, input loops and any `on...:` handler.
   The S3a observer test aims the same way and counts parsed events too.

## 5. Ownership contract

| Thing | Owner | Enforced by |
| --- | --- | --- |
| Pi worker process | o8's Pi runtime (RPC child on pipes) | `ownership.test.mjs`: PID survives every observer exit |
| Worker stdin | o8's Pi runtime; no terminal is attached | inbound RPC bytes unchanged by observers |
| Approvals | o8's approval store and permission bridge | pending approval unchanged until o8 resolves it |
| Transcript | o8's persisted session and transcript reader | transcript identities unchanged; no duplicates after restart |
| Session lifetime | o8 `launch`, `resume`, `interrupt` | interrupt stops the process; resume reuses the session file |
| Lab viewer tty | the lab, for one render only | `forge.test.mjs`: raw mode off and no listeners after return |
| Tern pane | the user's terminal; the lab never reads its events | source check in `forge.test.mjs` |

Workers that run in o8's own PTY panel are drawn by xterm.js, not Tern. The PTY
environment copies the server's environment, so a server started from a Tern
pane passes `TERM_PROGRAM=tern` to them. Measured with the reference client in
a node-pty plus xterm.js harness: it emits a few TSP frames, xterm.js answers
DA1 first, and the client falls back to its text UI (11 visible rows against 10
without the variable). Harmless today, and listed as residual.

## 6. Receipts

- `receipts/tern-handshake.json`: every TSP message and DA1 exchange of the
  reference client under Tern, with timings; frame bodies reduced to counts.
- `receipts/conformance-probes.json`: the probe result per environment.
- `receipts/terminal-app-visible-residue.json`: the line Terminal.app printed.
- `receipts/forge-attempts.json`: what a listening program received for each
  forge vector, with its bracketed-paste setting. In `forge-paste-on` the
  `send text` forge was delivered twice because the run re-sent it.

## 7. Not proven here

- Ghostty and iTerm2 behaviour with the hello: not measured.
- The windowed Tern app in a fresh profile stops at the closed-beta sign-in;
  the side-by-side rendering was taken from `tern serve`, the same 0.6.2
  renderer, where o8's packet surface appears as native key-value and table
  nodes beside the reference client.
- Fault injection beyond the S3a observer cases (lost frames, slow reader,
  disconnect mid-frame) against the real Tern renderer.
- Which TSP interfaces the vendor treats as stable.
