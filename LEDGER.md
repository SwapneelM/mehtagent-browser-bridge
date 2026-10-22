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
