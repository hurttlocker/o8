/**
 * Symon Realtime — shared session-config assembly (Agent Mode parity source).
 *
 * SINGLE SOURCE OF TRUTH for the realtime session config (model / voice /
 * instructions / input-transcription / OpenAI client_secrets body shape) used by
 * BOTH the desk-mic mint (`/api/voice/realtime/session` + `/sdp`) and the
 * phone-hosted Agent-mode mint (`/api/mobile/symon/session`). The contract
 * (docs/symon-agent-mode.md) makes config parity a hard requirement: the phone
 * session must carry the SAME config the desk session uses, assembled from this
 * module — never a copy-paste snapshot.
 *
 * ISOMORPHIC by design — pure constants + a pure builder, NO `server-only` and
 * NO browser-only imports — so the server mint routes AND the browser realtime
 * client (`realtime-client.ts`, which forbids server imports) can both import it.
 * The Rust-supplied tool schemas are the ONE piece this module cannot produce
 * (they originate in `realtime_tools()` and only reach the webview); callers pass
 * them in via {@link RealtimeMintInputs.tools}.
 */

// Q trial 2026-07-07: gpt-realtime-2.1-mini (announced 07-06) — mini reasoning
// realtime model, text in/out 85%/90% cheaper than gpt-realtime-2. Revert to the
// flagship by setting 'gpt-realtime-2.1' (or 'gpt-realtime-2'). Kept here so the
// desk mint, the sdp relay, and the Agent-mode mint can never drift apart.
export const REALTIME_MODEL = 'gpt-realtime-2.1-mini';
export const DEFAULT_VOICE = 'marin';
/** Input transcription model the desk session applies via `session.update`. */
export const REALTIME_INPUT_TRANSCRIPTION_MODEL = 'whisper-1';
export const CLIENT_SECRETS_URL = 'https://api.openai.com/v1/realtime/client_secrets';
export const REALTIME_CALLS_URL = 'https://api.openai.com/v1/realtime/calls';
export const REALTIME_BASE_URL = 'https://api.openai.com/v1/realtime';
export const REALTIME_TOKEN_TTL_SECONDS = 600;

/**
 * Symon's persona + tool-use policy. MOVED here from realtime-client.ts so the
 * desk session and the phone-hosted Agent-mode session speak with the identical
 * brain. Changing Symon's instructions changes BOTH surfaces from one edit.
 */
export const DEFAULT_INSTRUCTIONS =
  "You are Symon, the voice of o8 — the operator's desktop command surface. " +
  'Speak naturally and concisely, like a sharp teammate who is easy to talk to; ' +
  'keep replies short since they are spoken aloud. ' +
  'You can act on the operator’s machine through tools. Before you run a tool that ' +
  'changes something — dispatching agents, sending mail, running commands, editing ' +
  'files — say in one short sentence what you are about to do; some actions pop an ' +
  'approval card the operator taps to allow, so your heads-up tells them why. ' +
  'Read-only lookups — status, lists, "what\'s running", asking the Brain — just do, ' +
  'then answer. ' +
  'You are the CONDUCTOR, not the whole orchestra — route each request to whoever does ' +
  'it best, then narrate. Do simple things yourself: status, lists, what is running, ' +
  'weather, music, volume, opening a surface, a quick Brain question. For anything DEEP ' +
  'or multi-step — writing or changing code, figuring something out, showing or ' +
  'rendering something on the operator screen, work that needs several tools — hand it ' +
  'to the live agent with o8_delegate and narrate what is happening while it works, ' +
  'rather than doing that heavy lifting yourself. Use o8_dispatch when they want a ' +
  'separate tracked coding worker in a worktree; use o8_delegate when they want the ' +
  'agent to act live, right now. ' +
  'Never read long tool output back verbatim; summarize the part that ' +
  'answers the question. When something is ambiguous, ask one short question instead ' +
  'of guessing.';

export interface RealtimeMintInputs {
  /** Realtime model id. */
  model: string;
  /** OpenAI realtime voice. */
  voice: string;
  /**
   * System prompt / persona. OMIT for the desk mint (the desk client applies it
   * client-side via `session.update`); PASS for the Agent-mode mint so the phone
   * — a dumb pipe that never sees the persona — gets it baked into the token.
   */
  instructions?: string;
  /**
   * OpenAI-function-shaped tool schemas (`realtime_tools()` output, each already
   * `{ type:'function', ... }`). OMIT for the desk mint; PASS for Agent mode.
   */
  tools?: Array<Record<string, unknown>>;
  /**
   * Input-audio transcription model. OMIT for the desk mint (applied client-side);
   * PASS for Agent mode so the phone gets transcription without knowing it.
   */
  inputTranscriptionModel?: string;
}

/**
 * Assemble the `session` object for `POST /v1/realtime/client_secrets`. Pure +
 * deterministic — identical inputs always produce a deep-equal object, which is
 * exactly what the parity unit test asserts across the desk and mobile callers.
 *
 * Desk callers pass `{ model, voice }` → the legacy minimal shape
 * (`{ type:'realtime', model, audio:{ output:{ voice } } }`), so desk behavior is
 * byte-identical to before this refactor. Agent-mode callers additionally pass
 * `instructions`, `tools`, and `inputTranscriptionModel`.
 */
export function buildRealtimeMintSession(inputs: RealtimeMintInputs): Record<string, unknown> {
  const { model, voice, instructions, tools, inputTranscriptionModel } = inputs;

  const audio: Record<string, unknown> = { output: { voice } };
  if (inputTranscriptionModel) {
    audio.input = { transcription: { model: inputTranscriptionModel } };
  }

  const session: Record<string, unknown> = { type: 'realtime', model, audio };
  if (instructions) {
    session.instructions = instructions;
  }
  if (Array.isArray(tools) && tools.length > 0) {
    session.tools = tools;
    session.tool_choice = 'auto';
  }
  return session;
}

/** Full `client_secrets` request body (`expires_after` + `session`). */
export function buildClientSecretsBody(
  inputs: RealtimeMintInputs,
  ttlSeconds: number = REALTIME_TOKEN_TTL_SECONDS,
): Record<string, unknown> {
  return {
    expires_after: { anchor: 'created_at', seconds: ttlSeconds },
    session: buildRealtimeMintSession(inputs),
  };
}
