# File map

| Path | Updated | Status | Contents |
|---|---|---|---|
| README.md | 2026-10-21 | current | Installation, ownership, recovery, controls, storage, and removal. |
| AGENTS.md | 2026-10-21 | current | Agent setup, target selection, interruption recovery, and development rules. |
| bridge.py | 2026-10-21 | current | Persistent local state, connection identity, ownership leases, and recovery journal. |
| browser.py | 2026-10-21 | current | CLI and request API with explicit agents, targets, and operation IDs. |
| native_host.py | 2026-10-21 | current | Browser-launched transport with origin checks and serialized dispatch. |
| install.py | 2026-10-21 | current | Native host registration and runtime installation outside Documents. |
| extension/ | 2026-10-21 | current | Chromium service worker, fixed commands, exact-host policy, larger popup and permissions page. |
| tests/ | 2026-10-21 | current | Python, Node, and actual extension/native-host integration tests. |
| .claude-plugin/, commands/, skills/ | 2026-10-21 | current | Agent plugin metadata, command, and browser skill. |
| .github/workflows/checks.yml | 2026-10-21 | current | macOS CI running the same unit and browser checks. |
| TESTING.md | 2026-10-21 | current | Validation scope, reproducible commands, and untested surfaces. |
| LEDGER.md | 2026-10-21 | current | Public implementation and validation evidence. |
| LICENSE | 2026-10-21 | current | MIT license. |

| extension/policy.js | 2026-10-21 | current | Exact-origin validation, default-deny modes, protected host/path checks. |
| extension/options.html, extension/options.js | 2026-10-21 | current | User-initiated optional host grants and rule editing. |
| extension/approval.js | 2026-10-21 | current | Full-command review and one-command approve/deny UI. |

| tests/popup.test.cjs |2026-10-22|current| Actual popup handler checks for settings opening, visible errors and stale manifests. |

| policy_store.py |2026-10-22|current| Shared JSON validation, per-user paths, private atomic writes and revision conflict checks. |
| browser-policy.schema.json, browser-policy.example.json |2026-10-22|current| Versioned policy contract and optional generic starter choices. |
| extension/options.css |2026-10-22|current| Larger settings controls, contained site list and mobile policy route. |
| extension/protected-hosts.json |2026-10-22|current| Native policy validation host list, checked against the browser policy list. |
| tests/test_policy_store.py, tests/test_policy_native.py |2026-10-22|current| Policy validation, concurrency, migration, native sharing and invalid-file regressions. |
| package.json, package-lock.json |2026-10-22|current| Pinned official Monaco development fixture; no extension runtime dependency. |
