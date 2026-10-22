# Mehtagent Browser Bridge

Let your agent work in the browser profile you already use. Open a tab, read a page, click, type, upload a file, and take screenshots through a local Chromium extension. Chrome and Brave use the same extension and native host.

Each profile has a persistent connection ID. Each agent reserves its own tabs. A recovery journal survives agent exits and browser reconnects, and uncertain actions are never replayed automatically.

The native-host installer currently supports **macOS with Python 3.9+**. The extension requires Chromium 118 or newer. Browser integration was tested in isolated headless Chromium and Brave against synthetic local pages; this does not establish that every website works.

## Install

Ask your agent to read [AGENTS.md](AGENTS.md), or run:

```bash
git clone https://github.com/SwapneelM/mehtagent-browser-bridge.git
cd mehtagent-browser-bridge
python3 install.py
```

Then, in the **browser profile you want the agent to use**:

1. Open `chrome://extensions` in Chrome or `brave://extensions` in Brave.
2. Enable **Developer mode**, click **Load unpacked**, and select this repository's `extension` folder.
3. Open **Local Browser Bridge** from the extensions menu, optionally pin it, and click **Connect**. The badge shows **ON** when the native host is ready.

The browser extension must be loaded manually. Installing the agent plugin does not grant browser access by itself. The Chrome Web Store release is pending; use this repository or the [release download](https://github.com/SwapneelM/mehtagent-browser-bridge/releases/latest).

Keep the extension folder in place. To update, pull this repository, rerun `python3 install.py`, reload the extension, and click Connect. Its ID stays the same; a second installation is unnecessary. An extension reload invalidates old tab targets, so list and reserve the intended tabs again afterward.

## Give each agent its own tabs

```bash
python3 browser.py status
python3 browser.py --connection BROWSER_ID tabs
python3 browser.py --connection BROWSER_ID current
python3 browser.py --connection BROWSER_ID --agent TASK_ID open https://example.com/
```

Replace `BROWSER_ID` with a `b_…` ID from status. Choose a unique, stable `TASK_ID` for this agent's task and save both IDs in your task notes. Multiple profiles are never selected by browser preference or guessed from the URL.

`open` always creates a new tab and returns its numeric browser ID plus an owned `t_…` target. To reserve an existing tab:

```bash
python3 browser.py --connection BROWSER_ID --agent TASK_ID claim 123
```

Use the returned **target ID** for page actions:

```bash
python3 browser.py --agent TASK_ID read TARGET_ID
python3 browser.py --agent TASK_ID activate TARGET_ID
python3 browser.py --agent TASK_ID navigate TARGET_ID https://example.org/
python3 browser.py --agent TASK_ID type TARGET_ID '#query' 'image search'
python3 browser.py --agent TASK_ID click TARGET_ID '#submit'
python3 browser.py --agent TASK_ID key TARGET_ID Enter
python3 browser.py --agent TASK_ID scroll TARGET_ID 600
python3 browser.py --agent TASK_ID screenshot TARGET_ID /tmp/page.png --full-page
python3 browser.py --agent TASK_ID upload TARGET_ID 'input[type=file]' ./report.pdf
python3 browser.py --agent TASK_ID eval TARGET_ID 'document.title'
python3 browser.py --agent TASK_ID cdp TARGET_ID Accessibility.getFullAXTree
python3 browser.py --agent TASK_ID release TARGET_ID
```

Two tabs with identical URLs retain separate ownership targets. Missing or closed tabs produce errors instead of selecting another page. `current` uses the active tab in the focused window of the chosen profile and fails when that profile has no focused window.

Reservations last 15 minutes and are renewed by actions. An interrupted agent can resume its expired reservation if another agent has not claimed it. Another agent can claim an expired reservation, invalidating the previous target ID. Agents cannot claim a tab while its reservation is active. Different profiles have different connection IDs even if tab numbers match.

## Resume after an interruption

Use the same agent/task ID:

```bash
python3 browser.py --agent TASK_ID recover
```

Recovery lists owned targets and recent operation IDs and outcomes. A native-host reconnect preserves profile and target identity. A browser restart or extension reload changes its runtime epoch: old targets fail and must be reserved again from the current tab list.

An operation can be `completed`, `failed`, `cancelled`, or `unknown`. Unknown means the browser may have performed some or all of the action. Read the page or take a screenshot, then record what you found:

```bash
python3 browser.py --agent TASK_ID read TARGET_ID
python3 browser.py --agent TASK_ID resolve OPERATION_ID completed
# Only after checking that the action did not happen:
python3 browser.py --agent TASK_ID resolve OPERATION_ID not-run
```

Further writes to that tab are blocked while an unknown action remains unresolved. Pending commands are not dispatched behind an in-flight action. Late failures do not erase uncertain outcomes. Use `--request-id UNIQUE_ID` for retries managed by the caller. An ID already in the journal never executes twice. There is no exactly-once guarantee across a browser failure, so uncertain outcomes require inspection.

## Page controls

`read` returns page text, visible interactive elements with CSS selectors, and iframe URLs. Click and type require exactly one visible match and reject covered targets. `type` replaces contents; `--append` preserves them. Keyboard modifier bits: Alt=1, Ctrl=2, Meta/Command=4, Shift=8. Replacement typing uses the operating system's appropriate modifier.

Text and selectors describe the top document. Embedded editors and cross-origin frames may need `cdp` with explicit execution contexts or child sessions. Browser internal pages, extension pages, and private browsing are excluded. Sign-in and consent can still need your interaction.

## Local access and storage

Connect grants your local agent broad control of this profile's non-private website tabs, including signed-in pages and uploads. The browser displays its debugging indicator on instrumented tabs. **Disconnect** stops new commands and releases debugging; an action already dispatched may still finish. Connections do not start automatically when the browser restarts.

The browser starts Python over native messaging stdin/stdout. There is no listening HTTP port, cloud service, or webpage message endpoint. The manifest allows this extension's fixed ID. Other processes running as your OS user can access the bridge; ownership coordinates trusted agents and is not a boundary against local malware.

On macOS, runtime and persistent state live under `~/Library/Application Support/LocalBrowserBridge/`. The SQLite journal records only operation metadata, ownership, and outcomes. Temporary payloads are removed after completion, timeout, or expiry. Screenshots are saved to the requested path. Your agent's own tool logs are outside the extension's control.

Chrome and Brave both look for the native-host manifest under `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`. Runtime files live outside Documents because macOS can deny browser-launched helpers access there. Startup errors go to `~/Library/Application Support/LocalBrowserBridge/native-host.log`. A sandboxed assistant needs filesystem access to the state directory; the local bridge itself needs no network connection.

## Agent plugins

The repository includes a Claude-compatible plugin in `.claude-plugin/` with a browser skill and command. Other agents can read [AGENTS.md](AGENTS.md) and use the same CLI. Mehtagent's required-plugin registration links users to these manual installation steps. Browser access remains disconnected until the user loads the extension and clicks Connect.

## Checks

```bash
python3 -m unittest discover -s tests -v
node --test tests/background.test.cjs
python3 -m pip install playwright==1.58.0
python3 -m playwright install chromium
python3 tests/e2e.py --output /tmp/browser-bridge-evidence
```

The last command runs the actual extension and native host in isolated headless profiles against synthetic localhost pages. Each test registers a host with a random name and removes that registration afterward. It does not use your browser profile or accounts. The checks and their limits are documented in [TESTING.md](TESTING.md).

## Remove

Disconnect, remove **Local Browser Bridge** from each browser, and remove `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.mehtagent.browser_bridge.json`. You can then remove this checkout and `~/Library/Application Support/LocalBrowserBridge/`, including its recovery journal.
