# Verification

Python tests execute native message framing, fragmented reads, host-origin validation, installer launch, request expiry, profile isolation, tab ownership, stale targets, duplicate request IDs, and recovery. The real-host subprocess regression holds an action past its caller timeout, queues another write, and returns a late failure: the first stays unknown and the second never reaches the browser.

Node tests exercise the service worker with mocked Chromium APIs: explicit tab IDs, identical URLs, current-tab selection, scoped navigation/closing, private/internal pages, platform modifiers, expiry, and disconnect during debugger attachment.

`tests/e2e.py` loads the actual extension into a fresh headless profile, clicks Connect, and calls the real native host through SQLite. Its 13 checks cover startup, profile identity, separate agent-owned tabs at one URL, ownership rejection, replacement typing, trusted clicks, preservation of the other tab, file upload, screenshots, reconnect identity, target resumption, recovery reporting, and closed-tab behavior.

This suite passed in Playwright Chromium and Brave's Chromium engine on macOS using synthetic local pages. It does not verify Google authentication, Colab execution, arbitrary web editors, extension-store review, or other operating systems.

```bash
python3 -m unittest discover -s tests -v
node --test tests/background.test.cjs
python3 -m pip install playwright==1.58.0
python3 -m playwright install chromium
python3 tests/e2e.py --output /tmp/browser-bridge-evidence
```

Pass `--executable /path/to/a/chromium/browser` to test another installed engine in a temporary headless profile. Results include a synthetic-page screenshot and results.json. Test host names are unique; cleanup removes only those test registrations.
