# Verification

Python tests cover native framing, origin validation, installer launch, request expiry, ownership, recovery, duplicate IDs and late errors. Node service-worker tests cover exact tab targeting, default deny, missing/revoked grants, hidden metadata, approval binding, expiry/disconnect, policy changes, redirect approval, protected link/form targets, trailing-dot hostnames, injected deadlines, and disabled raw commands.

The actual extension/native-host E2E runs isolated headless Chromium or Brave against synthetic localhost pages. It tests settings, default deny, separate agents/tabs, fixed read/type/click/upload, approval/denial, sensitive card-form rejection, destination checks, reconnect and recovery. Renderer exceptions are returned through explicit success/error envelopes. UI screenshots include desktop and390px settings and approval details.

**Consent-dialog limit:** headless automation cannot click Chromium’s browser-native optional-host permission dialog. Only the temporary copied test manifest is seeded with `http://127.0.0.1/*`; production has no required host grant. The real settings still calls permissions.request from the Save user gesture, but accepting/declining a newly requested browser-native grant remains a manual smoke check. Tests never use personal profiles or accounts.

Google authentication, Docs/Slides editors, Colab execution, extension-store review, and other operating systems remain unverified. DOM events are not equivalent to trusted debugger input. Screenshots/keys/eval/CDP are deliberately disabled in production; test screenshots come from Playwright outside the bridge.

```bash
python3 -m unittest discover -s tests -v
node --test tests/background.test.cjs
python3 -m pip install playwright==1.58.0
python3 -m playwright install chromium
python3 tests/e2e.py --output /tmp/browser-bridge-evidence
```

Use `--executable /path/to/chromium/browser` for another engine. Test native-host names are unique and removed afterward. Manual smoke: open Site permissions; save an exact HTTPS origin; accept/decline the browser prompt; inspect that rule; choose Ask and approve/deny one command; choose Block and confirm the site grant is removed.
