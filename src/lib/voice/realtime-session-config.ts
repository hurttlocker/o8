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
  'then answer. Only claim that you opened, changed, sent, or started something after the matching ' +
  'tool returns success; if no tool ran, describe it as an option instead. ' +
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

// ── Phone-only: the client-rendered surface tool ─────────────────────────────
// The paired PHONE (never the Mac) renders the returned openui-lang program as a
// visual card under Symon's spoken reply, using the same o8 gen-UI catalog Ask
// uses. The mobile client intercepts this tool call locally and does NOT relay
// it to the Mac, so there is no Rust handler and the desk-mic session never sees
// it — the session route appends the tool + guidance to the PHONE mint only.
// Keep the tool name + `program` arg in lockstep with the mobile client's
// SYMON_SURFACE_TOOL interceptor (o8-mobile: src/features/symon/use-symon-agent.ts).

/** Shared contract token — must equal the mobile SYMON_SURFACE_TOOL constant. */
export const SURFACE_TOOL_NAME = 'render_surface';

/** OpenAI-realtime-shaped tool schema (matches the `{ type:'function', … }` set). */
export const RENDER_SURFACE_TOOL: Record<string, unknown> = {
  type: 'function',
  name: SURFACE_TOOL_NAME,
  description:
    'Render a compact visual card on the operator’s PHONE screen, under your spoken reply — ' +
    'a checklist, a few key stats, a status, a small comparison. Call it when a glanceable layout ' +
    'helps more than speech (steps to follow, numbers to scan, options to weigh). You STILL speak a ' +
    'short summary and never read the card aloud. Most replies need no card — only call it when it ' +
    'genuinely helps. The single argument `program` is a raw openui-lang program for the o8 surface ' +
    'catalog described in your instructions (no <o8-surface> wrapper, no code fences).',
  parameters: {
    type: 'object',
    properties: {
      program: {
        type: 'string',
        description:
          'A raw openui-lang program. First line is the root Surface; each named child is its own ' +
          'statement referenced from a parent’s children array. Use ONLY facts already in the conversation.',
      },
    },
    required: ['program'],
  },
};

/**
 * Appended to {@link DEFAULT_INSTRUCTIONS} for the PHONE mint only. Teaches Symon
 * a compact, reliable core of the o8 gen-UI catalog — deliberately a subset of
 * the mobile authoring library (which owns the RENDER catalog and stays the
 * source of truth). Signatures are positional and match the render library's
 * schemas exactly; `dotState` = idle | running | review | rejected | failed | merged.
 */
export const PHONE_SURFACE_INSTRUCTIONS =
  '\n\nSHOWING THINGS ON THE PHONE. When a glanceable visual would help more than speech — steps to ' +
  'follow, a handful of numbers, a status, options to weigh — call the render_surface tool with an ' +
  'openui-lang `program`, then speak a one-line summary. Do not read the card aloud, do not describe ' +
  'its markup, and skip it for ordinary replies. Use only facts already in the conversation — never ' +
  'invent numbers, sources, weather, or air quality. ' +
  'openui-lang: one statement per line as `name = Component(args)`. The FIRST line must be ' +
  '`root = Surface(title, subtitle_or_null, [childName, …])`, and each childName is its own statement ' +
  'below it. Never send a root-only shell: the root children array must be non-empty, every referenced ' +
  'child must have a declaration, and every declaration must use one of the exact signatures and enum ' +
  'values below. Named arguments such as `title:` or `dotState:` are unsupported — use positional ' +
  'arguments only. Before calling render_surface, check those rules yourself. Positional arguments ' +
  '(JSON for objects/arrays, bare names for child references):\n' +
  '• Surface(title, subtitle|null, [children]) — required root shell.\n' +
  '• TextBlock(content, "muted"|"highlight"|null) — one short supporting line.\n' +
  '• Metric(label, value, "up"|"down"|"flat"|null, dotState|null) — one number.\n' +
  '• StatusCard(title, dotState, message, sourceLabel|null, progressPct|null) — one status; dotState is ' +
  'exactly idle|running|review|rejected|failed|merged. Metric trends such as flat are invalid here.\n' +
  '• StatTiles([{"label":"…","value":"…"}, …]) — up to six compact facts.\n' +
  '• Checklist(title, [{"id":"a","label":"…","checked":false}, …]) — tappable steps.\n' +
  '• OptionList(question, [{"id":"a","label":"…"}, …]) — a local single choice.\n' +
  '• Comparison(title, [{"id":"a","title":"…","facts":[{"label":"…","value":"…"}]}, …]) — weigh 2–4 options.\n' +
  'Example:\n' +
  'root = Surface("A simple plan", null, [steps])\n' +
  'steps = Checklist("Next steps", [{"id":"one","label":"Pick a date","checked":false},{"id":"two","label":"Confirm who is coming","checked":false}])';

/**
 * Appended only when the PHONE launches Symon from the Code workspace. The
 * renderer remains shared with Life, but these components carry revisioned
 * repository/run identities and governed actions that make sense only in Code.
 */
export const PHONE_CODE_SURFACE_INSTRUCTIONS =
  '\n\nCODE WORKSPACE SURFACES. In Code, prefer the following components when trusted tool results ' +
  'supply the facts and identifiers. Never infer a targetId, sessionKey, path, ref, SHA, count, ' +
  'check state, progress value, approval scope, or diff line. When the phone context includes ' +
  'repoName/repoPath, that is the operator-selected repository: do not ask which repo, and use ' +
  'repoName as the repo argument for read-only repository tools. The selection may choose which ' +
  'tool to call, but it is not proof of repository state. Fetch current state first, keep ' +
  'diffs bounded to the supplied revision, and mark truncated data honestly. Signatures:\n' +
  '• RepoState(targetId, name, path|null, branch, headSha|null, state, changedFiles, ahead?, behind?) ' +
  'where state = clean|modified|conflicted|syncing|unavailable.\n' +
  '• ChangeSummary(targetId, title, baseRef|null, headRef|null, filesChanged, additions, deletions, files, truncated?) ' +
  'where files contain {path,status,additions?,deletions?} and status = added|modified|deleted|renamed|untracked.\n' +
  '• CheckRunList(targetId, title, checks) where checks contain {id,name,status,detail?,duration?} and ' +
  'status = queued|running|passed|failed|cancelled.\n' +
  '• AgentRun(targetId, agent, task, status, phase|null, repo|null, progress|null, sessionKey|null).\n' +
  '• DiffPreview(targetId, file, language|null, hunks, truncated?) where each hunk is ' +
  '{header,lines:[{kind,oldLine?,newLine?,content}]} and kind = context|addition|deletion.\n' +
  '• CommitSummary(targetId, sha, title, author, relativeTime|null, filesChanged, additions, deletions).\n' +
  '• ApprovalDecision(targetId, title, summary, requestedBy, repo|null, risk, scope, sessionKey|null) ' +
  'where risk = low|medium|high.\n' +
  '• CodeAction(label, verb, targetId, sessionKey|null, disabled?) where verb = inspect-changes|' +
  'inspect-diff|open-checks|open-commit|open-thread|continue-run|steer-run|approve|reject.\n' +
  '• CodeActionRow([actions], align?) where align = left|right|spread and actions are named CodeAction references.\n' +
  'Every action must reuse an exact tool-supplied targetId; never put source code, shell text, or prose ' +
  'in an action identifier. inspect/open actions only navigate to existing targets. continue-run, ' +
  'steer-run, approve, and reject are consequential and must flow through the existing native ' +
  'confirmation step; never claim they happened because a button was rendered. Pair every ' +
  'ApprovalDecision with explicit approve and reject actions for the same targetId.';

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
  /**
   * Mic noise profile — picks the pre-VAD noise_reduction + server_vad tuning.
   * OMIT to keep OpenAI defaults (the desk mint omits it — Q: "the desk mic was
   * fine"); the Agent-mode mint passes `near_field` (the phone over-triggered
   * on ambient noise, 2026-07-11).
   */
  micProfile?: RealtimeMicProfile;
}

/**
 * Noise gate per mic profile (Q, 2026-07-11: PHONE Symon triggered on ambient
 * noise — OpenAI's default server_vad threshold 0.5 is too hot and
 * noise_reduction defaults to OFF; the desk mic was explicitly FINE, so the
 * desk mint stays gate-free/byte-identical). `noise_reduction` filters audio
 * BEFORE VAD sees it; the raised `threshold` is the gate; the longer
 * `silence_duration_ms` stops noise blips ending turns mid-thought.
 * semantic_vad was evaluated and rejected — it tunes turn-ENDS on clean audio,
 * not noise wake-ups. Ref: developers.openai.com/api/docs/guides/realtime-vad.
 * NOTE: noise_reduction must be an OBJECT `{ type }` — a bare string 400s.
 * far_field is defined for a future desk/room profile; nothing passes it yet.
 */
export type RealtimeMicProfile = 'far_field' | 'near_field';
export const MIC_PROFILE_AUDIO_INPUT: Record<
  RealtimeMicProfile,
  { turn_detection: Record<string, unknown>; noise_reduction: { type: string } }
> = {
  far_field: {
    turn_detection: {
      type: 'server_vad',
      threshold: 0.8,
      prefix_padding_ms: 300,
      silence_duration_ms: 800,
    },
    noise_reduction: { type: 'far_field' },
  },
  near_field: {
    turn_detection: {
      type: 'server_vad',
      threshold: 0.75,
      prefix_padding_ms: 300,
      silence_duration_ms: 700,
    },
    noise_reduction: { type: 'near_field' },
  },
};

/**
 * Assemble the `session` object for `POST /v1/realtime/client_secrets`. Pure +
 * deterministic — identical inputs always produce a deep-equal object, which is
 * exactly what the parity unit test asserts across the desk and mobile callers.
 *
 * Desk callers pass `{ model, voice }` → the legacy minimal shape
 * (`{ type:'realtime', model, audio:{ output:{ voice } } }`), byte-identical to
 * before — the desk mic is deliberately untouched. Agent-mode callers
 * additionally pass `instructions`, `tools`, `inputTranscriptionModel`, and
 * `micProfile: 'near_field'` (the phone noise gate, 2026-07-11).
 */
export function buildRealtimeMintSession(inputs: RealtimeMintInputs): Record<string, unknown> {
  const { model, voice, instructions, tools, inputTranscriptionModel } = inputs;

  // The noise gate ships ONLY when a micProfile is passed (the phone mint);
  // desk mints omit it and stay byte-identical to the pre-gate shape.
  const input: Record<string, unknown> = inputs.micProfile
    ? { ...MIC_PROFILE_AUDIO_INPUT[inputs.micProfile] }
    : {};
  if (inputTranscriptionModel) {
    input.transcription = { model: inputTranscriptionModel };
  }
  const audio: Record<string, unknown> = { output: { voice } };
  if (Object.keys(input).length > 0) {
    audio.input = input;
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
