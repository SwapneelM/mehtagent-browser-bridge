# Implementation and verification

## 2026-10-21: initial public version 0.2.0

The extension attaches to the browser profile where the user manually loads it and clicks Connect. Chrome and Brave share its Chromium APIs and macOS native-host registration. Runtime code is copied into Application Support so browser-launched helpers need no access to the checkout under Documents.

Persistent profile IDs, runtime epochs, agent-owned tab targets, and a SQLite journal support interrupted agents. Expired ownership can be reassigned, invalidating the old target. Native-host dispatch waits for the previous browser response and rechecks uncertain outcomes before further writes. Browser-side mutation failures remain unknown until inspected. Duplicate caller operation IDs do not execute twice.

Validation: 15 Python tests and 9 Node tests passed. The real extension/native-host suite passed 13 checks in Playwright Chromium and another 13 in the installed Brave Chromium engine, using isolated headless profiles and synthetic localhost pages. An independent read-only review reproduced partial-action failures, queued-write races, and late-error uncertainty loss; fixes and a real-host regression test now cover those cases. Authenticated websites and Colab execution are outside this evidence.

## References consulted

| Source | Verified | Use |
|---|---|---|
| [Chromium native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging) | 2026-10-21 | Framing, host manifests, origin allowlist, and local launch. |
| [Chromium debugger API](https://developer.chrome.com/docs/extensions/reference/api/debugger) | 2026-10-21 | Tab-scoped page instrumentation and DevTools transport. |
| [Brave native-host lookup](https://github.com/brave/brave-core/blob/master/app/brave_main_delegate.cc) | 2026-10-21 | Chrome's native-host registration location on macOS. |
| [Playwright extension tests](https://playwright.dev/python/docs/chrome-extensions) | 2026-10-21 | Headless Chromium with an isolated persistent test profile. |

The shipped tests include the timeout/late-error/queued-write regression and the actual extension/native-host E2E runner. Both suites and the public-source scan passed before the initial release commits.

## 2026-10-21: version 0.3.0, explicit site grants

Larger rendered text (18px body,16px supporting copy,28px heading) and a full Site permissions page replace the small popup-only controls. Exact origins start blocked and require user-initiated Chromium grants. Allow, Ask every command, and Block rules persist locally. Each approval is tied to the command, agent, tab, source/destination and deadline, and is never reused.

The production manifest removes debugger, tabs, and activeTab. Fixed isolated-world scripts access only the top document of granted hosts. Raw eval/CDP, trusted keys and screenshots are disabled; DOM editors can require manual input. Upload payloads are bounded to500KB. Protected host/path and card/password form checks add defense but cannot classify every sensitive workflow. Page access is not a website network firewall.

Files: extension/policy.js (validation); extension/options.html and options.js (user grants/rules); extension/approval.js (full-command approval display); extension/background.js (fixed commands, gates, expiry and navigation checks); manifest/popup files (reduced permissions and typography); browser.py (bounded uploads); native_host.py (trusted pre-execution-denial outcome); tests and agent/plugin docs updated together.

Validation: Python15 and Node20 pass. Real extension/native-host E2E35 checks pass in Playwright Chromium and another35 in Brave, in isolated synthetic localhost profiles. Checks include actual DOM form overrides, nested submit targets, external form associations, rejection of card-form reads, approval isolation, rendered18px text and390px layout. An independent review reproduced nine gaps; fixes and regression checks cover them, with no remaining demonstrated blocker.

The native optional-host consent dialog remains a manual smoke check: the headless test copy alone receives a required127.0.0.1 grant. Production starts with no site grants. Signed-in Google editors and Colab execution remain unverified. Earlier0.2 debugger/screenshot evidence is historical and does not describe0.3 capabilities.

Design mechanics referenced: dribbble-27507082-risk-tag-as-segment-strip (aligned rows), mkdocs-sortable-data-table (contained scrolling), mkdocs-clamped-tooltip (viewport-bound details). Private design/read/review artifacts remain outside this public repository.

Primary references verified2026-10-21: [Chromium extension security FAQ](https://chromium.googlesource.com/chromium/src/+/main/extensions/docs/security_faq.md) (debugger can sidestep host restrictions), [optional permissions](https://developer.chrome.com/docs/extensions/reference/api/permissions), [fixed scripting and host grants](https://developer.chrome.com/docs/extensions/reference/api/scripting), [tabs metadata permissions](https://developer.chrome.com/docs/extensions/reference/api/tabs).

##2026-10-22:0.3.1 settings, stale manifest and privacy

Site permissions now opens a direct extension tab and reports failures instead of losing them to polling. Stale manifests without scripting/optional-host permissions disable Connect/siteSave with Reload guidance; Disconnect remains available. Actualclickandoldmanifest cases added to E2E; popup handler tests added. CI now runs all Node test files.

SQLite secure_delete is enabled, expired IPC rows are removed on next access with uncertain outcomes preserved, legacy raw journal errors are redacted, and future failures retain fixed codes only. Main and worker fatal Python errors emit type codes; dispatcher failure closes the process rather than leaving an inert native connection. Tests reproduce malformed-frame and SQLite-worker failures without tracebacks, and confirm a synthetic secret marker is absent from the database after cleanup. This is not a forensic-erasure or zero-storage guarantee; IPC data, tool results, OS backups and external agent logs remain outside that claim.

Portability audit: public tracked source has no personal home paths; extension uses generic Chromium APIs. Native installer still explicitly supports macOS only. Linux/Windows installers and real authenticated Colab/editor behavior are not claimed verified.

Validation before commit:18Python24Node tests pass. Realextension suite38checks passed in Chromium and Brave forpopupchanges; finalprivacyChromium38passed beforeworker-error sanitizer, finalBrave rerun follows worker fix. Only synthetic pages/testprofiles are in browser evidence.

Files: extension/popup.js/options.js/manifest.json; bridge.py/native_host.py; tests/popup.test.cjs/test_bridge.py/e2e.py; .github/workflows/checks.yml; README.md/TESTING.md/FILEMAP.md/pluginversion. Scoped independent review addresses worker traceback gap; no private page data or course datasets are published in this bridge repo.

FinalBrave38checks passed after worker-error sanitizer; independent review reproduces type-only fatal worker exit. Private task logs remain outside this public repository.

## 2026-10-22 — v0.4 shared policy and background DOM actions

Added a shared versioned local JSON policy with strict validation, private atomic writes, revision conflicts, external change watching and one-time migration of existing extension rules. Browser consent remains separate; file edits never grant new hosts. Added common-site buttons, access controls, Remove/Undo, policy import preview/export and missing-consent actions.

New tabs open in the background by default. Fixed commands support scoped/paginated DOM text, sanitized HTML, DOM/ARIA names, pointer events, open shadow roots, same-origin frames, nested scroll and a pinned-fixture-tested Monaco textarea adapter. Optional virtual cursor labels the agent/action without focus, OS pointer movement or screenshots. Existing exact-origin denial, protected pages, agent ownership and recovery behavior remain enforced.

Verification before commit:27 Python tests,31 Node tests,75 actual extension/native-host checks each in isolated headless Chromium and Brave. Includes0/4/200site settings layouts, import/export, invalid policy failure/recovery, focus preservation, DOM/editor actions and cursor preference. Independent review found two revocation races; fixed before action dispatch and covered by actual asynchronous harness tests. Settings hash navigation is authorized without accepting website senders. git diff --check clean; private path/session/course-ID marker scan clean. No screenshots generated or retained by the suite.

Limits: browser-native new-host prompt acceptance/decline remains manual; headless tests pregrant only copied fixture hosts. Monaco fixture success is not a guarantee for signed-in Google editors. Native installer support remains macOS; other OS installation is unverified. Agent/tool/OS logs remain outside the bridge's control.

CI follow-up: the first remote run timed out on a background contenteditable command at the test harness's15s deadline; both local75-check suites had passed. Increased only the synthetic CI caller deadline to45s (no automatic action replay), added per-check progress and editable-state diagnostics. At that initial timeout-only checkpoint, production command defaults and action code were unchanged; the subsequent DOM input change is recorded below.

Background input follow-up: removed document.execCommand from both plain contenteditable and Monaco insertion. Contenteditable now updates its scoped text and dispatches InputEvent; the Monaco adapter uses textarea.setRangeText plus InputEvent. An isolated pre-patch probe confirmed actual Monaco model replacement from this DOM protocol. E2E asserts model replacement/append and active-tab/window preservation after editor actions.

Final DOM-input build verified before follow-up commit:31 Node tests pass;76 full browser checks each in local isolated Chromium and Brave, including both actual Monaco model assertions and post-edit focus preservation. Python/native code remains unchanged from the27-test passing build.
