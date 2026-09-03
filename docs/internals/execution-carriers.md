# Execution carriers

An execution carrier is an allowlisted argv and credential wrapper around an existing worker runtime. It is not a runtime adapter. The runtime still owns capabilities, session identity, transcript parsing, cost attribution, review, resume, and cleanup.

The first supported pair is Ori with Codex:

```text
runtime = codex, execution carrier = ori
codex exec --json ...
        becomes
ori codex exec --json ...
```

o8 constructs that command as an executable plus an argument array. It does not accept an operator-supplied shell string. Ori's `codex` subcommand comes from the closed carrier catalog, and the existing Codex adapter still produces every argument after it. The concrete Ori contract and installation provenance are documented by [OpenRouter's announcement](https://openrouter.ai/blog/announcements/ori-harness/) and its [official install skill](https://github.com/OpenRouterTeam/skills/blob/main/skills/install-ori-harness/SKILL.md). Do not install the unrelated npm package named `ori`.

On Windows, the selected carrier must resolve to a native `.exe` or `.com` executable. o8 refuses `.cmd` and `.bat` carrier shims because prompt argv would otherwise pass through `cmd.exe`. When `O8_CODEX_BIN` resolves Codex outside the inherited `PATH`, o8 prepends that executable's directory only for the carried child so Ori launches the same underlying CLI that passed preflight.

## Configure the carrier

Set the persisted operator default in `~/.o8/settings.toml`:

```toml
[models]
worker_execution_carrier = "ori"
```

Use an empty string to restore direct runtime launch. The same setting is available through `o8_operator_defaults` as `workerExecutionCarrier`; pass `"ori"` to enable it or `""` to clear it. Mission creation snapshots the resolved value onto every packet, so a later settings change cannot silently reroute a retry or resume.

Ori currently supports only Codex in o8. A mission that resolves any packet to an incompatible runtime is rejected before branch or worktree preparation.

## Identity and authentication precedence

| Concern | Owner when Ori is selected |
| --- | --- |
| Runtime and lane identity | Codex |
| Capability evidence | Codex adapter |
| Session key and resume protocol | Codex adapter |
| Transcript and cost parser | Codex adapter |
| Review and cleanup | Codex adapter |
| Credential path used to reach the provider | Ori |
| Launch display | `Codex via Ori` |

Carrier authentication takes precedence for the carried launch, including create-mission and one-step spawn preflight. Preflight runs `ori auth` with all output discarded and records only its boolean result, `authSource: execution-carrier`, binary identities, and resolution sources; it never stores a token, secret, or credential value. Selecting a carrier disables native-runtime auth gating for that launch, but it does not make the underlying CLI optional: both `ori` and `codex` must resolve. A macOS sandboxed worker receives read-only access to Ori's `~/.ori` state; the carrier credential tree is not writable.

A missing Ori binary is a `missing-carrier` failure with `O8_ORI_BIN` guidance. A missing Codex binary is a separate `missing-runtime` failure with `O8_CODEX_BIN` guidance. Neither case falls back to an unwrapped launch.

## Process ownership

The spawned root command is Ori, so the durable run records the resolved Ori executable path as its command identity, even when `sandbox-exec` wraps it. The Ori child inherits the owned-run marker and belongs to the same detached process tree or process group. Interrupt and orphan cleanup validate the exact wrapper path as an argv token, then stop the whole tree. All operator-facing lifecycle and review records continue to attribute that tree to Codex.

This design is the bounded follow-up to [issue #2034](https://github.com/hurttlocker/o8/issues/2034). It does not change the Copilot CLI or Crush runtime adapters landed there.
