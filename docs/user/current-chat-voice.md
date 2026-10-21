# Voice in the current chat

The microphone button dictates into a draft. The waveform button offers conversation
with the assistant in the selected chat. These controls have different purposes:
ordinary dictation does not submit a task automatically.

## Choose an experience

| Intent | Entry | Voice service | What receives the request |
| --- | --- | --- | --- |
| Write a draft by speaking | Composer microphone | Native macOS transcription, or the configured dictation provider | That composer's draft; review and send normally |
| Speak one turn and hear its answer | Waveform → Turn-by-turn | Existing dictation, then Edge speech with system speech fallback where available | The selected chat's existing agent |
| Converse continuously | Waveform → Live with my key | OpenAI GPT-Live using your configured OpenAI API key | Speech stays in this chat; work uses its selected agent |
| Give an instruction about an image | Existing visual instruction control | Image capture/marking plus the selected input method | The existing visual draft and governed chat queue |
| Hear an existing answer | Message read-aloud control | Your configured playback provider | No new agent task |

Turn-by-turn is an explicit choice for the current mounted chat. Finish dictation
to submit that turn; after the result, use the microphone for another turn. Only
the accepted turn's confirmed terminal result is read aloud. Partial text, a
temporarily idle agent or a disconnected socket does not prove completion.
Stopping conversation stops its recording and playback; it does not cancel a
CLI task already submitted. Use the existing task Stop control for that.

On macOS, native dictation needs no separate voice API key. Edge playback needs
network access but no personal voice key. System speech is a fallback only when
the webview exposes it. Browser dictation has different provider requirements;
this is not a promise of free or offline browser transcription.

## Use a personal OpenAI key

Add an OpenAI API key in **Settings → Providers → OpenAI**, then explicitly choose **Live with
my key**. The key's OpenAI project must have GPT-Live access. A configured key is
not proof of model access or available API credit. OpenAI bills that project's
voice usage separately from the selected agent's inference. A chat subscription
or CLI sign-in does not supply an OpenAI API key.

The app keeps the long-lived key on its local server side. The webview receives
an opaque local session ID and the WebRTC answer. It cannot select a provider
endpoint or take control of another chat's voice session. Choosing a key never
silently falls back to managed voice, and a managed refusal never silently uses
your key.

The app requests closure after five minutes and on Stop. This is a local close
request, **not a provider-enforced spending ceiling**. A connection or server
failure can leave closure and final usage unresolved. The local receipt is kept
and further personal-key admission is refused until closure can be confirmed.
Do not delete receipts to force a retry. Restart recovery can request closure of
a known provider session; a lost creation response without a provider ID still
requires provider-side investigation.

## Access is separate from installation and plan

| User | Native draft dictation / Edge turn-by-turn | Personal-key Live | Managed Live |
| --- | --- | --- | --- |
| Source build, signed out | Available with native permissions and a working selected agent | Explicit personal key with GPT-Live access | No general entitlement |
| Website download, free or signed out | Same native path; no separate voice key | Same personal-key requirements | No general entitlement |
| Lifetime Pro | Same native path | Same personal-key requirements | Only an independently authorized pilot |
| Subscription | Same native path | Same personal-key requirements | Only an independently authorized pilot |

Distribution channel, account plan, voice credentials and agent credentials are
independent. No row promises free CLI inference. The selected agent must have its
own supported authentication. Native permissions are required regardless of plan
or key. Image capture additionally requires the existing screen-recording grant.

The approved managed pilot retains its direct waveform/Caps Lock start and stop.
Open that waveform's alternate choices with right-click or keyboard Arrow Down.
For other users, the waveform or Caps Lock opens the choices without starting a
provider session. Pilot availability is not a general paid-plan benefit.

## Acceptance checklist for a signed-out Mac

Run these through the ordinary installed app when the candidate is released for
testing. Source tests alone do not establish microphone or speaker acceptance.

- [ ] With no OpenAI key, dictate into one composer. Other microphones stay idle;
      the text remains a draft and creates no task.
- [ ] Select turn-by-turn. Speak one bounded request, finish recording, observe
      exactly one user turn and hear only its correlated completed result.
- [ ] Stop during recording, CLI work and playback. Recording/playback end;
      already submitted CLI work keeps its normal lifecycle.
- [ ] Change chats with a late transcript or result pending. Nothing appears,
      submits or speaks in the newly selected chat without a new request.
- [ ] With no key, Live explains setup and does not contact a provider.
- [ ] Add a project key with GPT-Live access. Explicitly select personal-key
      Live; verify speech bubbles, one delegated CLI task and its actual result.
- [ ] Stop Live and verify provider-confirmed closure and final usage. A local
      disappearance of the overlay is not sufficient evidence.
- [ ] Exercise a network interruption. Unknown closure must remain visible and
      block a second admission; no automatic change of key or payer occurs.
- [ ] Test both visual/voice start orders using one marked image; verify the
      existing visual queue accepts one instruction in the intended chat.

Record OS/app version, selected agent, chosen voice mode, observed task count,
closure outcome and any audio/transcript delay. Keep credentials and raw private
conversation out of public reports.
