# QA eval ground-truth rebuild, 2026-08-02

Issue #1681 found that the June answer key no longer described the current repository. This rebuild derived every expected answer from the current tree, git history, `~/.o8/directives`, or `~/.o8/cortex-ide.db`; no Brain answer surface was used.

| Case | Classification | Old subject | New subject | Why |
|---|---|---|---|---|
| qa-001 | repaired | cortex-ide directive scopes | o8 seeded directive scopes | Repo names changed; the six repo and two global seeds still exist. |
| qa-002 | repaired | two-repo project membership | nine-repo project membership | The o8 project now contains nine registered repos. |
| qa-003 | replaced | missing recent PR authors | project main-repo ownership | The null ingestion gap was not a stable ownership question. |
| qa-004 | replaced | recent outcome runtime mix | backend and runtime directory ownership | Recent rows drift; the current ownership boundary is explicit in the tree. |
| qa-005 | repaired | packet-control directive under cortex-ide | same directive under repoName o8 | The directive survived the rename and its repoName changed. |
| qa-006 | repaired | cortex-ide inline-style rationale | o8 inline-style rationale | The decision remains current under the o8 name. |
| qa-007 | valid | raw-SVG icon rationale | unchanged | The directive and all expected details still exist. |
| qa-008 | replaced | pre-hybrid no-vector decision | current memory precedence and provenance rules | The old architecture claim no longer describes the hybrid retrieval tree. |
| qa-009 | repaired | cortex-ide versus site deployment | o8 desktop versus site deployment | The product name changed; the native/web boundary remains. |
| qa-010 | replaced | stale model routing | declarative versus specialized runtime decision | Model assignments drifted; the adapter decision is current and source-backed. |
| qa-011 | valid | pre-commit typecheck | unchanged | The command remains the mandatory completion gate. |
| qa-012 | repaired | two file-ceiling waivers | four current waivers | Two additional mechanical waivers are now documented. |
| qa-013 | valid | surgical-changes rule | unchanged | The global directive remains current. |
| qa-014 | repaired | release loop and UpdateBanner | current release loop and UpdateCard | The command sequence remains, but the updater surface name changed. |
| qa-015 | replaced | gated API prefixes | default-deny decision ladder | The prefix model was removed in favor of explicit default-deny policy. |
| qa-016 | repaired | deleted branch narrative | preserved glass-collapse incident | The failure remains documented, but the rewritten branch history is not required. |
| qa-017 | valid | partial packet-meta row restyle | unchanged | The cited session outcome row still contains the expected facts. |
| qa-018 | valid | off-brand empty-state copy | unchanged | The cited session outcome row still contains the reviewer finding. |
| qa-019 | valid | failed first webview-tool attempts | unchanged | Both cited failure rows still exist. |
| qa-020 | replaced | missing rgba post-mortem commit | WKWebView idle-callback crash | The old SHA disappeared in rewritten history; a comparable sourced incident exists. |
| qa-021 | replaced | planned schema-v14 FTS tables | current Cortex evidence inputs | The planned schema question was stale; the current memory spec is authoritative. |
| qa-022 | replaced | stale Q&A latency budgets | fleet status vocabulary | The old budgets are absent; the current fleet specification is comparable. |
| qa-023 | replaced | stale Q&A cache key | native-browser surface contract | The old cache contract changed; the current architecture spec is explicit. |
| qa-024 | replaced | stale Q&A output modes | current managed-worktree root | The old modes are gone; the superseding worktree decision is documented. |
| qa-025 | repaired | obsolete 30-case regression gate | current validator and judge contract | The suite now has 38 cases and repo-path validation. |
| qa-026 | valid | site invariants inherited from desktop | unchanged | The ingested site specification still lists the same four invariants. |
| qa-027 | repaired | cortex-ide deployment wording | o8 deployment wording | The native/web split remains, under the current repo name. |
| qa-028 | repaired | shared Plus Jakarta Sans premise | current site/desktop font divergence | Desktop reverted to the system stack while the site retained the webfont. |
| qa-029 | repaired | null site-outcome gap | point-in-time count of 9 | The SQLite substrate now contains nine o8-site outcomes. |
| qa-030 | repaired | CLAUDE.md as o8 equivalent | current AGENTS.md plus CLAUDE.md roles | o8 now has its own AGENTS.md execution guide. |
| qa-031 | repaired | removed 3001/3002 port ranges | current production port ranges | The Tauri constants now use the 47100 production blocks. |
| qa-032 | valid | IPC route map | unchanged | All five paths and commands still match the source table. |
| qa-033 | replaced | indirect model constant | development port blocks | The old constant is now an alias, so it no longer exposes a literal string. |
| qa-034 | replaced | removed model constant | transcript bootstrap defaults | The old constant no longer exists; the replacement has direct literals. |
| qa-035 | repaired | backpressure constants in ws-server.ts | constants in extracted channels.ts | Values are unchanged, but ownership moved to the extracted module. |
| qa-036 | repaired | DB schema version 27 | DB schema version 36 | Nine migrations landed after the June key. |
| qa-037 | repaired | socket template in client constructor | socket resolver helper | Socket resolution moved to a dedicated module and gained an env override. |
| qa-038 | valid | tile layout version 4 | unchanged | The source still pins version 4. |

Totals: **9 valid, 17 repaired, 12 replaced, 0 retired**. Category counts remain ownership 5, decisions 5, processes 5, incidents 5, specs 5, cross-repo 5, and literal-lookup 8.
