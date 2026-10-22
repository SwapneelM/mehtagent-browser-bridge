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
