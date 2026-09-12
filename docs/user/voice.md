# Symon, the voice layer

**Why a voice agent is in a control room:** a fleet generates decisions while you're doing something else. Agents finish, reviews queue, a merge blocks — and the cost of that isn't the decision, it's having to stop, find the window, and reload the context. Symon closes that gap. You ask "what needs me?" without turning around, and approve the one thing that's blocking, hands still on whatever you were doing.

He runs on the rest of your Mac too, because an operator's day isn't only the fleet:

- **Fleet by voice** — status, what's blocked, what shipped. Approvals ride a *spoken confirm card*: he says what he's about to do and waits, so voice never becomes a way to skip governance.
- **Push-to-talk dictation** anywhere on the machine, with a local polish pass that fixes the transcript without shipping your words to a server.
- **Terminal watching** — "tell me when that finishes" — plus reading what's on screen when you ask about it.
- **The ordinary Mac** — calendar, reminders, mail, music, files, browser. Same confirm-card discipline for anything with a side effect.

## Controls (macOS)

Symon's resting strip lives at the top of the display and keeps working when the main o8 window is hidden.

| Control | What it does |
| --- | --- |
| Hold `Fn` / `🌐` | Dictate into the focused app. Release to polish and paste at the caret. |
| Double-tap `Fn` | Start long-form dictation. Tap `Fn` once to finish, or press `Esc` to cancel. |
| Hold `Control` + `Fn` | Use Smart Compose: describe what you want written, and Symon uses the current screen and caret context to write and insert it. |
| Hold **right** `Option` | Ask Symon a question or give it a command. Release to send. Left Option remains a normal modifier. |
| Double-tap **right** `Option` | Start a long Symon request. Tap right Option once to finish, or press `Esc` to cancel. |
| Double-tap **right** `Command` | Start or stop voice-to-voice mode. |
| `Control` + `Option` + `R` | Read the current text selection aloud. `Control` + `Shift` + `R` is the fallback shortcut. |
| `Command` + `Option` + `V` | Paste the most recent voice dictation again. |
| `Command` + `Shift` + `Space` | Bring o8 to the front. |
| `Command` + `Shift` + `,` | Open o8's main settings. |
| `Esc` | Cancel an active long-form recording, Symon task, or spoken response. |
| Click the resting Symon strip | Show the active and waiting fleet summary when workers are running. |
| Double-click the resting Symon strip | Open Symon's standalone settings, even when the main o8 window is hidden. |
| Drag files onto the Symon strip | Stage them as context for the next right-Option request. |

For first-time setup, double-click the resting strip and open the **Settings** tab. Grant Microphone, Accessibility, and Input Monitoring; grant Screen Recording if you want Symon to understand what's on screen. If `Fn` opens an Apple feature instead, go to **System Settings → Keyboard** and set **Press 🌐 key to** to **Do Nothing**. Relaunch o8 after changing Accessibility or Input Monitoring.

Free tier uses on-device Apple transcription or your own Whisper key. An optional managed voice service (hosted polish, speech-to-speech) is the paid convenience — the app never requires it, and voice is never the only way to do anything.
