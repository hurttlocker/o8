# o8 Benchmark Scorecard

Version: 0.1.716
Git SHA: cee70ae21
Timestamp: 2026-08-27T10:01:16.121Z
Node: v22.23.2
Prior: scorecard-0.1.652-7a1931a46.json
Governance scope: This benchmark measures the AI review tier. It does not measure the human approval gate above it.

## Speed
| Metric | Value | N | Prior | Direction | Delta |
| --- | ---: | ---: | ---: | --- | --- |
| time_to_splash_ms | 74.7 | - | null | lower-better | baseline |
| time_to_reveal_ms | 7208.7 | - | null | lower-better | baseline |
| boot_api_request_count | 41 | - | null | lower-better | baseline |
| max_client_queue_stall_ms | 4360.6 | - | null | lower-better | baseline |
| panel_branches_ms | 9.2 | - | null | lower-better | baseline |
| runtime_inventory_ms | 23.4 | - | null | lower-better | baseline |
| dashboard_cold_ttfb_ms | 8 | - | 16 | lower-better | unchanged |
| dashboard_warm_ttfb_ms | 15 | - | 11 | lower-better | unchanged |
| bootstrap_warm_total_ms | 2 | - | 22 | lower-better | unchanged |
| cli_status_median_ms | 336 | - | 353 | lower-better | unchanged |
| mcp_client_minus_server_p50_ms | 4 | - | null | lower-better | baseline |
| socket_avg_conns | 9.37 | - | 5.87 | informational | informational |

## Memory
| Metric | Value | N | Prior | Direction | Delta |
| --- | ---: | ---: | ---: | --- | --- |
| overall_full_accuracy | 0.313 | - | 0.313 | higher-better | unchanged |
| delta_full_vs_strongGrep | 0.232 | - | 0.232 | higher-better | unchanged |
| ownership_full_accuracy | 0.51 | - | 0.51 | higher-better | unchanged |
| decisions_full_accuracy | 0.47 | - | 0.47 | higher-better | unchanged |
| processes_full_accuracy | 0.74 | - | 0.74 | higher-better | unchanged |
| incidents_full_accuracy | 0.2 | - | 0.2 | higher-better | unchanged |
| specs_full_accuracy | 0.07 | - | 0.07 | higher-better | unchanged |
| cross-repo_full_accuracy | 0.39 | - | 0.39 | higher-better | unchanged |
| literal-lookup_full_accuracy | 0 | - | 0 | higher-better | unchanged |

## Governance
| Metric | Value | N | Prior | Direction | Delta |
| --- | ---: | ---: | ---: | --- | --- |
| catch_rate | 0 | 0/10 | 1 | higher-better | regressed |
| clean_diffs_blocked | 0 | 0/10 | 0 | lower-better | unchanged |
| clean_diffs_with_any_finding | 0 | 0/10 | 0.2 | lower-better | improved |

## Coding
| Metric | Value | N | Prior | Direction | Delta |
| --- | ---: | ---: | ---: | --- | --- |
| decisive_contract_wins | 3 | 3/6 | 0 | higher-better | improved |
| contract_excellent_outputs | 0 | 0/6 | 0 | higher-better | unchanged |
