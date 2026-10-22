# Verification

Python tests cover native framing, origin validation, installer launch, request expiry, ownership, recovery, duplicate IDs and late errors. Node service-worker tests cover exact tab targeting, default deny, missing/revoked grants, hidden metadata, approval binding, expiry/disconnect, policy changes, redirect approval, protected link/form targets, trailing-dot hostnames, injected deadlines, and disabled raw commands.

The actual extension/native-host E2E runs isolated headless Chromium or Brave against synthetic localhost pages. It tests settings, default deny, separate agents/tabs, fixed read/type/click/upload, approval/denial, sensitive card-form rejection, destination checks, reconnect and recovery. Renderer exceptions are returned through explicit success/error envelopes. No screenshots are taken. Layout geometry, text size, overflow and task routes are measured at 1440×900 and 390×844 with 0, 4 and 200 saved sites.

**Consent-dialog limit:** headless automation cannot click Chromium’s browser-native optional-host permission dialog. Only the temporary copied test manifest is seeded with `http://127.0.0.1/*` and `https://www.google.com/*`; production has no required host grant. The real settings still calls permissions.request from the Add user gesture, but accepting/declining a newly requested browser-native grant remains a manual smoke check. Tests never use personal profiles or accounts.

Google authentication, Docs/Slides editors, Colab execution, extension-store review, and other operating systems remain unverified. DOM events are not equivalent to trusted debugger input. Screenshots/keys/eval/CDP are deliberately disabled in production and the integration suite takes no screenshots.

```bash
python3 -m unittest discover -s tests -v
node --test tests/*.test.cjs
python3 -m pip install playwright==1.58.0
python3 -m playwright install chromium
npm ci --ignore-scripts --no-audit --no-fund
python3 tests/e2e.py --output /tmp/browser-bridge-evidence
```

Use `--executable /path/to/chromium/browser` for another engine. Test native-host names are unique and removed afterward. Manual smoke: open Site permissions; save an exact HTTPS origin; accept/decline the browser prompt; inspect that rule; choose Ask and approve/deny one command; choose Block and confirm the site grant is removed.

Version0.3.1 adds actual popup-to-settings clicking, stale-manifest gating (without options_ui), persistent UI error tests and native fatal-error privacy checks. Native/Python tests verify expired IPC cleanup, old journal-detail redaction and missing secret markers in the SQLite file; this does not simulate OS backups or guarantee forensic erasure. The native installer’s supported/tested platform remains macOS.

Version 0.4 tests real local policy migration/write/watch, two native hosts sharing one file, stale revision conflicts, malformed/oversize/duplicate-key policies, protected origins, owner-only writes and symlink rejection. Browser flows cover common-site add, Remove/Undo, missing-consent controls, import preview/apply/export, background focus preservation, long text pagination, scoped values/HTML, ARIA menu items, pointer event order, open shadow roots, same-origin frames, nested scrolling, contenteditable and the pinned Monaco 0.52.2 editor model. Monaco is a development fixture fetched by `npm ci`; it is not shipped or loaded by the extension. Tests cannot prove every production website, operating system, editor or browser-native consent dialog works.

Latest local verification (2026-10-22, v0.4.0): **27 Python,35 Node,78 Chromium E2E,78 Brave E2E — all passed** before commit. Browser suites include the mobile Policy file link followed by continued settings actions; independent Node tests exercise revocation during asynchronous preference/policy loads. No screenshots were created.

Synthetic integration callers allow45seconds per command on shared CI runners and print per-check progress. This does not change the CLI's production default deadline or replay timed-out actions.

Background input uses DOM setters/range replacement and InputEvents, without document.execCommand or foreground activation. Integration checks independently inspect the real Monaco model and verify the active browser tab/window remain unchanged after editing.

Cursor checks record insertion properties with a synthetic-page MutationObserver rather than depending on the indicator remaining visible after slower bridge reads.

Settings concurrency tests execute the real send/task/refresh functions with delayed prior polls and delayed browser consent, verifying that edits retain the original UI revision. Import preview revisions remain fixed even while the shared file updates; real browser tests reject a stale preview and preserve its intervening Block.
