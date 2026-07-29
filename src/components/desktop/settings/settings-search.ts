/**
 * settings-search — static registry + matcher behind the Settings nav search.
 *
 * The registry is hand-authored from the rendered rows of every settings tab
 * (Cursor-parity pass, 2026-07-13). It deliberately duplicates row labels
 * rather than importing tab internals: search must stay cheap to render and
 * must never mount a tab to know what's inside it. When a tab gains or loses
 * a row, update its entries here — the nav search is the only consumer.
 */

import type { SettingsTab } from './shared';

export type SettingsSearchEntry = {
  tab: SettingsTab;
  tabLabel: string;
  /** GroupHeader the row sits under; omitted for tab-level matches. */
  group?: string;
  label: string;
  description?: string;
  /** Extra match terms beyond label/group/description. */
  keywords?: string[];
  /** Row only renders for founder entitlement — hide from non-founders. */
  founders?: boolean;
};

export type SettingsSearchMatch = SettingsSearchEntry & { score: number };

const MAX_RESULTS = 14;

export function searchSettings(
  registry: SettingsSearchEntry[],
  rawQuery: string,
  opts: { founder: boolean },
): SettingsSearchMatch[] {
  const query = rawQuery.trim().toLowerCase();
  if (query.length < 2) return [];
  const tokens = query.split(/\s+/).filter(Boolean);
  const matches: SettingsSearchMatch[] = [];
  for (const entry of registry) {
    if (entry.founders && !opts.founder) continue;
    const label = entry.label.toLowerCase();
    const group = entry.group?.toLowerCase() ?? '';
    const description = entry.description?.toLowerCase() ?? '';
    const tabLabel = entry.tabLabel.toLowerCase();
    const keywords = (entry.keywords ?? []).join(' ').toLowerCase();
    let score = 0;
    let allTokensHit = true;
    for (const token of tokens) {
      if (label.startsWith(token)) score += 6;
      else if (label.includes(token)) score += 4;
      else if (group.includes(token) || tabLabel.includes(token)) score += 3;
      else if (keywords.includes(token)) score += 2;
      else if (description.includes(token)) score += 1;
      else { allTokensHit = false; break; }
    }
    if (!allTokensHit || score === 0) continue;
    matches.push({ ...entry, score });
  }
  matches.sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));
  return matches.slice(0, MAX_RESULTS);
}

/** Registry population is generated from the tab inventory — see module doc. */
export const SETTINGS_SEARCH_REGISTRY: SettingsSearchEntry[] = [
  { tab: 'git-prs', tabLabel: 'Git & PRs', group: "GitHub", label: "Identity", description: "Connect GitHub, manage the account, or sign out", keywords: ['sign in', 'sign out', 'login', 'identity', 'profile', 'github'] },
  { tab: 'general', tabLabel: 'General', group: "Privacy", label: "Share usage data", description: "Allowlisted product events; optional and off by default", keywords: ['telemetry', 'usage', 'analytics', 'privacy'] },
  { tab: 'general', tabLabel: 'General', group: "Plan", label: "Plan", description: "Your current plan and founder status", keywords: ['founder', 'free', 'subscription'] },
  { tab: 'general', tabLabel: 'General', group: "Plan", label: "Upgrade to Pro", description: "o8 is free — founding passes fund the build", keywords: ['upgrade', 'founder', 'pricing', 'pro'] },
  { tab: 'general', tabLabel: 'General', group: "Startup", label: "Launch at login", description: "Start o8 automatically when you sign in to your Mac", keywords: ['autostart', 'boot', 'startup'] },
  { tab: 'general', tabLabel: 'General', group: "Privacy", label: "Share crash & error data — also required to send bug reports", description: "Optionally send scrubbed error messages, stack traces, and user-initiated bug reports", keywords: ['telemetry', 'sentry', 'privacy', 'bug reports'] },
  { tab: 'general', tabLabel: 'General', group: "Privacy", label: "Send local crash log to the o8 team", description: "Upload the local ~/.o8/telemetry crash log", keywords: ['telemetry', 'privacy'] },
  { tab: 'git-prs', tabLabel: 'Git & PRs', group: "Branches", label: "Branch prefix", description: "Prefix for branches agents create from issues", keywords: ['git', 'worktree', 'branch', 'naming'] },
  { tab: 'git-prs', tabLabel: 'Git & PRs', group: "Attribution", label: "Tag commits created by agents", description: "Append a Co-Authored-By trailer to agent commits", keywords: ['git', 'commit', 'attribution', 'co-authored'] },
  { tab: 'git-prs', tabLabel: 'Git & PRs', group: "Pull requests", label: "PR link destination", description: "Open pull request links inside o8 or in your browser", keywords: ['git', 'github', 'pull request', 'browser'] },
  { tab: 'models', tabLabel: 'Models', group: "Runtimes", label: "Runtimes", description: "Per-runtime detection, enable toggles, and worker effort", keywords: ['codex', 'claude', 'gemini', 'opencode', 'cursor', 'grok', 'runtime', 'effort'] },
  { tab: 'models', tabLabel: 'Models', group: "Orchestrator", label: "Orchestrator model", description: "Which Claude model orchestrates", keywords: ['opus', 'sonnet', 'orchestrator'] },
  { tab: 'models', tabLabel: 'Models', group: "API keys", label: "API keys", description: "Bring your own provider keys", keywords: ['byok', 'anthropic', 'openai', 'openrouter', 'gemini', 'key'] },
  { tab: 'models', tabLabel: 'Models', group: "Local models", label: "Local models", description: "Ollama endpoint for Brain and dictation polish", founders: true, keywords: ['ollama', 'local', 'offline'] },
  { tab: 'operator-defaults', tabLabel: 'Dispatch', group: "Worktrees", label: "Max worktrees", description: "Cap how many packet worktrees stay on disk — oldest safe ones reclaimed first", keywords: ['worktree', 'retention', 'disk', 'workspace', 'cleanup'] },
  { tab: 'operator-defaults', tabLabel: 'Dispatch', group: "Worktrees", label: "Max total size (GB)", description: "Disk ceiling for .cortex-worktrees across repos", keywords: ['worktree', 'disk', 'size', 'storage'] },
  { tab: 'indexing', tabLabel: 'Indexing', group: "Repositories", label: "Repository index", description: "Per-repo index status with a Reindex action", keywords: ['index', 'reindex', 'codebase', 'cortex', 'search'] },
  { tab: 'indexing', tabLabel: 'Indexing', group: "Engineering Brain", label: "Brain knowledge", description: "Directives and ledger outcomes the Brain cites", keywords: ['brain', 'memory', 'directives', 'cortex'] },
  { tab: 'about', tabLabel: 'About', group: "Developer", label: "Preview onboarding", description: "Runs the flow without resetting state (dev builds only)" },
  { tab: 'about', tabLabel: 'About', group: "Developer", label: "Reset + run onboarding", description: "Clears setup state and restarts the flow (dev builds only)" },
  { tab: 'about', tabLabel: 'About', group: "Links", label: "Documentation", description: "Architecture, workflows, and guides" },
  { tab: 'about', tabLabel: 'About', group: "Links", label: "GitHub", description: "hurttlocker/o8" },
  { tab: 'about', tabLabel: 'About', group: "Links", label: "Releases", description: "Changelog and downloads" },
  { tab: 'about', tabLabel: 'About', group: "Onboarding", label: "Replay onboarding", description: "Replays the welcome flow (intro, repos, runtimes)" },
  { tab: 'appearance', tabLabel: 'Appearance', group: "Interface", label: "Session timeline", description: "Activity strip below the title bar" },
  { tab: 'appearance', tabLabel: 'Appearance', group: "Interface", label: "Window chrome", description: "Glass follows your wallpaper; solid is opaque (System/Glass/Solid)" },
  { tab: 'appearance', tabLabel: 'Appearance', group: "Palette", label: "Palette", description: "Selectable theme preview cards; founders-only palettes hidden unless founders", founders: true },
  { tab: 'billing', tabLabel: 'Plan & Billing', label: "Have a license key?", description: "Founding passes activate here \u2014 or just sign in (expander row)" },
  { tab: 'billing', tabLabel: 'Plan & Billing', label: "License key textarea", description: "Paste a signed license/founding pass (o8_live_...)" },
  { tab: 'billing', tabLabel: 'Plan & Billing', group: "Current plan", label: "What's coming", description: "Opens o8.run/pricing (button, shown only when not on a paid plan)" },
  { tab: 'billing', tabLabel: 'Plan & Billing', group: "Paid \u2014 coming soon", label: "Cloud agents", description: "Agents that keep running while your laptop is closed." },
  { tab: 'billing', tabLabel: 'Plan & Billing', group: "Paid \u2014 coming soon", label: "Managed inference", description: "Hosted, metered model access for the Brain + voice \u2014 no key to bring." },
  { tab: 'billing', tabLabel: 'Plan & Billing', group: "Paid \u2014 coming soon", label: "Off-network mobile relay", description: "Reach your Mac from anywhere \u2014 even asleep or behind NAT." },
  { tab: 'billing', tabLabel: 'Plan & Billing', group: "What's included", label: "Engineering Brain", description: "Cited organizational-memory Q&A across your codebase." },
  { tab: 'billing', tabLabel: 'Plan & Billing', group: "What's included", label: "Governance review", description: "Single-pass merge gate + AI blind second-pass before merge." },
  { tab: 'billing', tabLabel: 'Plan & Billing', group: "What's included", label: "Mobile on your network", description: "Drive approvals + dispatch from the app over LAN / Tailscale." },
  { tab: 'billing', tabLabel: 'Plan & Billing', group: "What's included", label: "Multi-repo fleet", description: "Run the orchestrator across as many repos as you want." },
  { tab: 'billing', tabLabel: 'Plan & Billing', group: "What's included", label: "Orchestration & dispatch", description: "Plan, dispatch, and supervise agents across your repos." },
  { tab: 'billing', tabLabel: 'Plan & Billing', group: "What's included", label: "Voice & dictation", description: "Local Symon dictation and read-aloud \u2014 free forever." },
  { tab: 'connections', tabLabel: 'Mobile', group: "Paired devices", label: "Refresh" },
  { tab: 'connections', tabLabel: 'Mobile', group: "Remote access", label: "Connect this Mac", description: "Keep an authenticated outbound connection to the o8 relay", keywords: ['connect', 'relay', 'remote', 'web', 'machine'] },
  { tab: 'connections', tabLabel: 'Mobile', group: "Pairing", label: "Show pairing QR", description: "button dispatching the mobile pairing QR fullscreen view" },
  { tab: 'git-prs', tabLabel: 'Git & PRs', group: "GitHub", label: "Repository & CLI access", description: "Connect GitHub through device flow or an access token" },
  { tab: 'git-prs', tabLabel: 'Git & PRs', group: "GitHub", label: "Automation app", description: "Install or manage the o8 GitHub App" },
  { tab: 'diagnostics', tabLabel: 'Diagnostics', group: "Danger", label: "Factory reset", description: "Wipes ~/.o8 \u2014 sessions, keys, mission state, watched repos; opens confirm modal" },
  { tab: 'diagnostics', tabLabel: 'Diagnostics', group: "Demo sequence", label: "Run demo sequence", description: "Button drives live webview dashboard \u2192 Orchestrator tab \u2192 quick action, read-only", founders: true },
  { tab: 'diagnostics', tabLabel: 'Diagnostics', group: "Loop status", label: "Recent merges", description: "Disclosure toggle expanding the last 5 merge commits (interactive only when commits exist)", founders: true },
  { tab: 'diagnostics', tabLabel: 'Diagnostics', group: "Maintenance", label: "Prune Codex session archive", description: "Archive sessions older than 14 days; Prune button" },
  { tab: 'diagnostics', tabLabel: 'Diagnostics', group: "Runtimes", label: "Runtime diagnostics", description: "Last checked <time> / Not yet checked; Re-run button refreshes tool detection" },
  { tab: 'mcp', tabLabel: 'MCP', group: "Clients", label: "Claude Code", description: "dynamic connect status: Connected / Ready to connect / Not connected (Install, Update, Remove)" },
  { tab: 'mcp', tabLabel: 'MCP', group: "Clients", label: "Claude Desktop", description: "dynamic connect status: Connected / Ready to connect / Not connected (Install, Update, Remove)" },
  { tab: 'mcp', tabLabel: 'MCP', group: "Clients", label: "Hermes Agent", description: "dynamic status: CLI not found / Ready to connect / Connected (Install, Remove)" },
  { tab: 'mcp', tabLabel: 'MCP', group: "Clients", label: "OpenClaw", description: "dynamic status: CLI not found / Ready to connect / Connected (Install, Remove)" },
  { tab: 'mcp', tabLabel: 'MCP', group: "Diagnostics", label: "Manual config", description: "Prefer to edit the file yourself? (disclosure with copy config button)" },
  { tab: 'mcp', tabLabel: 'MCP', group: "Diagnostics", label: "System details", description: "Show the runtime environment o8 is using. (disclosure)" },
  { tab: 'mcp', tabLabel: 'MCP', group: "External servers", label: "Enabled/Disabled", description: "SettingsToggleButton for new server enabled state" },
  { tab: 'mcp', tabLabel: 'MCP', group: "External servers", label: "Manual setup", description: "disclosure toggle opening the field-by-field add-server form" },
  { tab: 'mcp', tabLabel: 'MCP', group: "External servers", label: "add a server", description: "smart-add textarea: paste a config JSON, an npx command line, or a server URL" },
  { tab: 'mcp', tabLabel: 'MCP', group: "External servers", label: "add server", description: "submit button for manual add form" },
  { tab: 'mcp', tabLabel: 'MCP', group: "External servers", label: "args json array", description: "textarea, stdio transport only (manual form)" },
  { tab: 'mcp', tabLabel: 'MCP', group: "External servers", label: "command / endpoint url", description: "text input (npx command or https endpoint, manual form)" },
  { tab: 'mcp', tabLabel: 'MCP', group: "External servers", label: "env json object", description: "textarea, stdio transport only (manual form)" },
  { tab: 'mcp', tabLabel: 'MCP', group: "External servers", label: "transport", description: "stdio / http toggle pills (manual form)" },
  { tab: 'operator-defaults', tabLabel: 'Dispatch', group: "Brain routing", label: "Brain uses Claude CLI", description: "Warm claude CLI answers (~2.7s Haiku), sub-billed", founders: true },
  { tab: 'operator-defaults', tabLabel: 'Dispatch', group: "Brain routing", label: "Collide aggregator", description: "Who synthesizes when the Collide backend runs", founders: true },
  { tab: 'operator-defaults', tabLabel: 'Dispatch', group: "Brain routing", label: "Legacy orchestrator toggle", description: "What backend Auto follows: on = Claude REPL, off = Codex", founders: true },
  { tab: 'operator-defaults', tabLabel: 'Dispatch', group: "Brain routing", label: "Q&A composer", description: "Class A composer for Brain answers", founders: true },
  { tab: 'operator-defaults', tabLabel: 'Dispatch', group: "Brain routing", label: "Workers use the Brain", description: "Teach dispatched workers o8 ask for cited repo answers", founders: true },
  { tab: 'operator-defaults', tabLabel: 'Dispatch', group: "Dispatch runtime", label: "Claude worker effort", description: "Fallback effort for spawned Claude Code workers" },
  { tab: 'operator-defaults', tabLabel: 'Dispatch', group: "Dispatch runtime", label: "Codex worker effort", description: "Fallback effort for spawned Codex workers" },
  { tab: 'operator-defaults', tabLabel: 'Dispatch', group: "Dispatch runtime", label: "Default worker", description: "Codex by default \u2014 pick any installed dispatchable runtime to override (may be profile-pinned)" },
  { tab: 'operator-defaults', tabLabel: 'Dispatch', group: "Dispatch runtime", label: "Subscription profile", description: "Use both houses by default \u00b7 Codex/Claude auth status \u00b7 optional profile hint" },
  { tab: 'operator-defaults', tabLabel: 'Dispatch', group: "Experimental", label: "Canvas mode", description: "The glass canvas \u2014 voice-first fleet surface. Sole gate.", founders: true },
  { tab: 'operator-defaults', tabLabel: 'Dispatch', group: "Experimental", label: "Gemini runtime", description: "Show Gemini in dispatch + CLI pickers", founders: true },
  { tab: 'operator-defaults', tabLabel: 'Dispatch', group: "Experimental", label: "Native browser-view", description: "Host-owned native window for the Browser pane (macOS)", founders: true },
  { tab: 'operator-defaults', tabLabel: 'Dispatch', group: "Experimental", label: "opencode runtime", description: "Show opencode in dispatch pickers", founders: true },
  { tab: 'operator-defaults', tabLabel: 'Dispatch', group: "Fleet", label: "Agents in flight", description: "Up to N dispatched packets run at once" },
  { tab: 'operator-defaults', tabLabel: 'Dispatch', group: "Fleet", label: "Overlapping work", description: "When two packets predict changes to the same files" },
  { tab: 'operator-defaults', tabLabel: 'Dispatch', group: "Local models", label: "Chat model", description: "Local chat model for Brain compose/classify and dictation polish. Needs the e...", founders: true },
  { tab: 'operator-defaults', tabLabel: 'Dispatch', group: "Local models", label: "Dispatch model", description: "Workers, orchestrator, and Brain answers run on this model; ollama:/lmstudio:...", founders: true },
  { tab: 'operator-defaults', tabLabel: 'Dispatch', group: "Local models", label: "Embedding model", description: "Local embedding model for the Brain (e.g. nomic-embed-text). Needs the endpoi...", founders: true },
  { tab: 'operator-defaults', tabLabel: 'Dispatch', group: "Local models", label: "Local endpoint", description: "OpenAI-compatible base URL for local Brain embedding and chat calls. No trail...", founders: true },
  { tab: 'operator-defaults', tabLabel: 'Dispatch', group: "Model tiers", label: "Adaptive orchestrator thinking", description: "New turns default to adaptive and can stream summarized reasoning", founders: true },
  { tab: 'operator-defaults', tabLabel: 'Dispatch', group: "Model tiers", label: "Prompt caching", description: "Mark the Anthropic system prompt with cache_control", founders: true },
  { tab: 'operator-defaults', tabLabel: 'Dispatch', group: "Model tiers", label: "Targeting \u2014 action tier", description: "Premium tier: the Dispatch button + hard-file routing", founders: true },
  { tab: 'operator-defaults', tabLabel: 'Dispatch', group: "Model tiers", label: "Targeting \u2014 triage tier", description: "Cheap tier: repo triage, rationales, trivial files", founders: true },
  { tab: 'operator-defaults', tabLabel: 'Dispatch', group: "Model tiers", label: "Thinking effort", description: "Default effort for orchestrator turns", founders: true },
  { tab: 'operator-defaults', tabLabel: 'Dispatch', group: "Orchestrator", label: "Backend", description: "The brain that drives chat and background turns" },
  { tab: 'operator-defaults', tabLabel: 'Dispatch', group: "Orchestrator", label: "Buy-in doc on merge", description: "Generate a shareable HTML buy-in doc (demo-first, plain-language) after a mer..." },
  { tab: 'operator-defaults', tabLabel: 'Dispatch', group: "Orchestrator", label: "Claude model", description: "Powers the Orchestrator tab \u2014 applies to new turns" },
  { tab: 'operator-defaults', tabLabel: 'Dispatch', group: "Orchestrator", label: "Packet explainer", description: "Generate an HTML explainer + quiz for each reviewed packet (non-blocking)" },
  { tab: 'operator-defaults', tabLabel: 'Dispatch', group: "Orchestrator", label: "Quiz-gated merge", description: "Block the human Merge button on large packets until the explainer quiz is pa..." },
  { tab: 'operator-defaults', tabLabel: 'Dispatch', group: "Orchestrator", label: "Reviewer", description: "Who reviews finished lanes before merge \u2014 Follow rides the Backend above" },
  { tab: 'operator-defaults', tabLabel: 'Dispatch', group: "Supervision", label: "Auto-apply updates", description: "Install downloaded updates when everything is idle" },
  { tab: 'operator-defaults', tabLabel: 'Dispatch', group: "Supervision", label: "Auto-escalate to chat", description: "Surface supervisor failures in the orchestrator chat" },
  { tab: 'operator-defaults', tabLabel: 'Dispatch', group: "Supervision", label: "Heal-bot", description: "Attempt an automatic fix before asking a human" },
  { tab: 'projects', tabLabel: 'Projects', label: "Add files", description: "Card row, disabled, value Soon" },
  { tab: 'projects', tabLabel: 'Projects', label: "Delete", description: "Project card action; opens inline Confirm/Cancel strip" },
  { tab: 'projects', tabLabel: 'Projects', label: "Edit", description: "Project card action; opens embedded edit form" },
  { tab: 'projects', tabLabel: 'Projects', label: "Group / Dismiss", description: "Org auto-suggest strip actions (OrgSuggestionStrip)" },
  { tab: 'projects', tabLabel: 'Projects', label: "Instructions (card)", description: "None yet \u2014 add standing guidance for agents" },
  { tab: 'projects', tabLabel: 'Projects', label: "Locks", description: "Card row: active/stale lock count; expands lock list + Archive" },
  { tab: 'projects', tabLabel: 'Projects', label: "New project", description: "Header action; opens the inline create form" },
  { tab: 'projects', tabLabel: 'Projects', label: "Preview brief / Hide brief", description: "Project card action; loads the task brief" },
  { tab: 'voice', tabLabel: 'Voice', label: "Symon settings", description: "History, polish, dictionary, voice persona \u2014 double-tap Symon, or open here" },
  { tab: 'voice', tabLabel: 'Voice', group: "Dictation", label: "Mic input", description: "How the mic button next to Send behaves (Tap/Hold)" },
  { tab: 'voice', tabLabel: 'Voice', group: "Dictation", label: "On-screen partials bar", description: "Show the live transcript in a bar at the bottom while you hold Fn" },
  { tab: 'voice', tabLabel: 'Voice', group: "Permissions", label: "Accessibility", description: "Lets o8 see the focused window so dictation lands in the right app" },
  { tab: 'voice', tabLabel: 'Voice', group: "Permissions", label: "Fn key binding", description: "Press globe key to in Keyboard Settings \u2014 change only if Fn dictation misfires" },
  { tab: 'voice', tabLabel: 'Voice', group: "Permissions", label: "Input Monitoring", description: "Required for the Fn key to receive events \u2014 stricter than Accessibility" },
  { tab: 'voice', tabLabel: 'Voice', group: "Transcription", label: "Groq API key", description: "Free at console.groq.com/keys \u2014 paste it here (password input + Save/Remove)" },
  { tab: 'voice', tabLabel: 'Voice', group: "Voice brain", label: "Escalation", description: "When to hand a request to the deeper brain (Off/Auto/Deep)" },
  { tab: 'permissions', tabLabel: 'Permissions', group: "macOS permissions", label: "Microphone", description: "Grant mic access for dictation and Symon", keywords: ['permission', 'mic', 'tcc', 'privacy', 'grant', 'allow'] },
  { tab: 'permissions', tabLabel: 'Permissions', group: "macOS permissions", label: "Accessibility", description: "Lets o8 see the focused window so dictation lands in the right app", keywords: ['permission', 'tcc', 'privacy', 'grant', 'allow'] },
  { tab: 'permissions', tabLabel: 'Permissions', group: "macOS permissions", label: "Input Monitoring", description: "Required for the global Fn hotkey to receive key events", keywords: ['permission', 'tcc', 'privacy', 'grant', 'allow', 'fn', 'hotkey'] },
  { tab: 'permissions', tabLabel: 'Permissions', group: "macOS permissions", label: "Screen Recording", description: "Powers Symon's screen sight — reading what's on screen to point and guide", keywords: ['permission', 'tcc', 'privacy', 'grant', 'allow', 'capture'] },
];
